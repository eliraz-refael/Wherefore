// No-Chrome smoke test for the bundled companion (dist/cli.js). It plays Chrome: starts
// `native-host` over pipes with Chrome's framing, answers the broker's calls as the extension's
// worker would, calls the broker over its socket (raw ndjson RPC, with and without its access
// token), then runs `mcp` and drives a whole tidy-up through it like an MCP client would (raw
// JSON-RPC over stdio). Runs against a temporary WHEREFORE_HOME, so nothing real is touched.
//
//   pnpm -C packages/companion build && pnpm -C packages/companion smoke
import { spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { connect } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli.js")
const ORIGIN = "chrome-extension://anpbbaiepneaddgoldgmapilgiflochg/"
const PROFILE = "smokesmokesmokesmokesmokes"
// A short directory: Unix socket paths are limited to about 100 bytes, and macOS's tmpdir is long.
const home = mkdtempSync(join(process.platform === "win32" ? tmpdir() : "/tmp", "wf-smoke-"))
const env = { ...process.env, WHEREFORE_HOME: home }
let failures = 0
let stderr = ""

const check = (ok, label) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${label}`)
  if (!ok) failures++
}

const frame = (message) => {
  const body = Buffer.from(JSON.stringify(message), "utf8")
  const header = Buffer.alloc(4)
  header.writeUInt32LE(body.length, 0)
  return Buffer.concat([header, body])
}

/** Calls `onMessage` for every frame on a readable stream. */
const readFrames = (stream, onMessage) => {
  let buffer = Buffer.alloc(0)
  stream.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const length = buffer.readUInt32LE(0)
      if (buffer.length < 4 + length) break
      onMessage(JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")))
      buffer = buffer.subarray(4 + length)
    }
  })
}

const until = async (condition, label, ms = 10_000) => {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > ms) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const timer = setTimeout(() => {
  console.log("FAIL timeout")
  process.exit(1)
}, 60_000)

try {
  // 1. Someone else's origin is refused, and nothing reaches stdout.
  const refused = spawnSync(process.execPath, [cli, "native-host", "chrome-extension://abcdefghijklmnopabcdefghijklmnop/"], { env, input: "" })
  check(refused.status === 1 && refused.stdout.length === 0, "a foreign caller is refused with an empty stdout")

  // 2. Chrome starts the host for our extension (the wrapper passes `native-host` first).
  const host = spawn(process.execPath, [cli, "native-host", ORIGIN, "--parent-window=0"], { env, stdio: ["pipe", "pipe", "pipe"] })
  host.stderr.on("data", (chunk) => (stderr += chunk))
  const fromHost = []
  const reply = (requestId, exit) => host.stdin.write(frame({ _tag: "FromWorker", rpc: { _tag: "Exit", requestId, exit } }))
  const runs = new Map()
  readFrames(host.stdout, (message) => {
    fromHost.push(message)
    if (message._tag !== "ToWorker") return
    const rpc = message.rpc
    // The fake worker: list tabs, store runs, keep leases open; leave read_pages hanging.
    if (rpc._tag === "Request" && rpc.tag === "list_tabs") {
      reply(rpc.id, {
        _tag: "Success",
        value: {
          tabs: [
            { id: 7, window: 1, index: 0, title: "Smoke", url: "https://example.com/" },
            { id: 8, window: 1, index: 1, title: "Sign in", url: "https://example.com/login" }
          ]
        }
      })
    } else if (rpc._tag === "Request" && rpc.tag === "open_run") {
      host.stdin.write(frame({ _tag: "FromWorker", rpc: { _tag: "Chunk", requestId: rpc.id, values: [{ _tag: "Opened" }] } }))
    } else if (rpc._tag === "Request" && rpc.tag === "update_run") {
      runs.set(rpc.payload.run.id, rpc.payload.run)
      reply(rpc.id, { _tag: "Success", value: null })
    } else if (rpc._tag === "Interrupt") {
      reply(rpc.requestId, { _tag: "Failure", cause: [{ _tag: "Interrupt" }] })
    }
  })
  const exited = new Promise((resolve) => host.on("exit", (code) => resolve(code)))

  host.stdin.write(frame({ _tag: "Hello", protocol: 1, profileId: PROFILE, extensionVersion: "1.2.3" }))
  await until(() => fromHost.some((message) => message._tag === "Welcome"), "Welcome")
  check(true, `Welcome: ${JSON.stringify(fromHost.find((message) => message._tag === "Welcome"))}`)

  const entryFile = join(home, "run", `${PROFILE}.json`)
  await until(() => existsSync(entryFile), "the registry entry")
  const entry = JSON.parse(readFileSync(entryFile, "utf8"))
  check(entry.profileId === PROFILE && entry.extensionVersion === "1.2.3", `registered: ${entry.socket}`)

  // 3. `status` finds the broker and asks it who it is.
  const status = spawnSync(process.execPath, [cli, "status"], { env, encoding: "utf8" })
  check(status.status === 0 && status.stdout.includes(PROFILE) && status.stdout.includes("extension 1.2.3"), "status lists the live broker")

  // 4. A socket client calls list_tabs through the broker; the "worker" answers.
  const client = connect({ path: entry.socket })
  const replies = []
  let pending = ""
  client.on("data", (chunk) => {
    pending += chunk
    let newline
    while ((newline = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, newline)
      pending = pending.slice(newline + 1)
      if (line.trim() !== "") replies.push(JSON.parse(line))
    }
  })
  await new Promise((resolve, reject) => client.once("connect", resolve).once("error", reject))
  const request = (id, tag, payload, token = entry.token) =>
    client.write(`${JSON.stringify({ _tag: "Request", id, tag, payload, headers: token === null ? [] : [["x-wherefore-token", token]] })}\n`)
  request("0", "list_tabs", {}, null)
  await until(() => replies.some((reply) => reply.requestId === "0"), "the refusal without a token")
  const refusedCall = replies.find((reply) => reply.requestId === "0")
  check(JSON.stringify(refusedCall.exit).includes("BrokerUnauthorized"), "a request without the broker's token is refused")
  check(typeof entry.token === "string" && entry.token.length >= 43, "the registry entry carries the access token")
  request("1", "list_tabs", {})
  await until(() => replies.some((reply) => reply.requestId === "1"), "the list_tabs reply")
  const listed = replies.find((reply) => reply.requestId === "1")
  check(listed._tag === "Exit" && listed.exit._tag === "Success" && listed.exit.value.tabs[0].id === 7, "list_tabs forwarded to the worker and back")

  // 5. MCP mode: `mcp` finds the broker in the registry and runs a tidy-up through it.
  const mcp = spawn(process.execPath, [cli, "mcp"], { env, stdio: ["pipe", "pipe", "pipe"] })
  mcp.stderr.on("data", (chunk) => (stderr += chunk))
  const mcpExited = new Promise((resolve) => mcp.on("exit", (code) => resolve(code)))
  const answers = new Map()
  let mcpBuffer = ""
  mcp.stdout.on("data", (chunk) => {
    mcpBuffer += chunk
    let newline
    while ((newline = mcpBuffer.indexOf("\n")) >= 0) {
      const line = mcpBuffer.slice(0, newline)
      mcpBuffer = mcpBuffer.slice(newline + 1)
      if (line.trim() !== "") {
        const message = JSON.parse(line)
        answers.set(message.id, message)
      }
    }
  })
  let nextId = 1
  const rpcCall = async (method, params = {}) => {
    const id = nextId++
    mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    await until(() => answers.has(id), method)
    return answers.get(id)
  }
  const initialized = await rpcCall("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } })
  check(initialized.result?.serverInfo?.name === "wherefore" && initialized.result.instructions.includes("list_tabs"), "mcp: initialize, with instructions")
  mcp.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`)
  const toolNames = (await rpcCall("tools/list")).result.tools.map((tool) => tool.name).join(",")
  check(toolNames === "list_tabs,read_pages,wake_and_read_pages,ask_user,submit_intentions", `mcp: tools ${toolNames}`)
  check((await rpcCall("prompts/list")).result.prompts.some((prompt) => prompt.name === "tidy_up"), "mcp: the tidy_up prompt")
  const tool = async (name, args = {}) => (await rpcCall("tools/call", { name, arguments: args })).result
  const listedTabs = (await tool("list_tabs")).structuredContent?.tabs ?? []
  check(listedTabs.length === 2 && listedTabs.every((tab) => tab.id !== 7 && tab.id !== 8), "mcp: list_tabs through the broker, with session ids")
  const [smokeTab, loginTab] = listedTabs.map((tab) => tab.id)
  const intention = (title, ids, kind) => ({ title, why: "w", kind, tab_ids: ids, confidence: "high", evidence: "e" })
  const rejected = await tool("submit_intentions", { intentions: [intention("Smoke", [smokeTab], "read")] })
  check(rejected.isError === true && JSON.stringify(rejected).includes("Missing tab ids"), "mcp: a submission missing a tab goes back to the model")
  const saved = await tool("submit_intentions", { intentions: [intention("Smoke", [smokeTab], "read"), intention("Login", [loginTab], "dead")] })
  check(saved.isError === false && saved.structuredContent.message.startsWith("Saved 2 groups"), "mcp: the full submission is saved")
  const [run] = [...runs.values()]
  check(
    runs.size === 1 && run.mode === "mcp" && run.agent === "smoke" && run.status === "succeeded" &&
      run.intentions.map((item) => item.tabIds).join("|") === "7|8",
    "mcp: the worker stored one mcp run, its result in Chrome's own tab ids"
  )
  mcp.stdin.end()
  const mcpCode = await mcpExited
  check(mcpCode === 0, `mcp: exits ${mcpCode} when the client closes stdin`)

  // 6. A call in flight when Chrome closes the port fails with ExtensionUnavailable, then the host cleans up.
  request("2", "read_pages", { tab_ids: [7] })
  await until(() => fromHost.some((message) => message.rpc?.tag === "read_pages"), "read_pages to reach the worker")
  check(fromHost.find((message) => message.rpc?.tag === "read_pages").rpc.payload.tab_ids[0] === 7, "read_pages keeps the model's wire form (tab_ids)")
  host.stdin.end()
  await until(() => replies.some((reply) => reply.requestId === "2"), "the read_pages failure")
  const failed = replies.find((reply) => reply.requestId === "2")
  check(failed.exit._tag === "Failure" && JSON.stringify(failed.exit).includes("ExtensionUnavailable"), "the call in flight failed with ExtensionUnavailable")
  const code = await exited
  check(code === 0, `the host exited with ${code}`)
  check(!existsSync(entryFile) && !existsSync(entry.socket), "the registry entry and socket are gone")
  client.destroy()

  // 7. A signal (Chrome sends SIGTERM when it gives up on a host) also cleans up. POSIX only:
  //    Windows terminates hosts outright, and the next broker or `status` prunes the entry.
  if (process.platform !== "win32") {
    const second = spawn(process.execPath, [cli, "native-host", ORIGIN], { env, stdio: ["pipe", "pipe", "pipe"] })
    second.stderr.on("data", (chunk) => (stderr += chunk))
    const secondExit = new Promise((resolve) => second.on("exit", (code, signal) => resolve(code ?? signal)))
    second.stdin.write(frame({ _tag: "Hello", protocol: 1, profileId: PROFILE, extensionVersion: "1.2.3" }))
    await until(() => existsSync(entryFile), "the second registry entry")
    const socket = JSON.parse(readFileSync(entryFile, "utf8")).socket
    second.kill("SIGTERM")
    const how = await secondExit
    check(!existsSync(entryFile) && !existsSync(socket), `SIGTERM cleans up too (exit ${how})`)
  }
} catch (error) {
  console.log(`FAIL ${error.message}`)
  failures++
} finally {
  if (failures > 0) console.log(`host stderr:\n${stderr}`)
  clearTimeout(timer)
  rmSync(home, { recursive: true, force: true })
}

console.log(failures === 0 ? "smoke passed" : `smoke failed (${failures})`)
process.exit(failures === 0 ? 0 : 1)

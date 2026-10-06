// No-Chrome smoke test for the bundled companion (dist/cli.js). It plays Chrome: starts
// `native-host` over pipes with Chrome's framing, answers the broker's calls as the extension's
// worker would, and calls the broker over its socket like an MCP server would (raw ndjson RPC).
// Runs against a temporary WHEREFORE_HOME, so nothing real is touched.
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
  readFrames(host.stdout, (message) => {
    fromHost.push(message)
    // The fake worker: answer list_tabs, leave read_pages hanging.
    if (message._tag === "ToWorker" && message.rpc._tag === "Request" && message.rpc.tag === "list_tabs") {
      host.stdin.write(frame({
        _tag: "FromWorker",
        rpc: {
          _tag: "Exit",
          requestId: message.rpc.id,
          exit: { _tag: "Success", value: { tabs: [{ id: 7, window: 1, index: 0, title: "Smoke", url: "https://example.com/" }] } }
        }
      }))
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
  const request = (id, tag, payload) => client.write(`${JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] })}\n`)
  request("1", "list_tabs", {})
  await until(() => replies.some((reply) => reply.requestId === "1"), "the list_tabs reply")
  const listed = replies.find((reply) => reply.requestId === "1")
  check(listed._tag === "Exit" && listed.exit._tag === "Success" && listed.exit.value.tabs[0].id === 7, "list_tabs forwarded to the worker and back")

  // 5. A call in flight when Chrome closes the port fails with ExtensionUnavailable, then the host cleans up.
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

  // 6. A signal (Chrome sends SIGTERM when it gives up on a host) also cleans up. POSIX only:
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

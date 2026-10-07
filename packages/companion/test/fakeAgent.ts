/**
 * A fake ACP agent for tests and the smoke script: a real process speaking ACP on stdio through
 * the SDK's agent side, as `claude-agent-acp` does. In its turn it starts the MCP server the
 * session gave it (`wherefore mcp --profile … --run …`) and calls Wherefore's tools over raw
 * JSON-RPC, like Claude Code would.
 *
 *   node fakeAgent.ts <scenario>
 *
 * Scenarios:
 * - `succeed`: list the tabs, submit one group per tab, end the turn (with usage and a cost).
 * - `ask`: like `succeed`, after one `ask_user` about the first tab.
 * - `forbidden`: ask permission for a shell command (expects a refusal) and for `list_tabs`
 *   (expects an allow), then like `succeed`.
 * - `hang`: start a child process (to check the tree is killed), list the tabs, then never end the
 *   turn, ignoring `session/cancel`.
 * - `crash`: list the tabs, then exit with code 3.
 * - `login`: refuse the session with ACP's `authRequired`.
 * - `nosubmit`: list the tabs and end the turn without submitting.
 *
 * With `FAKE_AGENT_LOG` set, it appends what it saw and did there, one JSON object per line (the
 * session's MCP servers and `_meta`, settings changes, permission outcomes, child pids, cancels).
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { appendFileSync } from "node:fs"
import { Readable, Writable } from "node:stream"
import { Acp } from "../src/unstable.ts"

const scenario = process.argv[2] ?? "succeed"
const logFile = process.env["FAKE_AGENT_LOG"]
const log = (entry: Record<string, unknown>) => {
  if (logFile !== undefined && logFile !== "") appendFileSync(logFile, `${JSON.stringify({ pid: process.pid, ...entry })}\n`)
}

/** A minimal MCP client over a child's stdio. */
class Mcp {
  private buffer = ""
  private nextId = 1
  private readonly waiting = new Map<number, (message: { result?: any; error?: unknown }) => void>()
  readonly child: ChildProcessWithoutNullStreams

  constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk
      let newline
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (line.trim() === "") continue
        const message = JSON.parse(line) as { id?: number; result?: unknown; error?: unknown }
        if (message.id !== undefined) this.waiting.get(message.id)?.(message)
      }
    })
    child.stderr.resume()
  }

  request(method: string, params: unknown = {}): Promise<any> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.waiting.set(id, (message) => {
        this.waiting.delete(id)
        if (message.error !== undefined) reject(new Error(JSON.stringify(message.error)))
        else resolve(message.result)
      })
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`)
    })
  }

  notify(method: string, params: unknown = {}) {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
  }

  async tool(name: string, args: unknown = {}): Promise<{ isError: boolean; structured: any; text: string }> {
    const result = await this.request("tools/call", { name, arguments: args })
    return {
      isError: result.isError === true,
      structured: result.structuredContent,
      text: (result.content ?? []).map((part: { text?: string }) => part.text ?? "").join("")
    }
  }

  close() {
    this.child.stdin.end()
  }
}

const startMcp = async (server: Acp.McpServer): Promise<Mcp> => {
  if (!("command" in server)) throw new Error("expected a stdio MCP server")
  const env: Record<string, string | undefined> = { ...process.env }
  for (const variable of server.env) env[variable.name] = variable.value
  const child = spawn(server.command, server.args, { env, stdio: ["pipe", "pipe", "pipe"] })
  const mcp = new Mcp(child)
  await mcp.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "0" } })
  mcp.notify("notifications/initialized")
  return mcp
}

const configOptions = (model: string, effort: string, mode: string): Array<Acp.SessionConfigOption> => [
  {
    id: "mode",
    name: "Mode",
    category: "mode",
    type: "select",
    currentValue: mode,
    options: [{ value: "default", name: "Default" }, { value: "bypassPermissions", name: "Bypass permissions" }]
  },
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: model,
    options: [{ value: "default", name: "Default" }, { value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }]
  },
  {
    id: "effort",
    name: "Effort",
    category: "thought_level",
    type: "select",
    currentValue: effort,
    options: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }]
  }
]

let connection: Acp.AgentSideConnection
let mcpServers: Array<Acp.McpServer> = []
const values = { model: "default", effort: "high", mode: "bypassPermissions" }

const agent: Acp.Agent = {
  initialize: () => ({
    protocolVersion: Acp.PROTOCOL_VERSION,
    agentCapabilities: {},
    agentInfo: { name: "fake-agent", version: "1.0.0" }
  }),
  authenticate: () => ({}),
  newSession: (params) => {
    log({ event: "session", mcpServers: params.mcpServers, meta: params._meta, cwd: params.cwd })
    if (scenario === "login") throw Acp.RequestError.authRequired()
    mcpServers = params.mcpServers
    return { sessionId: "session-1", configOptions: configOptions(values.model, values.effort, values.mode) }
  },
  setSessionConfigOption: (params) => {
    log({ event: "set", id: params.configId, value: params.value })
    if (params.configId in values && typeof params.value === "string") (values as Record<string, string>)[params.configId] = params.value
    return { configOptions: configOptions(values.model, values.effort, values.mode) }
  },
  cancel: () => {
    log({ event: "cancel" })
  },
  prompt: async (params) => {
    const text = params.prompt.map((block) => (block.type === "text" ? block.text : "")).join("")
    log({ event: "prompt", mentionsListTabs: text.includes("list_tabs") })
    const server = mcpServers[0]
    if (server === undefined) throw new Error("no MCP server")
    if (scenario === "forbidden") {
      for (const toolCall of [
        { toolCallId: "t1", title: "rm -rf ~", kind: "execute" as const },
        { toolCallId: "t2", title: "mcp__wherefore__list_tabs", kind: "other" as const }
      ]) {
        const answer = await connection.requestPermission({
          sessionId: params.sessionId,
          toolCall,
          options: [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "always", name: "Always allow", kind: "allow_always" },
            { optionId: "reject", name: "Reject", kind: "reject_once" }
          ]
        })
        log({ event: "permission", tool: toolCall.title, outcome: answer.outcome })
      }
    }
    if (scenario === "hang") {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" })
      log({ event: "child", childPid: child.pid })
    }
    const mcp = await startMcp(server)
    const listed = await mcp.tool("list_tabs")
    if (listed.isError) {
      log({ event: "list_failed", text: listed.text })
      mcp.close()
      return { stopReason: "end_turn" }
    }
    const tabs: Array<{ id: number }> = listed.structured.tabs
    log({ event: "listed", count: tabs.length })
    if (scenario === "crash") process.exit(3)
    if (scenario === "hang") return new Promise<never>(() => {})
    if (scenario === "nosubmit") {
      mcp.close()
      return { stopReason: "end_turn", usage: { totalTokens: 30, inputTokens: 20, outputTokens: 10 } }
    }
    if (scenario === "ask") {
      const asked = await mcp.tool("ask_user", {
        questions: [{ id: "q1", tab_ids: [tabs[0]?.id], question: "Still need this?", options: ["Yes", "No"] }]
      })
      log({ event: "asked", isError: asked.isError, answers: asked.structured?.answers })
    }
    const submitted = await mcp.tool("submit_intentions", {
      intentions: tabs.map((tab) => ({ title: `Tab ${tab.id}`, why: "w", kind: "read", tab_ids: [tab.id], confidence: "high", evidence: "e" }))
    })
    log({ event: "submitted", isError: submitted.isError, text: submitted.text })
    mcp.close()
    await connection.sessionUpdate({
      sessionId: params.sessionId,
      update: { sessionUpdate: "usage_update", used: 1000, size: 200000, cost: { amount: 0.042, currency: "USD" } }
    })
    return { stopReason: "end_turn", usage: { totalTokens: 1500, inputTokens: 1000, outputTokens: 400, cachedReadTokens: 100 } }
  }
}

log({ event: "started", scenario })
connection = new Acp.AgentSideConnection(
  () => agent,
  Acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>)
)

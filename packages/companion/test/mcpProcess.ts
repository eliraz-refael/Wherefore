/**
 * A real `wherefore mcp` process (src/cli.ts, run by Node with type stripping) and a raw JSON-RPC
 * client of its stdio: what an MCP client like Claude Code does, without an MCP SDK.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Scope } from "effect"

const cli = NodePath.join(NodePath.dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.ts")

export interface ToolResult {
  readonly isError: boolean
  readonly text: string
  readonly structured: any
}

export class McpProcess {
  stderr = ""
  private buffer = ""
  private nextId = 1
  private readonly waiting = new Map<number, (message: any) => void>()
  readonly exited: Promise<number | null>

  constructor(readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      this.buffer += chunk
      let newline
      while ((newline = this.buffer.indexOf("\n")) >= 0) {
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (line.trim() === "") continue
        const message = JSON.parse(line)
        if (message.id !== undefined) this.waiting.get(message.id)?.(message)
      }
    })
    child.stderr.on("data", (chunk) => (this.stderr += chunk))
    this.exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)))
  }

  /** Sends a request; resolves with its result, or rejects with its JSON-RPC error. */
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

  /** The id the next request will get (to cancel it). */
  get peekId(): number {
    return this.nextId
  }

  notify(method: string, params: unknown = {}): void {
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`)
  }

  async callTool(name: string, args: unknown = {}): Promise<ToolResult> {
    const result = await this.request("tools/call", { name, arguments: args })
    return {
      isError: result.isError === true,
      text: result.content?.map((part: { text?: string }) => part.text ?? "").join("") ?? "",
      structured: result.structuredContent
    }
  }

  /** The client closes the connection, as Claude Code does when it quits. */
  close(): Promise<number | null> {
    this.child.stdin.end()
    return this.exited
  }
}

/** Starts `wherefore mcp` against `home` and completes the MCP handshake. Killed with the scope. */
export const startMcp = (home: string, args: ReadonlyArray<string> = []): Effect.Effect<McpProcess, never, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, "mcp", ...args],
        { env: { ...process.env, WHEREFORE_HOME: home }, stdio: ["pipe", "pipe", "pipe"] }
      )
      const mcp = new McpProcess(child)
      const init = await mcp.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test-client", version: "1.0.0" }
      })
      mcp.notify("notifications/initialized")
      ;(mcp as { initialize?: unknown }).initialize = init
      return mcp
    }),
    (mcp) => Effect.sync(() => mcp.child.kill("SIGKILL"))
  )

/** Runs `wherefore <args>` against `home` with stdin closed; resolves with its exit code and stderr. */
export const runCli = (home: string, args: ReadonlyArray<string>) =>
  Effect.promise(() =>
    new Promise<{ readonly code: number | null; readonly stderr: string }>((resolve) => {
      const child = spawn(
        process.execPath,
        ["--experimental-strip-types", "--disable-warning=ExperimentalWarning", cli, ...args],
        { env: { ...process.env, WHEREFORE_HOME: home }, stdio: ["ignore", "pipe", "pipe"] }
      )
      let stderr = ""
      child.stderr.on("data", (chunk) => (stderr += chunk))
      child.on("exit", (code) => resolve({ code, stderr }))
    })
  )

/** Waits (real time) until `condition` holds. */
export const eventually = (condition: () => boolean, ms = 10_000) =>
  Effect.promise(async () => {
    const start = Date.now()
    while (!condition()) {
      if (Date.now() - start > ms) throw new Error("condition never became true")
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  })

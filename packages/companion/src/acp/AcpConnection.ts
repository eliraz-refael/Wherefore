/**
 * `AcpConnection`: the companion's ACP client of one agent process, over its stdio (newline-
 * delimited JSON-RPC), wrapping `@agentclientprotocol/sdk`'s `ClientSideConnection` (architecture
 * A1: the SDK's types and promises stay in here).
 *
 * Requests become Effects that fail with `AcpRequestFailed` (the agent's JSON-RPC error, with its
 * code, or the connection closing). Interrupting `prompt` sends ACP's `session/cancel`, then waits
 * a moment for the agent to end the turn. What the agent pushes (session updates) and asks
 * (permission) goes to the caller's handlers.
 */
import { Data, Duration, Effect, type Scope } from "effect"
import { Acp } from "../unstable.ts"
import type { AgentProcess } from "./AgentProcess.ts"

/**
 * How long a cancelled prompt gets to settle before it is abandoned (the process tree is ended
 * next). Short: when Chrome closes the port, it kills the broker soon after, and the agent's tree
 * must be signalled before that.
 */
export const CANCEL_GRACE = Duration.millis(500)

/** An ACP request failed: the agent answered with an error (`code`), or the connection closed (no code). */
export class AcpRequestFailed extends Data.TaggedError("AcpRequestFailed")<{
  readonly method: string
  readonly code: number | undefined
  readonly message: string
}> {}

export type InitializeResponse = Acp.InitializeResponse
export type NewSessionRequest = Acp.NewSessionRequest
export type NewSessionResponse = Acp.NewSessionResponse
export type PromptResponse = Acp.PromptResponse
export type SessionConfigOption = Acp.SessionConfigOption
export type SessionNotification = Acp.SessionNotification
export type RequestPermissionRequest = Acp.RequestPermissionRequest
export type RequestPermissionResponse = Acp.RequestPermissionResponse

export interface AcpHandlers {
  readonly onUpdate: (notification: SessionNotification) => void
  readonly onPermission: (request: RequestPermissionRequest) => RequestPermissionResponse
}

export interface AcpConnection {
  readonly initialize: (clientInfo: { readonly name: string; readonly version: string }) => Effect.Effect<InitializeResponse, AcpRequestFailed>
  readonly newSession: (params: NewSessionRequest) => Effect.Effect<NewSessionResponse, AcpRequestFailed>
  readonly setConfigOption: (
    sessionId: string,
    configId: string,
    value: string | boolean
  ) => Effect.Effect<ReadonlyArray<SessionConfigOption>, AcpRequestFailed>
  /** The older ACP way to change the permission mode (`session/set_mode`). */
  readonly setMode: (sessionId: string, modeId: string) => Effect.Effect<void, AcpRequestFailed>
  /** Sends the prompt and waits for the turn to end. Interrupted: `session/cancel`, then a short wait. */
  readonly prompt: (sessionId: string, text: string) => Effect.Effect<PromptResponse, AcpRequestFailed>
}

const failure = (method: string) => (error: unknown): AcpRequestFailed =>
  error instanceof Acp.RequestError
    ? new AcpRequestFailed({ method, code: error.code, message: error.message })
    : new AcpRequestFailed({ method, code: undefined, message: error instanceof Error ? error.message : String(error) })

/** Opens an ACP connection over the agent's stdio. It closes with the scope. */
export const connectAcp = (agent: AgentProcess, handlers: AcpHandlers): Effect.Effect<AcpConnection, never, Scope.Scope> =>
  Effect.gen(function*() {
    const client: Acp.Client = {
      sessionUpdate: (notification) => {
        handlers.onUpdate(notification)
      },
      requestPermission: (request) => handlers.onPermission(request)
    }
    const connection = new Acp.ClientSideConnection(() => client, Acp.ndJsonStream(agent.input, agent.output))
    yield* Effect.addFinalizer(() => Effect.promise(() => agent.input.close().catch(() => undefined)))

    const request = <A>(method: string, send: () => Promise<A>) => Effect.tryPromise({ try: send, catch: failure(method) })

    const prompt = (sessionId: string, text: string) =>
      Effect.callback<PromptResponse, AcpRequestFailed>((resume) => {
        let settled = false
        const pending = connection.prompt({ sessionId, prompt: [{ type: "text", text }] })
        pending.then(
          (response) => {
            settled = true
            resume(Effect.succeed(response))
          },
          (error: unknown) => {
            settled = true
            resume(Effect.fail(failure("session/prompt")(error)))
          }
        )
        // Interrupted (Stop): ask the agent to cancel the turn, and give it a moment to end it.
        return Effect.gen(function*() {
          if (settled) return
          yield* Effect.promise(() => connection.cancel({ sessionId }).catch(() => undefined))
          yield* Effect.promise(() => pending.then(() => undefined, () => undefined)).pipe(Effect.timeoutOption(CANCEL_GRACE))
        })
      })

    return {
      initialize: (clientInfo) =>
        request("initialize", () =>
          connection.initialize({
            protocolVersion: Acp.PROTOCOL_VERSION,
            clientCapabilities: {},
            clientInfo: { name: clientInfo.name, version: clientInfo.version }
          })),
      newSession: (params) => request("session/new", () => connection.newSession(params)),
      setConfigOption: (sessionId, configId, value) =>
        request("session/set_config_option", () =>
          connection.setSessionConfigOption(
            typeof value === "boolean" ? { sessionId, configId, type: "boolean", value } : { sessionId, configId, value }
          )).pipe(Effect.map((response) => response.configOptions)),
      setMode: (sessionId, modeId) => request("session/set_mode", () => connection.setSessionMode({ sessionId, modeId })).pipe(Effect.asVoid),
      prompt
    } satisfies AcpConnection
  })

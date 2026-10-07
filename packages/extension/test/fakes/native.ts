/**
 * A fake companion host behind `chrome.runtime.connectNative`. Like Chrome, messages are
 * JSON-copied and delivered asynchronously, a missing host disconnects right after the connect
 * with Chrome's own error message, and the extension's `disconnect()` doesn't fire its own
 * `onDisconnect`.
 */
import {
  type AgentEvent,
  type AgentPrefs,
  AgentRpcs,
  type AgentRunError,
  CompanionWorkerRpcs,
  NATIVE_PROTOCOL_VERSION,
  type RunId
} from "@wherefore/core"
import { Effect, Layer, Queue, type Scope, Stream } from "effect"
import { FORBIDDEN, NOT_FOUND } from "../../src/companion/CompanionLink.ts"
import { NativeConnector, type NativePort } from "../../src/companion/NativeConnector.ts"
import { RpcClient, type RpcMessage, RpcSerialization, RpcServer } from "../../src/unstable.ts"

/** How the host behaves on a new connection. */
export type HostMode =
  /** Not installed: Chrome reports "not found". */
  | "missing"
  /** Installed for another extension. */
  | "forbidden"
  /** Answers `Hello` with `Welcome`. */
  | "answer"
  /** Starts, then exits before answering. */
  | "crash"
  /** Starts and never answers. */
  | "silent"

export class HostConnection {
  /** What the extension sent. */
  readonly received: Array<unknown> = []
  readonly messageListeners = new Set<(message: unknown) => void>()
  readonly disconnectListeners = new Set<(error: string | undefined) => void>()
  open = true
  /** True once the extension called `disconnect()`. */
  closedByExtension = false
  onReceive: (message: unknown) => void = () => {}

  /** The host sends a message to the extension. */
  send(message: unknown): void {
    const copy: unknown = JSON.parse(JSON.stringify(message))
    queueMicrotask(() => {
      if (this.open) for (const listener of this.messageListeners) listener(copy)
    })
  }

  /** The host goes away; the extension hears Chrome's reason. */
  exit(error: string | undefined = "Native host has exited."): void {
    if (!this.open) return
    this.open = false
    queueMicrotask(() => {
      for (const listener of this.disconnectListeners) listener(error)
    })
  }

  /** The extension's end. */
  readonly port: NativePort = {
    postMessage: (message) => {
      if (!this.open) throw new Error("Attempting to use a disconnected port object")
      const copy: unknown = JSON.parse(JSON.stringify(message))
      this.received.push(copy)
      queueMicrotask(() => this.onReceive(copy))
    },
    disconnect: () => {
      this.open = false
      this.closedByExtension = true
    },
    onMessage: {
      addListener: (listener) => void this.messageListeners.add(listener),
      removeListener: (listener) => void this.messageListeners.delete(listener)
    },
    onDisconnect: {
      addListener: (listener) => void this.disconnectListeners.add(listener),
      removeListener: (listener) => void this.disconnectListeners.delete(listener)
    }
  }
}

export class FakeNativeHost {
  readonly connections: Array<HostConnection> = []
  /** The protocol version the host's `Welcome` claims. */
  protocol = NATIVE_PROTOCOL_VERSION
  companionVersion = "0.9.0"

  constructor(public mode: HostMode = "missing") {}

  get last(): HostConnection | undefined {
    return this.connections.at(-1)
  }

  readonly connector: NativeConnector["Service"] = {
    connect: Effect.sync(() => {
      const connection = new HostConnection()
      this.connections.push(connection)
      switch (this.mode) {
        case "missing":
          connection.exit(NOT_FOUND)
          break
        case "forbidden":
          connection.exit(FORBIDDEN)
          break
        case "crash":
          connection.exit("Native host has exited.")
          break
        case "answer":
          connection.onReceive = (message) => {
            if ((message as { _tag?: unknown })._tag === "Hello") {
              connection.send({ _tag: "Welcome", protocol: this.protocol, companionVersion: this.companionVersion })
            }
          }
          break
        case "silent":
          break
      }
      return connection.port
    }),
    extensionVersion: "1.0.0"
  }

  get layer(): Layer.Layer<NativeConnector> {
    return Layer.succeed(NativeConnector)(this.connector)
  }
}

/**
 * The broker's end of a connection: a real RPC client of the worker's `CompanionWorkerRpcs`, as
 * the companion's `WorkerLink` is. Closing the scope interrupts its calls, like a broker whose
 * socket client hung up.
 */
export const brokerClient = (connection: HostConnection) =>
  Effect.gen(function*() {
    const replies = yield* Queue.unbounded<RpcMessage.FromServerEncoded>()
    const previous = connection.onReceive
    connection.onReceive = (message) => {
      previous(message)
      const frame = message as { readonly _tag?: unknown; readonly rpc?: unknown }
      if (frame._tag === "FromWorker") Queue.offerUnsafe(replies, frame.rpc as RpcMessage.FromServerEncoded)
    }
    const protocol = yield* RpcClient.Protocol.make((writeResponse, clientIds) =>
      Effect.gen(function*() {
        yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(replies), (reply) =>
          Effect.forEach(clientIds, (clientId) => writeResponse(clientId, reply), { discard: true }))))
        return {
          send: (_clientId, request) => Effect.sync(() => connection.send({ _tag: "ToWorker", rpc: request })),
          supportsAck: true,
          supportsTransferables: false,
          codecFor: RpcSerialization.json.codecFor
        }
      })
    )
    return yield* RpcClient.make(CompanionWorkerRpcs, { flatten: true, disableTracing: true }).pipe(
      Effect.provideService(RpcClient.Protocol, protocol)
    )
  }) satisfies Effect.Effect<unknown, never, Scope.Scope>

/** What the worker asked the fake broker for (`start_agent`). */
export interface AgentRequest {
  readonly runId: RunId
  readonly command: string
  readonly prefs: AgentPrefs
}

/**
 * The broker's side of ACP mode on a connection: a real RPC server of `AgentRpcs` (the worker's
 * `ToBroker` frames in, `FromBroker` frames out), whose `start_agent` is the test's script. The
 * requests it got, and how each ended (`interrupted` when the worker stopped following it), are
 * recorded.
 */
export const fakeAgentBroker = (
  connection: HostConnection,
  script: (request: AgentRequest) => Stream.Stream<AgentEvent, AgentRunError>
) =>
  Effect.gen(function*() {
    const requests: Array<AgentRequest> = []
    const ended: Array<string> = []
    const calls = yield* Queue.unbounded<RpcMessage.FromClientEncoded>()
    const previous = connection.onReceive
    connection.onReceive = (message) => {
      previous(message)
      const frame = message as { readonly _tag?: unknown; readonly rpc?: unknown }
      if (frame._tag === "ToBroker") Queue.offerUnsafe(calls, frame.rpc as RpcMessage.FromClientEncoded)
    }
    const protocol = yield* RpcServer.Protocol.make((writeRequest) =>
      Effect.gen(function*() {
        yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(calls), (request) => writeRequest(0, request))))
        return {
          disconnects: yield* Queue.unbounded<number>(),
          send: (_clientId, response) => Effect.sync(() => connection.send({ _tag: "FromBroker", rpc: response })),
          end: () => Effect.void,
          clientIds: Effect.succeed(new Set([0])),
          initialMessage: Effect.succeedNone,
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: false,
          supportsNotifications: false,
          codecFor: RpcSerialization.json.codecFor
        }
      })
    )
    yield* RpcServer.make(AgentRpcs, { disableTracing: true }).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provide(AgentRpcs.toLayer(AgentRpcs.of({
        start_agent: (request) => {
          requests.push(request)
          return script(request).pipe(
            Stream.onExit((exit) =>
              Effect.sync(() => {
                ended.push(exit._tag === "Success" ? "finished" : exit.cause.reasons.some((reason) => reason._tag === "Interrupt") ? "interrupted" : "failed")
              })
            )
          )
        }
      }))),
      Effect.forkScoped
    )
    return { requests, ended }
  }) satisfies Effect.Effect<unknown, never, Scope.Scope>

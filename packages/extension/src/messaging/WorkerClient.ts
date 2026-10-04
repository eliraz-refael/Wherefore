/**
 * The page's side of page <-> worker messaging: `WorkerClient` calls the worker's `WorkerRpcs`
 * (core rpc.ts) over a `chrome.runtime` Port (see protocol.ts).
 *
 * - **Reconnects.** The worker can be stopped at any time, which disconnects the Port. The next
 *   call opens a new Port, which starts the worker again. Each Port gets its own RPC client.
 * - **Never hangs.** When a Port disconnects, every call still waiting on it fails with
 *   `WorkerUnavailable`. Calls made afterwards go to the next Port.
 * - The RPC library's own types stay in here (architecture A1): callers see core's schemas and
 *   errors, plus `WorkerUnavailable`.
 */
import { WorkerRpcs } from "@wherefore/core"
import { Context, Effect, Exit, Layer, Option, Queue, Schema, Scope, Semaphore } from "effect"
import { browser } from "wxt/browser"
import { type Rpc, RpcClient, RpcClientError, type RpcGroup, type RpcMessage, RpcSerialization } from "../unstable.ts"
import { decodeFromWorker, PORT_NAME, type PortLike } from "./protocol.ts"

/** The worker couldn't be reached, or went away while a call was waiting for it. Safe to retry. */
export class WorkerUnavailable extends Schema.TaggedError<WorkerUnavailable>()("WorkerUnavailable", {
  message: Schema.String
}) {}

/** Opens a Port to the worker. */
export class PortConnector extends Context.Service<PortConnector, {
  readonly connect: Effect.Effect<PortLike, WorkerUnavailable>
}>()("@wherefore/extension/PortConnector") {
  /** `chrome.runtime.connect`. */
  static readonly layer: Layer.Layer<PortConnector> = Layer.succeed(PortConnector)({
    connect: Effect.try({
      try: () => {
        const port = browser.runtime.connect({ name: PORT_NAME })
        // Reading lastError marks a disconnect error as handled, so Chrome doesn't log it.
        port.onDisconnect.addListener(() => void browser.runtime.lastError)
        return port
      },
      // Throws when the extension was reloaded or updated under this page.
      catch: (cause) => new WorkerUnavailable({ message: `cannot connect to the worker: ${String(cause)}` })
    })
  })
}

type WorkerRpc = RpcGroup.Rpcs<typeof WorkerRpcs>
export type WorkerRpcTag = WorkerRpc["_tag"]
type ByTag<Tag extends WorkerRpcTag> = Rpc.ExtractTag<WorkerRpc, Tag>

export class WorkerClient extends Context.Service<WorkerClient, {
  /** Calls one of the worker's RPCs, e.g. `call("list_tabs", {})`. */
  readonly call: <const Tag extends WorkerRpcTag>(
    tag: Tag,
    payload: Rpc.PayloadConstructor<ByTag<Tag>>
  ) => Effect.Effect<Rpc.Success<ByTag<Tag>>, Rpc.Error<ByTag<Tag>> | WorkerUnavailable>
}>()("@wherefore/extension/WorkerClient") {
  /** Needs a `PortConnector`: `PortConnector.layer` in a page, a fake in tests. */
  static readonly layerWith: Layer.Layer<WorkerClient, never, PortConnector> = Layer.effect(WorkerClient)(
    Effect.gen(function*() {
      return yield* make
    })
  )
  /** For extension pages. */
  static readonly layer: Layer.Layer<WorkerClient> = WorkerClient.layerWith.pipe(Layer.provide(PortConnector.layer))
}

const DISCONNECTED = "disconnected" as const

/** Marks a request that never left the page, so retrying it can't run it twice. */
const NOT_SENT = { notSent: true } as const

const disconnectedError = (message: string, cause: unknown = undefined) =>
  new RpcClientError.RpcClientError({ reason: new RpcClientError.RpcClientDefect({ message, cause }) })

const wasNotSent = (error: unknown): boolean =>
  error instanceof RpcClientError.RpcClientError && error.reason._tag === "RpcClientDefect" &&
  error.reason.cause === NOT_SENT

/**
 * A client `Protocol` over one Port. When the Port disconnects (or a send finds it dead),
 * `onDown` runs at once and sends fail from then on, marked `NOT_SENT`; then every waiting call
 * gets a `ClientProtocolError`, and `afterDown` runs.
 */
const makePortProtocol = (port: PortLike, onDown: () => void, afterDown: Effect.Effect<void>) =>
  RpcClient.Protocol.make((writeResponse, clientIds) =>
    Effect.gen(function*() {
      const inbox = yield* Queue.unbounded<RpcMessage.FromServerEncoded | typeof DISCONNECTED>()
      let down = false
      const markDown = () => {
        if (down) return
        down = true
        onDown()
        Queue.offerUnsafe(inbox, DISCONNECTED)
      }
      const onMessage = (message: unknown) =>
        Option.match(decodeFromWorker(message), {
          onNone: () => console.warn("RPC: dropped a malformed message from the worker"),
          onSome: (decoded) => Queue.offerUnsafe(inbox, decoded as RpcMessage.FromServerEncoded)
        })
      const onDisconnect = markDown
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          port.onMessage.addListener(onMessage)
          port.onDisconnect.addListener(onDisconnect)
        }),
        () =>
          Effect.sync(() => {
            port.onMessage.removeListener(onMessage)
            port.onDisconnect.removeListener(onDisconnect)
            port.disconnect()
          })
      )
      const broadcast = (message: RpcMessage.FromServerEncoded) =>
        Effect.forEach(clientIds, (clientId) => writeResponse(clientId, message), { discard: true })
      yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(inbox), (message) =>
        message === DISCONNECTED
          ? broadcast({ _tag: "ClientProtocolError", error: disconnectedError("the service worker disconnected") }).pipe(
            // `afterDown` may close the scope this loop runs in, so it runs on its own fiber.
            Effect.andThen(Effect.forkDetach(afterDown))
          )
          : broadcast(message))))
      return {
        send: (_clientId, request) =>
          Effect.suspend(() => {
            if (down) return Effect.fail(disconnectedError("the service worker disconnected", NOT_SENT))
            try {
              port.postMessage(request)
              return Effect.void
            } catch {
              // The Port died before Chrome told us (the worker was just stopped).
              markDown()
              return Effect.fail(disconnectedError("the service worker disconnected", NOT_SENT))
            }
          }),
        supportsAck: true,
        supportsTransferables: false,
        codecFor: RpcSerialization.json.codecFor
      }
    })
  )

type FlatClient = RpcClient.RpcClient.Flat<WorkerRpc, RpcClientError.RpcClientError>

interface Connection {
  readonly client: FlatClient
  readonly state: { alive: boolean }
}

const make = Effect.gen(function*() {
  const connector = yield* PortConnector
  const layerScope = yield* Effect.scope
  const lock = Semaphore.makeUnsafe(1)
  let current: Connection | undefined

  const open = Effect.gen(function*() {
    const port = yield* connector.connect
    const scope = yield* Scope.fork(layerScope)
    const state = { alive: true }
    const protocol = yield* makePortProtocol(
      port,
      () => {
        state.alive = false
      },
      Scope.close(scope, Exit.void)
    ).pipe(Scope.provide(scope))
    const client = yield* RpcClient.make(WorkerRpcs, { flatten: true, disableTracing: true }).pipe(
      Effect.provideService(RpcClient.Protocol, protocol),
      Scope.provide(scope)
    )
    return { client, state } satisfies Connection
  })

  const connection = Semaphore.withPermit(lock)(Effect.gen(function*() {
    if (current !== undefined && current.state.alive) return current
    current = yield* open
    return current
  }))

  // The flat client's conditional return type doesn't resolve for a generic tag, so the call is
  // re-typed once here, from the same Rpc definitions.
  // A call that never reached a dead Port is retried once on a new one; a call that was sent
  // is never retried here (it may have run), it fails with `WorkerUnavailable`.
  const call = <const Tag extends WorkerRpcTag>(tag: Tag, payload: Rpc.PayloadConstructor<ByTag<Tag>>) =>
    Effect.flatMap(connection, ({ client }) => client<Tag>(tag, payload)).pipe(
      Effect.retry({ times: 1, while: wasNotSent }),
      Effect.catchIf(
        (error): error is RpcClientError.RpcClientError => error instanceof RpcClientError.RpcClientError,
        (error) => Effect.fail(new WorkerUnavailable({ message: error.reason.message }))
      )
    ) as Effect.Effect<Rpc.Success<ByTag<Tag>>, Rpc.Error<ByTag<Tag>> | WorkerUnavailable>

  return WorkerClient.of({ call })
})

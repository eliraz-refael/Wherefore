/**
 * The worker's side of page <-> worker messaging: an RPC server `Protocol` over the Ports that
 * extension pages open with `chrome.runtime.connect` (see protocol.ts).
 *
 * Every Port is one client. Only Ports named `PORT_NAME` and opened by this extension's own pages
 * are accepted; anything else is disconnected (see `listenForPorts`). When a page goes away, its
 * Port disconnects and the RPC server interrupts that page's calls (handlers that must finish,
 * like closing tabs, are uninterruptible).
 */
import { Context, Effect, Layer, Queue, Scope } from "effect"
import { RpcSerialization, RpcServer } from "../unstable.ts"
import type { RpcMessage } from "../unstable.ts"
import { decodeToWorker, PORT_NAME, type PortLike } from "./protocol.ts"

/** What happens on the Ports opened to the worker. */
export type PortEvent =
  | { readonly _tag: "Connected"; readonly port: PortLike }
  | { readonly _tag: "Message"; readonly port: PortLike; readonly message: unknown }
  | { readonly _tag: "Disconnected"; readonly port: PortLike }

/** Where the worker hears about Ports from its own pages. */
export class PortListener extends Context.Service<PortListener, {
  /** Events on accepted Ports, in order, until the scope closes. Events before the first subscription are kept. */
  readonly events: Effect.Effect<Queue.Dequeue<PortEvent>, never, Scope.Scope>
}>()("@wherefore/extension/PortListener") {}

const isOwnPage = (port: PortLike, origin: string): boolean =>
  port.name === PORT_NAME && port.sender?.url?.startsWith(origin) === true

/**
 * Starts listening on `onConnect` (`chrome.runtime.onConnect` in the worker) now, synchronously. MV3 delivers the event that
 * woke the worker only to listeners added while the worker script first runs, and a Port's
 * messages only to listeners present when they arrive. So every listener is added here, at
 * once, and events are buffered until the RPC server subscribes. Ports that aren't named
 * `PORT_NAME` or don't come from this extension's own pages are disconnected.
 */
export const listenForPorts = (
  onConnect: { addListener(listener: (port: PortLike) => void): void },
  /** This extension's origin, `chrome-extension://<id>/`. */
  origin: string
): PortListener["Service"] => {
  const buffered: Array<PortEvent> = []
  let deliver = (event: PortEvent): void => {
    buffered.push(event)
  }
  onConnect.addListener((port) => {
    if (!isOwnPage(port, origin)) {
      port.disconnect()
      return
    }
    deliver({ _tag: "Connected", port })
    port.onMessage.addListener((message) => deliver({ _tag: "Message", port, message }))
    port.onDisconnect.addListener(() => deliver({ _tag: "Disconnected", port }))
  })
  return {
    events: Effect.gen(function*() {
      const queue = yield* Queue.unbounded<PortEvent>()
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          Queue.offerAllUnsafe(queue, buffered.splice(0))
          deliver = (event) => Queue.offerUnsafe(queue, event)
        }),
        () =>
          Effect.sync(() => {
            deliver = (event) => buffered.push(event)
          })
      )
      return queue
    })
  }
}

/** An RPC server `Protocol` serving every accepted Port. */
export const makeServerProtocol: Effect.Effect<
  RpcServer.Protocol["Service"],
  never,
  PortListener | Scope.Scope
> = RpcServer.Protocol.make((writeRequest) =>
  Effect.gen(function*() {
    const listener = yield* PortListener
    const disconnects = yield* Queue.unbounded<number>()
    const clientIdOf = new Map<PortLike, number>()
    const clients = new Map<number, PortLike>()
    let nextClientId = 0

    const handle = (event: PortEvent): Effect.Effect<void> => {
      switch (event._tag) {
        case "Connected": {
          const clientId = nextClientId++
          clientIdOf.set(event.port, clientId)
          clients.set(clientId, event.port)
          return Effect.void
        }
        case "Disconnected": {
          const clientId = clientIdOf.get(event.port)
          if (clientId === undefined) return Effect.void
          clientIdOf.delete(event.port)
          clients.delete(clientId)
          return Queue.offer(disconnects, clientId)
        }
        case "Message": {
          const clientId = clientIdOf.get(event.port)
          if (clientId === undefined) return Effect.void
          const decoded = decodeToWorker(event.message)
          if (decoded._tag === "None") return Effect.logWarning("RPC: dropped a malformed message from a page")
          return writeRequest(clientId, decoded.value as RpcMessage.FromClientEncoded)
        }
      }
    }

    const events = yield* listener.events
    yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(events), handle)))
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const port of clients.values()) port.disconnect()
        clients.clear()
        clientIdOf.clear()
      })
    )

    return {
      disconnects,
      send: (clientId, response) =>
        Effect.sync(() => {
          try {
            clients.get(clientId)?.postMessage(response)
          } catch {
            // The page is gone; its disconnect event follows.
          }
        }),
      end: () => Effect.void,
      clientIds: Effect.sync(() => new Set(clients.keys())),
      initialMessage: Effect.succeedNone,
      supportsAck: true,
      supportsTransferables: false,
      supportsSpanPropagation: false,
      supportsNotifications: false,
      codecFor: RpcSerialization.json.codecFor
    }
  })
)

export const layerServerProtocol: Layer.Layer<RpcServer.Protocol, never, PortListener> = Layer.effect(
  RpcServer.Protocol
)(makeServerProtocol)

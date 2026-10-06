/**
 * The broker's side of the native port: an `effect/unstable/rpc` client of the service worker's
 * `TabToolRpcs` (core rpc.ts). Requests go to Chrome as `ToWorker` frames; the worker's replies
 * arrive as `FromWorker` frames (core companion.ts).
 *
 * - **Never hangs.** When Chrome closes the port (stdin ends), every call still waiting fails
 *   with `ExtensionUnavailable`, and so does every call after it.
 * - **Interrupts travel.** A call interrupted here (its socket client hung up) sends `Interrupt`,
 *   so the worker stops the work too.
 * - **Never a bad frame.** A request over Chrome's 1 MB limit fails with `ToolError` and isn't sent.
 * - The RPC library's types stay in here (architecture A1).
 */
import { ExtensionUnavailable, type RpcFromServer, TabToolRpcs, ToolError } from "@wherefore/core"
import { Effect, Queue, Scope } from "effect"
import { NativeMessageTooLarge } from "../native/codec.ts"
import { type Rpc, RpcClient, RpcClientError, type RpcGroup, type RpcMessage, RpcSerialization } from "../unstable.ts"

/** Put in the inbox when the port is gone. */
export const PORT_CLOSED = "port-closed" as const

type ToolRpc = RpcGroup.Rpcs<typeof TabToolRpcs>
export type ToolTag = ToolRpc["_tag"]
type ByTag<Tag extends ToolTag> = Rpc.ExtractTag<ToolRpc, Tag>

export interface WorkerLink {
  readonly call: <const Tag extends ToolTag>(
    tag: Tag,
    payload: Rpc.PayloadConstructor<ByTag<Tag>>
  ) => Effect.Effect<Rpc.Success<ByTag<Tag>>, ToolError | ExtensionUnavailable>
}

export const CLOSED_MESSAGE =
  "Chrome closed its connection to the Wherefore extension (the browser or profile closed, or the extension reloaded)."

const clientError = (message: string, cause?: unknown) =>
  new RpcClientError.RpcClientError({ reason: new RpcClientError.RpcClientDefect({ message, cause }) })

export const makeWorkerLink = (options: {
  /** Sends one frame to Chrome. */
  readonly send: (frame: unknown) => Effect.Effect<void, NativeMessageTooLarge>
  /** The worker's replies, then `PORT_CLOSED`. */
  readonly inbox: Queue.Dequeue<RpcFromServer | typeof PORT_CLOSED>
}): Effect.Effect<WorkerLink, never, Scope.Scope> =>
  Effect.gen(function*() {
    const protocol = yield* RpcClient.Protocol.make((writeResponse, clientIds) =>
      Effect.gen(function*() {
        let closed = false
        const broadcast = (message: RpcMessage.FromServerEncoded) =>
          Effect.forEach(clientIds, (clientId) => writeResponse(clientId, message), { discard: true })
        yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(options.inbox), (message) => {
          if (message !== PORT_CLOSED) return broadcast(message as RpcMessage.FromServerEncoded)
          closed = true
          return broadcast({ _tag: "ClientProtocolError", error: clientError(CLOSED_MESSAGE) })
        })))
        return {
          send: (_clientId, request) =>
            closed
              ? Effect.fail(clientError(CLOSED_MESSAGE))
              : options.send({ _tag: "ToWorker", rpc: request }).pipe(
                Effect.mapError((tooLarge) => clientError("request too large for Chrome", tooLarge))
              ),
          supportsAck: true,
          supportsTransferables: false,
          codecFor: RpcSerialization.json.codecFor
        }
      })
    )
    const client = yield* RpcClient.make(TabToolRpcs, { flatten: true, disableTracing: true }).pipe(
      Effect.provideService(RpcClient.Protocol, protocol)
    )

    const toBrokerError = (error: RpcClientError.RpcClientError) => {
      const cause = error.reason._tag === "RpcClientDefect" ? error.reason.cause : undefined
      return cause instanceof NativeMessageTooLarge
        ? new ToolError({ message: `The request is ${cause.bytes} bytes; Chrome accepts at most ${cause.limit}.` })
        : new ExtensionUnavailable({ message: CLOSED_MESSAGE })
    }

    // The flat client's conditional return type doesn't resolve for a generic tag, so the call
    // is re-typed once here, from the same Rpc definitions.
    const call = <const Tag extends ToolTag>(tag: Tag, payload: Rpc.PayloadConstructor<ByTag<Tag>>) =>
      client<Tag>(tag, payload).pipe(
        Effect.catchIf(
          (error): error is RpcClientError.RpcClientError => error instanceof RpcClientError.RpcClientError,
          (error) => Effect.fail(toBrokerError(error))
        )
      ) as Effect.Effect<Rpc.Success<ByTag<Tag>>, ToolError | ExtensionUnavailable>

    return { call }
  })

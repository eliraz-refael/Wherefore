/**
 * The broker's side of the native port: an `effect/unstable/rpc` client of the service worker's
 * `CompanionWorkerRpcs` (core rpc.ts): the tab tools and the companion-run RPCs. Requests go to
 * Chrome as `ToWorker` frames; the worker's replies arrive as `FromWorker` frames (core
 * companion.ts).
 *
 * - **Never hangs.** When Chrome closes the port (stdin ends), every call still waiting fails
 *   with `ExtensionUnavailable`, and so does every call after it. A run's lease (`open_run`, a
 *   stream) fails the same way.
 * - **Interrupts travel.** A call interrupted here (its socket client hung up) sends `Interrupt`,
 *   so the worker stops the work too; for a lease, that ends the run's lease in the worker.
 * - **Never a bad frame.** A request over Chrome's 1 MB limit fails with `MessageTooLarge` and
 *   isn't sent.
 * - The RPC library's types stay in here (architecture A1).
 */
import {
  CompanionWorkerRpcs,
  ExtensionUnavailable,
  MessageTooLarge,
  type OpenRunError,
  type RpcFromServer,
  type RunSignal
} from "@wherefore/core"
import { Effect, Queue, Scope, Stream } from "effect"
import { NativeMessageTooLarge } from "../native/codec.ts"
import { type Rpc, RpcClient, RpcClientError, type RpcGroup, type RpcMessage, RpcSerialization } from "../unstable.ts"

/** Put in the inbox when the port is gone. */
export const PORT_CLOSED = "port-closed" as const

type WorkerRpc = RpcGroup.Rpcs<typeof CompanionWorkerRpcs>
/** The worker's request/response RPCs (everything but the `open_run` stream). */
export type CallTag = Exclude<WorkerRpc["_tag"], "open_run">
type ByTag<Tag extends WorkerRpc["_tag"]> = Rpc.ExtractTag<WorkerRpc, Tag>

export type LinkError = ExtensionUnavailable | MessageTooLarge

export interface WorkerLink {
  readonly call: <const Tag extends CallTag>(
    tag: Tag,
    payload: Rpc.PayloadConstructor<ByTag<Tag>>
  ) => Effect.Effect<Rpc.Success<ByTag<Tag>>, Rpc.Error<ByTag<Tag>> | LinkError>
  /** `open_run`: a run's lease, open until the stream is interrupted (or the user stops the run). */
  readonly openRun: (
    payload: Rpc.PayloadConstructor<ByTag<"open_run">>
  ) => Stream.Stream<RunSignal, OpenRunError | LinkError>
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
    const client = yield* RpcClient.make(CompanionWorkerRpcs, { flatten: true, disableTracing: true }).pipe(
      Effect.provideService(RpcClient.Protocol, protocol)
    )

    const toLinkError = (error: RpcClientError.RpcClientError): LinkError => {
      const cause = error.reason._tag === "RpcClientDefect" ? error.reason.cause : undefined
      return cause instanceof NativeMessageTooLarge
        ? new MessageTooLarge({ bytes: cause.bytes, limit: cause.limit })
        : new ExtensionUnavailable({ message: CLOSED_MESSAGE })
    }
    const isClientError = (error: unknown): error is RpcClientError.RpcClientError =>
      error instanceof RpcClientError.RpcClientError

    // The flat client's conditional return type doesn't resolve for a generic tag, so the call
    // is re-typed once here, from the same Rpc definitions.
    const call = <const Tag extends CallTag>(tag: Tag, payload: Rpc.PayloadConstructor<ByTag<Tag>>) =>
      (client(tag, payload as never) as unknown as Effect.Effect<unknown, unknown>).pipe(
        Effect.catchIf(isClientError, (error) => Effect.fail(toLinkError(error)))
      ) as Effect.Effect<Rpc.Success<ByTag<Tag>>, Rpc.Error<ByTag<Tag>> | LinkError>

    const openRun = (payload: Rpc.PayloadConstructor<ByTag<"open_run">>) =>
      client("open_run", payload).pipe(
        Stream.catchIf(isClientError, (error) => Stream.fail(toLinkError(error)))
      ) as Stream.Stream<RunSignal, OpenRunError | LinkError>

    return { call, openRun }
  })

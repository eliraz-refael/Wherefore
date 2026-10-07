/**
 * A client of one broker's socket: `BrokerRpcs` (core broker.ts) over ndjson. `status` uses it to
 * ask each broker who it is; the MCP server uses it to forward tool calls and to hold its runs'
 * leases.
 *
 * Every request carries the broker's access token (from its registry entry). One connection, no
 * reconnects: when the broker goes away, calls fail with `BrokerUnreachable` and the caller picks a
 * broker again from the registry. A broker that answers with a defect (e.g. an older companion that
 * doesn't know a request) is reported the same way. The RPC library's types stay in here
 * (architecture A1).
 */
import { BROKER_TOKEN_HEADER, BrokerRpcs, type RunSignal } from "@wherefore/core"
import { Cause, Duration, Effect, Schedule, Schema, Scope, Stream } from "effect"
import { NodeSocket, type Rpc, RpcClient, RpcClientError, type RpcGroup, RpcSerialization, Socket } from "../unstable.ts"

/** The broker's socket refused us, or closed before answering. */
export class BrokerUnreachable extends Schema.TaggedError<BrokerUnreachable>()("BrokerUnreachable", {
  socket: Schema.String,
  message: Schema.String
}) {}

type BrokerRpc = RpcGroup.Rpcs<typeof BrokerRpcs>
/** The broker's request/response RPCs (everything but the `open_run` stream). */
export type BrokerRpcTag = Exclude<BrokerRpc["_tag"], "open_run">
type ByTag<Tag extends BrokerRpc["_tag"]> = Rpc.ExtractTag<BrokerRpc, Tag>
type OpenRunError = Rpc.Success<ByTag<"open_run">> extends Stream.Stream<infer _A, infer E, infer _R> ? E : never

export interface BrokerClient {
  readonly socket: string
  readonly call: <const Tag extends BrokerRpcTag>(
    tag: Tag,
    payload: Rpc.PayloadConstructor<ByTag<Tag>>
  ) => Effect.Effect<Rpc.Success<ByTag<Tag>>, Rpc.Error<ByTag<Tag>> | BrokerUnreachable>
  /** `open_run`: a run's lease, open until the stream is interrupted (or the user stops the run). */
  readonly openRun: (
    payload: Rpc.PayloadConstructor<ByTag<"open_run">>
  ) => Stream.Stream<RunSignal, OpenRunError | BrokerUnreachable>
}

/** Connects lazily (on the first call) and disconnects when the scope closes. */
export const connectBroker = (socket: string, token: string): Effect.Effect<BrokerClient, never, Scope.Scope> =>
  Effect.gen(function*() {
    const connection = yield* NodeSocket.makeNet({ path: socket, openTimeout: Duration.seconds(2) })
    const protocol = yield* RpcClient.makeProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
      Effect.provideService(Socket.Socket, connection),
      Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.ndjson)
    )
    const client = yield* RpcClient.make(BrokerRpcs, { flatten: true, disableTracing: true }).pipe(
      Effect.provideService(RpcClient.Protocol, protocol)
    )
    const headers = { [BROKER_TOKEN_HEADER]: token }
    const unreachable = (message: string) => new BrokerUnreachable({ socket, message })
    const isClientError = (error: unknown): error is RpcClientError.RpcClientError =>
      error instanceof RpcClientError.RpcClientError

    // The flat client's conditional return type doesn't resolve for a generic tag, so the call is
    // re-typed once here, from the same Rpc definitions.
    const call = <const Tag extends BrokerRpcTag>(tag: Tag, payload: Rpc.PayloadConstructor<ByTag<Tag>>) =>
      ((client as (tag: string, payload: unknown, options: unknown) => unknown)(tag, payload, { headers }) as Effect.Effect<
        unknown,
        unknown
      >).pipe(
        Effect.catchIf(isClientError, (error) => Effect.fail(unreachable(error.reason.message))),
        Effect.catchDefect((defect) => Effect.fail(unreachable(`the broker failed: ${Cause.pretty(Cause.die(defect))}`)))
      ) as Effect.Effect<Rpc.Success<ByTag<Tag>>, Rpc.Error<ByTag<Tag>> | BrokerUnreachable>

    const openRun = (payload: Rpc.PayloadConstructor<ByTag<"open_run">>) =>
      client("open_run", payload, { headers }).pipe(
        Stream.catchIf(isClientError, (error) => Stream.fail(unreachable(error.reason.message))),
        Stream.catchCause((cause) =>
          Cause.hasDies(cause) && !Cause.hasInterrupts(cause)
            ? Stream.fail(unreachable(`the broker failed: ${Cause.pretty(cause)}`))
            : Stream.failCause(cause)
        )
      ) as Stream.Stream<RunSignal, OpenRunError | BrokerUnreachable>

    return { socket, call, openRun }
  })

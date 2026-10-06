/**
 * A client of one broker's socket: `BrokerRpcs` (core broker.ts) over ndjson. `status` uses it to
 * ask each broker who it is; M2 PR B's MCP server uses it to forward tool calls.
 *
 * One connection, no reconnects: when the broker goes away, calls fail with `BrokerUnreachable`
 * and the caller picks a broker again from the registry. The RPC library's types stay in here
 * (architecture A1).
 */
import { BrokerRpcs } from "@wherefore/core"
import { Duration, Effect, Schedule, Schema, Scope } from "effect"
import { NodeSocket, type Rpc, RpcClient, RpcClientError, type RpcGroup, RpcSerialization, Socket } from "../unstable.ts"

/** The broker's socket refused us, or closed before answering. */
export class BrokerUnreachable extends Schema.TaggedError<BrokerUnreachable>()("BrokerUnreachable", {
  socket: Schema.String,
  message: Schema.String
}) {}

type BrokerRpc = RpcGroup.Rpcs<typeof BrokerRpcs>
export type BrokerRpcTag = BrokerRpc["_tag"]
type ByTag<Tag extends BrokerRpcTag> = Rpc.ExtractTag<BrokerRpc, Tag>

export interface BrokerClient {
  readonly socket: string
  readonly call: <const Tag extends BrokerRpcTag>(
    tag: Tag,
    payload: Rpc.PayloadConstructor<ByTag<Tag>>
  ) => Effect.Effect<Rpc.Success<ByTag<Tag>>, Rpc.Error<ByTag<Tag>> | BrokerUnreachable>
}

/** Connects lazily (on the first call) and disconnects when the scope closes. */
export const connectBroker = (socket: string): Effect.Effect<BrokerClient, never, Scope.Scope> =>
  Effect.gen(function*() {
    const connection = yield* NodeSocket.makeNet({ path: socket, openTimeout: Duration.seconds(2) })
    const protocol = yield* RpcClient.makeProtocolSocket({ retryPolicy: Schedule.recurs(0) }).pipe(
      Effect.provideService(Socket.Socket, connection),
      Effect.provideService(RpcSerialization.RpcSerialization, RpcSerialization.ndjson)
    )
    const client = yield* RpcClient.make(BrokerRpcs, { flatten: true, disableTracing: true }).pipe(
      Effect.provideService(RpcClient.Protocol, protocol)
    )
    // The flat client's conditional return type doesn't resolve for a generic tag, so the call is
    // re-typed once here, from the same Rpc definitions.
    const call = <const Tag extends BrokerRpcTag>(tag: Tag, payload: Rpc.PayloadConstructor<ByTag<Tag>>) =>
      client<Tag>(tag, payload).pipe(
        Effect.catchIf(
          (error): error is RpcClientError.RpcClientError => error instanceof RpcClientError.RpcClientError,
          (error) => Effect.fail(new BrokerUnreachable({ socket, message: error.reason.message }))
        )
      ) as Effect.Effect<Rpc.Success<ByTag<Tag>>, Rpc.Error<ByTag<Tag>> | BrokerUnreachable>
    return { socket, call }
  })

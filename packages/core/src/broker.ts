/**
 * The broker's RPC surface (architecture A3): what MCP servers and ACP sessions call over the
 * broker's local socket (a Unix domain socket, or a named pipe on Windows).
 *
 * - `broker_info`: who this broker is (which profile, which versions), for discovery and health.
 * - The worker's tool RPCs, forwarded to the profile's service worker over the native port. They
 *   are rpc.ts's own requests, with the same payload and success schemas, so a tool call keeps
 *   the model's wire form end to end. Only the error widens: a call can also fail with
 *   `ExtensionUnavailable`, because the broker can lose Chrome while a call waits.
 */
import { Schema } from "effect"
import { ProfileId } from "./ids.ts"
import { ListTabsRpc, ReadPagesRpc, WakeAndReadPagesRpc } from "./rpc.ts"
import { ToolError } from "./tools.ts"
import { Rpc, RpcGroup } from "./unstable.ts"

/**
 * The broker has no extension to forward to: Chrome closed the native port (the browser or the
 * profile closed, or the extension was reloaded) before the call finished, or the call couldn't
 * be sent. Calling another broker, or the same profile's next broker, may work.
 */
export class ExtensionUnavailable extends Schema.TaggedError<ExtensionUnavailable>()("ExtensionUnavailable", {
  message: Schema.String
}) {}

/** One broker's identity. */
export const BrokerInfo = Schema.Struct({
  profileId: ProfileId,
  extensionVersion: Schema.String,
  companionVersion: Schema.String,
  /** The native-messaging protocol version (companion.ts). */
  protocol: Schema.Int,
  pid: Schema.Int,
  /** Epoch ms. */
  startedAt: Schema.Number
})
export type BrokerInfo = typeof BrokerInfo.Type

export const BrokeredToolError = Schema.Union([ToolError, ExtensionUnavailable])

export const BrokerRpcs = RpcGroup.make(
  Rpc.make("broker_info", { success: BrokerInfo }),
  ListTabsRpc.setError(BrokeredToolError),
  ReadPagesRpc.setError(BrokeredToolError),
  WakeAndReadPagesRpc.setError(BrokeredToolError)
)

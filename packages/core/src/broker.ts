/**
 * The broker's RPC surface (architecture A3): what MCP servers and ACP sessions call over the
 * broker's local socket (a Unix domain socket, or a named pipe on Windows).
 *
 * - `broker_info`: who this broker is (which profile, which versions), for discovery and health.
 * - The worker's tool RPCs and companion-run RPCs (`CompanionWorkerRpcs`, rpc.ts), forwarded to
 *   the profile's service worker over the native port. They are rpc.ts's own requests, with the
 *   same payload and success schemas, so a tool call keeps the model's wire form end to end. Only
 *   the error widens: a call can also fail with `ExtensionUnavailable`, because the broker can lose
 *   Chrome while a call waits, and with `BrokerUnauthorized`.
 *
 * **Access token.** Every request carries the broker's token in the `BROKER_TOKEN_HEADER` header.
 * The broker makes a random token at start and writes it only to its registry entry (user-only),
 * so only the user's own processes can call it, even where the socket itself is readable by
 * others (Windows named pipes). A request without the right token fails with `BrokerUnauthorized`.
 */
import { Schema } from "effect"
import { ProfileId } from "./ids.ts"
import {
  AskPanelError,
  AskPanelRpc,
  ListTabsRpc,
  OpenRunError,
  OpenRunRpc,
  ReadPagesRpc,
  RunSignal,
  UpdateRunError,
  UpdateRunRpc,
  WakeAndReadPagesRpc
} from "./rpc.ts"
import { ToolError } from "./tools.ts"
import { Rpc, RpcGroup } from "./unstable.ts"

/** The request header that carries the broker's access token. */
export const BROKER_TOKEN_HEADER = "x-wherefore-token"

/** The request didn't carry this broker's access token. */
export class BrokerUnauthorized extends Schema.TaggedError<BrokerUnauthorized>()("BrokerUnauthorized", {
  message: Schema.String
}) {}

/**
 * A request is over Chrome's 1 MB limit for one native message, so it wasn't sent (e.g. a run with
 * thousands of tabs).
 */
export class MessageTooLarge extends Schema.TaggedError<MessageTooLarge>()("MessageTooLarge", {
  bytes: Schema.Int,
  limit: Schema.Int
}) {}

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

export const BrokeredToolError = Schema.Union([ToolError, ExtensionUnavailable, BrokerUnauthorized])

/** What the broker adds to a companion-run RPC's errors. */
const brokered = <E extends Schema.Top>(error: E) =>
  Schema.Union([error, ExtensionUnavailable, MessageTooLarge, BrokerUnauthorized])

export const BrokeredOpenRunError = brokered(OpenRunError)
export const BrokeredUpdateRunError = brokered(UpdateRunError)
export const BrokeredAskPanelError = brokered(AskPanelError)

export const BrokerRpcs = RpcGroup.make(
  Rpc.make("broker_info", { success: BrokerInfo, error: BrokerUnauthorized }),
  ListTabsRpc.setError(BrokeredToolError),
  ReadPagesRpc.setError(BrokeredToolError),
  WakeAndReadPagesRpc.setError(BrokeredToolError),
  // A stream's errors are part of its success schema, so open_run is redefined rather than widened.
  Rpc.make(OpenRunRpc._tag, {
    payload: OpenRunRpc.payloadSchema,
    success: RunSignal,
    error: BrokeredOpenRunError,
    stream: true
  }),
  UpdateRunRpc.setError(BrokeredUpdateRunError),
  AskPanelRpc.setError(BrokeredAskPanelError)
)

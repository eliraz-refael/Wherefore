/**
 * The extension <-> companion link (architecture A3), defined once for both sides.
 *
 * The service worker opens one native-messaging port to the companion's host,
 * `NATIVE_HOST_NAME`, and keeps it open. Chrome starts one host process per profile's port, and
 * that process is the profile's broker: agents (MCP, ACP) reach the profile's tabs through it.
 *
 * On the port (JSON messages, framed by Chrome):
 * 1. The extension sends `Hello` (its profile id and version), the host answers `Welcome`.
 * 2. Then the broker calls the worker's `TabToolRpcs` (rpc.ts): `ToWorker` carries an
 *    `effect/unstable/rpc` client message, `FromWorker` the worker's reply. The payloads are the
 *    RPC protocol's own encoded envelopes, the same ones pages use over their Ports.
 *
 * Room to grow: calls the other way (the panel starting an ACP run, M2 PR C) add their own frame
 * tags (`ToBroker`/`FromBroker`) to these unions, on the same port.
 */
import { Schema } from "effect"
import { ProfileId } from "./ids.ts"

// ---------- identity ----------

/**
 * The extension's ID. Chrome derives it from the manifest's public key (see the extension's
 * extensionId.ts, which checks the two agree), so every unpacked install gets the same one.
 */
export const EXTENSION_ID = "anpbbaiepneaddgoldgmapilgiflochg"

/** What Chrome passes a native host as the caller, and what the host manifest allows. */
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`

/**
 * The companion's native-messaging host name. Not the POC's (`com.tab_intentions.host`), so both
 * companions can be installed side by side. The extension connects to this name only.
 */
export const NATIVE_HOST_NAME = "io.github.eliraz_refael.wherefore"

/** Bumped when the frames below change incompatibly. Both sides refuse a different version. */
export const NATIVE_PROTOCOL_VERSION = 1

/** Chrome's limit on one message from a native host to the extension (1 MB). */
export const NATIVE_MESSAGE_MAX_BYTES = 1024 * 1024

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567"

/** A profile id from 16 random bytes: lowercase base32 without padding (26 characters). */
export const profileIdFromBytes = (bytes: Uint8Array): ProfileId => {
  if (bytes.length !== 16) throw new Error("a profile id takes exactly 16 bytes")
  let bits = 0
  let value = 0
  let out = ""
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += BASE32.charAt((value >>> (bits - 5)) & 31)
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32.charAt((value << (5 - bits)) & 31)
  return ProfileId.make(out)
}

// ---------- RPC envelopes ----------

const RequestId = Schema.Union([Schema.String, Schema.Number])
const Header = Schema.Tuple([Schema.String, Schema.String])

/**
 * An RPC client's message (`effect/unstable/rpc`'s encoded `FromClient`), checked before it
 * reaches the RPC machinery, so a malformed message is dropped instead of crashing either side.
 * Pages send these to the worker, and so does the broker.
 */
export const RpcFromClient = Schema.Union([
  Schema.Struct({
    _tag: Schema.tag("Request"),
    id: RequestId,
    tag: Schema.String,
    payload: Schema.Unknown,
    headers: Schema.Array(Header),
    isNotification: Schema.optionalKey(Schema.Literal(true)),
    traceId: Schema.optionalKey(Schema.String),
    spanId: Schema.optionalKey(Schema.String),
    sampled: Schema.optionalKey(Schema.Boolean)
  }),
  Schema.Struct({ _tag: Schema.tag("Ack"), requestId: RequestId }),
  Schema.Struct({ _tag: Schema.tag("Interrupt"), requestId: RequestId }),
  Schema.Struct({ _tag: Schema.tag("Eof") }),
  Schema.Struct({ _tag: Schema.tag("Ping") })
])
export type RpcFromClient = typeof RpcFromClient.Type

/** An RPC server's message (`effect/unstable/rpc`'s encoded `FromServer`). */
export const RpcFromServer = Schema.Union([
  Schema.Struct({ _tag: Schema.tag("Chunk"), requestId: RequestId, values: Schema.NonEmptyArray(Schema.Unknown) }),
  Schema.Struct({ _tag: Schema.tag("Exit"), requestId: RequestId, exit: Schema.Unknown }),
  Schema.Struct({ _tag: Schema.tag("Defect"), defect: Schema.Unknown }),
  Schema.Struct({ _tag: Schema.tag("Pong") })
])
export type RpcFromServer = typeof RpcFromServer.Type

// ---------- native port frames ----------

/** The extension's first message on the port. */
export const NativeHello = Schema.TaggedStruct("Hello", {
  protocol: Schema.Int,
  profileId: ProfileId,
  extensionVersion: Schema.String
})
export type NativeHello = typeof NativeHello.Type

/** The host's answer to `Hello`. A different `protocol` means one side must be updated. */
export const NativeWelcome = Schema.TaggedStruct("Welcome", {
  protocol: Schema.Int,
  companionVersion: Schema.String
})
export type NativeWelcome = typeof NativeWelcome.Type

/** The broker calls the worker. */
export const ToWorkerFrame = Schema.TaggedStruct("ToWorker", { rpc: RpcFromClient })
/** The worker answers the broker. */
export const FromWorkerFrame = Schema.TaggedStruct("FromWorker", { rpc: RpcFromServer })

export const ExtensionToHost = Schema.Union([NativeHello, FromWorkerFrame])
export type ExtensionToHost = typeof ExtensionToHost.Type

export const HostToExtension = Schema.Union([NativeWelcome, ToWorkerFrame])
export type HostToExtension = typeof HostToExtension.Type

// ---------- status ----------

/**
 * The worker's link to the companion, for onboarding and Settings. The worker keeps it in
 * `chrome.storage.session` (key `companion`), so every view can follow it.
 */
export const CompanionStatus = Schema.Union([
  /** The worker is connecting (or hasn't tried yet). */
  Schema.TaggedStruct("Checking", {}),
  /** Chrome found no host by our name: the companion isn't installed for this browser. */
  Schema.TaggedStruct("NotInstalled", {}),
  Schema.TaggedStruct("Connected", {
    profileId: ProfileId,
    companionVersion: Schema.String,
    /** Epoch ms. */
    since: Schema.Number
  }),
  /**
   * The companion is installed but the link is down. `message` is for the user. `retryAt` (epoch
   * ms) is set while the worker will try again on its own; without it, the worker waits for the
   * next start or `check_companion`.
   */
  Schema.TaggedStruct("Unavailable", {
    reason: Schema.Literals(["forbidden", "incompatible", "failed"]),
    message: Schema.String,
    retryAt: Schema.optionalKey(Schema.Number)
  })
])
export type CompanionStatus = typeof CompanionStatus.Type

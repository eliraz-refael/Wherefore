/**
 * The wire between extension pages and the service worker: `effect/unstable/rpc` messages over a
 * `chrome.runtime` Port.
 *
 * Each page opens one Port named `PORT_NAME`; each Port is one RPC client of the worker.
 * Messages are the RPC protocol's own encoded envelopes (`Request`, `Exit`, ...), posted as plain
 * objects: Chrome serializes Port messages as JSON, and payloads are encoded with
 * `Schema.toCodecJson`. Both directions are decoded with the schemas below before they reach
 * the RPC machinery, so a malformed message is dropped instead of crashing either side.
 *
 * Room to grow: worker-to-page calls (`ask_user` in M2, where the first open panel to answer
 * wins) can add their own message tags to these unions on the same Port; the worker already
 * tracks every connected page.
 */
import { Schema } from "effect"

export const PORT_NAME = "wherefore/rpc"

/** What the RPC layer needs from a `chrome.runtime.Port`. The real Port satisfies it. */
export interface PortLike {
  readonly name: string
  postMessage(message: unknown): void
  disconnect(): void
  readonly onMessage: {
    addListener(listener: (message: unknown) => void): void
    removeListener(listener: (message: unknown) => void): void
  }
  readonly onDisconnect: {
    addListener(listener: () => void): void
    removeListener(listener: () => void): void
  }
  /** Set on the worker's side: who opened the Port. */
  readonly sender?: { readonly id?: string | undefined; readonly url?: string | undefined } | undefined
}

const RequestId = Schema.Union([Schema.String, Schema.Number])
const Header = Schema.Tuple([Schema.String, Schema.String])

/** Page to worker. */
export const ToWorker = Schema.Union([
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
export type ToWorker = typeof ToWorker.Type

/** Worker to page. */
export const FromWorker = Schema.Union([
  Schema.Struct({ _tag: Schema.tag("Chunk"), requestId: RequestId, values: Schema.NonEmptyArray(Schema.Unknown) }),
  Schema.Struct({ _tag: Schema.tag("Exit"), requestId: RequestId, exit: Schema.Unknown }),
  Schema.Struct({ _tag: Schema.tag("Defect"), defect: Schema.Unknown }),
  Schema.Struct({ _tag: Schema.tag("Pong") })
])
export type FromWorker = typeof FromWorker.Type

export const decodeToWorker = Schema.decodeUnknownOption(ToWorker)
export const decodeFromWorker = Schema.decodeUnknownOption(FromWorker)

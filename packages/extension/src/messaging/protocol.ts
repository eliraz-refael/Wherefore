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
import { RpcFromClient, RpcFromServer } from "@wherefore/core"
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

/** Page to worker: an RPC client's message (core companion.ts, shared with the broker). */
export const ToWorker = RpcFromClient
export type ToWorker = RpcFromClient

/** Worker to page. */
export const FromWorker = RpcFromServer
export type FromWorker = RpcFromServer

export const decodeToWorker = Schema.decodeUnknownOption(ToWorker)
export const decodeFromWorker = Schema.decodeUnknownOption(FromWorker)

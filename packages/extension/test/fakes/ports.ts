/**
 * In-memory `chrome.runtime` Ports. Like Chrome, a message is JSON-serialized and delivered
 * asynchronously, and `disconnect()` fires `onDisconnect` on the other end only.
 */
import type { PortLike } from "../../src/messaging/protocol.ts"

export class FakePort implements PortLike {
  other: FakePort | undefined
  connected = true
  readonly messageListeners = new Set<(message: unknown) => void>()
  readonly disconnectListeners = new Set<() => void>()
  readonly onMessage = {
    addListener: (listener: (message: unknown) => void) => void this.messageListeners.add(listener),
    removeListener: (listener: (message: unknown) => void) => void this.messageListeners.delete(listener)
  }
  readonly onDisconnect = {
    addListener: (listener: () => void) => void this.disconnectListeners.add(listener),
    removeListener: (listener: () => void) => void this.disconnectListeners.delete(listener)
  }
  readonly sent: Array<unknown> = []

  constructor(readonly name: string, readonly sender?: { readonly id?: string; readonly url?: string }) {}

  postMessage(message: unknown): void {
    if (!this.connected) throw new Error("Attempting to use a disconnected port object")
    this.sent.push(message)
    const copy: unknown = JSON.parse(JSON.stringify(message))
    const other = this.other
    queueMicrotask(() => {
      if (other?.connected === true) for (const listener of other.messageListeners) listener(copy)
    })
  }

  disconnect(): void {
    if (!this.connected) return
    this.connected = false
    const other = this.other
    if (other === undefined || !other.connected) return
    other.connected = false
    queueMicrotask(() => {
      for (const listener of other.disconnectListeners) listener()
    })
  }
}

/** A connected pair: the page's end and the worker's end (which carries the sender). */
export const portPair = (name: string, senderUrl: string): { readonly page: FakePort; readonly worker: FakePort } => {
  const page = new FakePort(name)
  const worker = new FakePort(name, { id: "test-extension", url: senderUrl })
  page.other = worker
  worker.other = page
  return { page, worker }
}

/** A fake `chrome.runtime.onConnect`. */
export class FakeOnConnect {
  readonly listeners = new Set<(port: PortLike) => void>()
  addListener(listener: (port: PortLike) => void): void {
    this.listeners.add(listener)
  }
  fire(port: PortLike): void {
    for (const listener of this.listeners) listener(port)
  }
}

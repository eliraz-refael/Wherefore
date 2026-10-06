/**
 * A fake companion host behind `chrome.runtime.connectNative`. Like Chrome, messages are
 * JSON-copied and delivered asynchronously, a missing host disconnects right after the connect
 * with Chrome's own error message, and the extension's `disconnect()` doesn't fire its own
 * `onDisconnect`.
 */
import { NATIVE_PROTOCOL_VERSION } from "@wherefore/core"
import { Effect, Layer } from "effect"
import { FORBIDDEN, NOT_FOUND } from "../../src/companion/CompanionLink.ts"
import { NativeConnector, type NativePort } from "../../src/companion/NativeConnector.ts"

/** How the host behaves on a new connection. */
export type HostMode =
  /** Not installed: Chrome reports "not found". */
  | "missing"
  /** Installed for another extension. */
  | "forbidden"
  /** Answers `Hello` with `Welcome`. */
  | "answer"
  /** Starts, then exits before answering. */
  | "crash"
  /** Starts and never answers. */
  | "silent"

export class HostConnection {
  /** What the extension sent. */
  readonly received: Array<unknown> = []
  readonly messageListeners = new Set<(message: unknown) => void>()
  readonly disconnectListeners = new Set<(error: string | undefined) => void>()
  open = true
  /** True once the extension called `disconnect()`. */
  closedByExtension = false
  onReceive: (message: unknown) => void = () => {}

  /** The host sends a message to the extension. */
  send(message: unknown): void {
    const copy: unknown = JSON.parse(JSON.stringify(message))
    queueMicrotask(() => {
      if (this.open) for (const listener of this.messageListeners) listener(copy)
    })
  }

  /** The host goes away; the extension hears Chrome's reason. */
  exit(error: string | undefined = "Native host has exited."): void {
    if (!this.open) return
    this.open = false
    queueMicrotask(() => {
      for (const listener of this.disconnectListeners) listener(error)
    })
  }

  /** The extension's end. */
  readonly port: NativePort = {
    postMessage: (message) => {
      if (!this.open) throw new Error("Attempting to use a disconnected port object")
      const copy: unknown = JSON.parse(JSON.stringify(message))
      this.received.push(copy)
      queueMicrotask(() => this.onReceive(copy))
    },
    disconnect: () => {
      this.open = false
      this.closedByExtension = true
    },
    onMessage: {
      addListener: (listener) => void this.messageListeners.add(listener),
      removeListener: (listener) => void this.messageListeners.delete(listener)
    },
    onDisconnect: {
      addListener: (listener) => void this.disconnectListeners.add(listener),
      removeListener: (listener) => void this.disconnectListeners.delete(listener)
    }
  }
}

export class FakeNativeHost {
  readonly connections: Array<HostConnection> = []
  /** The protocol version the host's `Welcome` claims. */
  protocol = NATIVE_PROTOCOL_VERSION
  companionVersion = "0.9.0"

  constructor(public mode: HostMode = "missing") {}

  get last(): HostConnection | undefined {
    return this.connections.at(-1)
  }

  readonly connector: NativeConnector["Service"] = {
    connect: Effect.sync(() => {
      const connection = new HostConnection()
      this.connections.push(connection)
      switch (this.mode) {
        case "missing":
          connection.exit(NOT_FOUND)
          break
        case "forbidden":
          connection.exit(FORBIDDEN)
          break
        case "crash":
          connection.exit("Native host has exited.")
          break
        case "answer":
          connection.onReceive = (message) => {
            if ((message as { _tag?: unknown })._tag === "Hello") {
              connection.send({ _tag: "Welcome", protocol: this.protocol, companionVersion: this.companionVersion })
            }
          }
          break
        case "silent":
          break
      }
      return connection.port
    }),
    extensionVersion: "1.0.0"
  }

  get layer(): Layer.Layer<NativeConnector> {
    return Layer.succeed(NativeConnector)(this.connector)
  }
}

/**
 * The seam around `chrome.runtime.connectNative` (architecture A8): the worker opens native ports
 * only through this service, so tests swap in a fake host (test/fakes/native.ts).
 *
 * There is no host-name parameter: the only host the extension ever connects to is the
 * companion's, `NATIVE_HOST_NAME` (core companion.ts).
 */
import { BrowserError, NATIVE_HOST_NAME } from "@wherefore/core"
import { Context, Effect, Layer } from "effect"
import { type Browser, browser } from "wxt/browser"

/** What the worker needs from a native `chrome.runtime.Port`. */
export interface NativePort {
  postMessage(message: unknown): void
  disconnect(): void
  readonly onMessage: {
    addListener(listener: (message: unknown) => void): void
    removeListener(listener: (message: unknown) => void): void
  }
  /**
   * Fires once, when the host is gone, with Chrome's reason (`runtime.lastError.message`), e.g.
   * "Specified native messaging host not found." or "Native host has exited.". Not fired by
   * our own `disconnect()`.
   */
  readonly onDisconnect: {
    addListener(listener: (error: string | undefined) => void): void
    removeListener(listener: (error: string | undefined) => void): void
  }
}

export class NativeConnector extends Context.Service<NativeConnector, {
  /** Opens a port to the companion's host. Chrome reports a missing host through `onDisconnect`. */
  readonly connect: Effect.Effect<NativePort, BrowserError>
  /** This extension's version, for the host's `Hello`. */
  readonly extensionVersion: string
}>()("@wherefore/extension/NativeConnector") {
  /** The real `chrome.runtime.connectNative`. */
  static readonly layer: Layer.Layer<NativeConnector> = Layer.sync(NativeConnector)(() => ({
    connect: Effect.try({
      try: () => wrap(browser.runtime.connectNative(NATIVE_HOST_NAME)),
      catch: (cause) =>
        new BrowserError({ operation: "runtime.connectNative", message: cause instanceof Error ? cause.message : String(cause) })
    }),
    extensionVersion: browser.runtime.getManifest().version
  }))
}

const wrap = (port: Browser.runtime.Port): NativePort => {
  const disconnectListeners = new Map<(error: string | undefined) => void, () => void>()
  return {
    postMessage: (message) => port.postMessage(message),
    disconnect: () => port.disconnect(),
    onMessage: port.onMessage,
    onDisconnect: {
      addListener: (listener) => {
        // Reading lastError inside the listener is how Chrome reports the reason, and marks it handled.
        const wrapped = () => listener(browser.runtime.lastError?.message)
        disconnectListeners.set(listener, wrapped)
        port.onDisconnect.addListener(wrapped)
      },
      removeListener: (listener) => {
        const wrapped = disconnectListeners.get(listener)
        if (wrapped === undefined) return
        disconnectListeners.delete(listener)
        port.onDisconnect.removeListener(wrapped)
      }
    }
  }
}

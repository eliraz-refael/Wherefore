import { Effect, Layer } from "effect"
import { browser } from "wxt/browser"
import { defineBackground } from "wxt/utils/define-background"
import { WorkerLayer } from "../background/worker.ts"
import { ChromeApi } from "../chrome/ChromeApi.ts"
import { listenForPorts, PortListener } from "../messaging/server.ts"

/**
 * The service worker (architecture A4): executes tab tools and owns storage writes for the
 * extension's pages, over RPC. It never runs a model, and keeps no run state: Chrome can stop it
 * at any time.
 */
export default defineBackground(() => {
  browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error: unknown) => console.error("sidePanel.setPanelBehavior failed", error))

  // Synchronously, before anything async: the Port that woke the worker must not be missed.
  const ports = listenForPorts(browser.runtime.onConnect, `chrome-extension://${browser.runtime.id}/`)

  WorkerLayer.pipe(
    Layer.provide([ChromeApi.layer, Layer.succeed(PortListener)(ports)]),
    Layer.launch,
    Effect.tapCause((cause) => Effect.logError("Wherefore worker stopped", cause)),
    Effect.runFork
  )
})

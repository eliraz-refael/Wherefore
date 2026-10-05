/**
 * The whole service worker as one layer: migrate storage at startup, then serve `WorkerRpcs`.
 * The entrypoint provides the real `ChromeApi` and `PortListener`; tests provide fakes.
 */
import { Effect, Layer } from "effect"
import type { ChromeApi } from "../chrome/ChromeApi.ts"
import type { PortListener } from "../messaging/server.ts"
import { serveWorkerRpcs } from "./handlers.ts"
import { Store } from "./Store.ts"
import { TabTools } from "./TabTools.ts"

/** Reads every key once: old versions are migrated, unreadable ones backed up (and logged). */
const migrateStorage = Layer.effectDiscard(
  Effect.flatMap(Store, (store) => store.migrateAll).pipe(
    Effect.tap((errors) =>
      Effect.forEach(
        errors.filter((error) => error._tag === "BrowserError"),
        (error) => Effect.logError(`Store: startup migration failed: ${error.operation}: ${error.message}`),
        { discard: true }
      )
    )
  )
)

export const WorkerLayer: Layer.Layer<never, never, ChromeApi | PortListener> = Layer.mergeAll(
  migrateStorage,
  serveWorkerRpcs
).pipe(Layer.provide(Layer.mergeAll(TabTools.layer, Store.layer)))

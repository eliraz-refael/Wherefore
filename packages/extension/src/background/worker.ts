/**
 * The whole service worker as one layer: migrate storage at startup, mark runs whose page (or
 * agent) is gone as interrupted, connect to the companion when it is installed, then serve
 * `WorkerRpcs`. The
 * entrypoint provides the real `ChromeApi`, `PortListener`, `RunLocks` and `NativeConnector`;
 * tests provide fakes.
 */
import { Effect, Layer } from "effect"
import type { ChromeApi } from "../chrome/ChromeApi.ts"
import { CompanionLink } from "../companion/CompanionLink.ts"
import { CompanionRuns } from "../companion/CompanionRuns.ts"
import type { NativeConnector } from "../companion/NativeConnector.ts"
import type { PortListener } from "../messaging/server.ts"
import { RunLocks } from "../runs/RunLocks.ts"
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

/**
 * A run left "running" by a page that closed while the worker was stopped is marked at the
 * worker's next start. (A run whose page closes while the worker runs is marked by the next
 * `save_run` or `check_runs`.)
 */
const sweepRuns = Layer.effectDiscard(
  Effect.gen(function*() {
    const store = yield* Store
    const locks = yield* RunLocks
    yield* store.interruptRuns(locks.isLive).pipe(
      Effect.catch((error) => Effect.logWarning(`Store: couldn't check for interrupted runs: ${error.message}`))
    )
  })
)

export const WorkerLayer: Layer.Layer<never, never, ChromeApi | PortListener | RunLocks | NativeConnector> = Layer.mergeAll(
  Layer.provideMerge(sweepRuns, migrateStorage),
  serveWorkerRpcs.pipe(Layer.provide(CompanionLink.layer), Layer.provideMerge(CompanionRuns.layer))
).pipe(Layer.provide(Layer.mergeAll(TabTools.layer, Store.layer)))

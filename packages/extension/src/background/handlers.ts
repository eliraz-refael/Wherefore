/**
 * The worker's RPC handlers: `WorkerRpcs` (core rpc.ts) implemented with `TabTools`, `Store`,
 * `RunLocks`, `CompanionLink` and `CompanionRuns`, and the layer that serves them to extension pages.
 */
import { COMPANION_NOT_CONNECTED_MESSAGE, CompanionNotConnected, ItemNotFound, WorkerRpcs } from "@wherefore/core"
import { Effect, Layer } from "effect"
import { CompanionLink } from "../companion/CompanionLink.ts"
import { CompanionRuns } from "../companion/CompanionRuns.ts"
import { layerServerProtocol, type PortListener } from "../messaging/server.ts"
import { RunLocks } from "../runs/RunLocks.ts"
import { itemsKey } from "../store/keys.ts"
import { RpcServer } from "../unstable.ts"
import { Store } from "./Store.ts"
import { TabTools } from "./TabTools.ts"
import { tabToolHandlers } from "./toolHandlers.ts"

export const WorkerHandlers = WorkerRpcs.toLayer(Effect.gen(function*() {
  const tools = yield* TabTools
  const store = yield* Store
  const locks = yield* RunLocks
  const companion = yield* CompanionLink
  const companionRuns = yield* CompanionRuns
  return WorkerRpcs.of({
    ...tabToolHandlers(tools),
    close_tabs: ({ tabIds, keepWindowAlive }) => tools.closeTabs(tabIds, { keepWindowAlive }),
    undo_close: ({ token }) => tools.undoClose(token),
    resume_item: ({ id, windowId }) =>
      Effect.gen(function*() {
        const item = (yield* store.read(itemsKey)).find((item) => item.id === id)
        if (item === undefined) return yield* new ItemNotFound({ id })
        return yield* tools.reopenTabs(item, { windowId })
      }),
    save_items: ({ items }) => store.saveItems(items),
    mark_done: ({ id }) => store.markDone(id),
    mark_open: ({ id }) => store.markOpen(id),
    remove_item: ({ id }) => store.removeItem(id),
    restore_item: ({ removed }) => store.restoreItem(removed),
    remove_tab: ({ id, index, url }) => store.removeTab(id, { index, url }),
    restore_tab: ({ removed }) => store.restoreTab(removed),
    update_settings: ({ settings }) => store.updateSettings(settings),
    reset_store_key: ({ key }) => Effect.map(store.resetKey(key), (backupKey) => ({ backupKey })),
    // Every save also sweeps runs whose page is gone, so a new run marks the one a closed page left.
    save_run: ({ run }) =>
      Effect.andThen(store.saveRun(run), store.interruptRuns(locks.isLive, run.id)).pipe(Effect.asVoid),
    check_runs: () => store.interruptRuns(locks.isLive).pipe(Effect.asVoid),
    set_run_reviewed: ({ id, reviewed }) => store.setRunReviewed(id, reviewed),
    answer_ask: ({ runId, askId, answers }) => companionRuns.answer(runId, askId, answers),
    stop_run: ({ id }) => companionRuns.stop(id),
    // ACP mode: only with the companion connected; the agent's command comes from Settings.
    start_agent_run: () =>
      Effect.gen(function*() {
        const status = yield* companion.status
        if (status._tag !== "Connected") return yield* new CompanionNotConnected({ message: COMPANION_NOT_CONNECTED_MESSAGE })
        return yield* companionRuns.startAgent(companion.startAgent)
      }),
    check_companion: () => companion.check
  })
}))

/**
 * Serves `WorkerRpcs` on every Port from the extension's pages. A handler that dies fails only its
 * own call (`disableFatalDefects`), not every call the page has in flight.
 */
export const serveWorkerRpcs: Layer.Layer<
  never,
  never,
  TabTools | Store | RunLocks | CompanionLink | CompanionRuns | PortListener
> = RpcServer.layer(
  WorkerRpcs,
  { disableTracing: true, disableFatalDefects: true }
).pipe(Layer.provide([WorkerHandlers, layerServerProtocol]))

/**
 * The worker's RPC handlers: `WorkerRpcs` (core rpc.ts) implemented with `TabTools` and `Store`,
 * and the layer that serves them to extension pages.
 */
import { type BrowserError, DEFAULT_MAX_CHARS, ItemNotFound, ToolError, WorkerRpcs } from "@wherefore/core"
import { Effect, Layer } from "effect"
import { layerServerProtocol, type PortListener } from "../messaging/server.ts"
import { itemsKey } from "../store/keys.ts"
import { RpcServer } from "../unstable.ts"
import { Store } from "./Store.ts"
import { TabTools } from "./TabTools.ts"

/** The model hears what failed, never a stack. */
const toToolError = (error: BrowserError) => new ToolError({ message: `${error.operation} failed: ${error.message}` })

export const WorkerHandlers = WorkerRpcs.toLayer(Effect.gen(function*() {
  const tools = yield* TabTools
  const store = yield* Store
  return WorkerRpcs.of({
    list_tabs: () => tools.listTabs.pipe(Effect.map((tabs) => ({ tabs })), Effect.mapError(toToolError)),
    read_pages: ({ tabIds, maxChars }) =>
      Effect.map(tools.readPages(tabIds, maxChars ?? DEFAULT_MAX_CHARS), (pages) => ({ pages })),
    wake_and_read_pages: ({ tabIds, maxChars }) =>
      Effect.map(tools.wakeAndReadPages(tabIds, maxChars ?? DEFAULT_MAX_CHARS), (pages) => ({ pages })),
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
    update_settings: ({ settings }) => store.updateSettings(settings)
  })
}))

/**
 * Serves `WorkerRpcs` on every Port from the extension's pages. A handler that dies fails only its
 * own call (`disableFatalDefects`), not every call the page has in flight.
 */
export const serveWorkerRpcs: Layer.Layer<never, never, TabTools | Store | PortListener> = RpcServer.layer(
  WorkerRpcs,
  { disableTracing: true, disableFatalDefects: true }
).pipe(Layer.provide([WorkerHandlers, layerServerProtocol]))

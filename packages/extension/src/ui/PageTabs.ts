/**
 * What a view needs to know about the browser's tabs, read directly from `chrome.tabs`.
 *
 * Reads only, like `StoreReader` for storage: closing, undo and reopening go through the worker
 * (`WorkerClient`), which owns them. A view reads tabs itself because it needs their real URLs
 * (to save them, and to match them to saved items), while `list_tabs` gives the model redacted ones.
 */
import { BrowserError, TabId, WindowId } from "@wherefore/core"
import { Context, Duration, Effect, Layer, Queue, Stream } from "effect"
import { type Browser, browser } from "wxt/browser"

/** An open tab with its real URL. Titles and URLs come from the web: show them as text only. */
export interface OpenTab {
  readonly id: TabId
  readonly windowId: WindowId
  readonly title: string
  readonly url: string
  readonly pinned: boolean
}

export class PageTabs extends Context.Service<PageTabs, {
  /** The window this page (the side panel) lives in. */
  readonly windowId: Effect.Effect<WindowId, BrowserError>
  /** Every open tab, then the list again after tabs open, close or navigate. */
  readonly watch: Stream.Stream<ReadonlyArray<OpenTab>, BrowserError>
  /** Switches to a tab and focuses its window ("Show me"). False when the tab is gone. */
  readonly show: (id: TabId) => Effect.Effect<boolean>
}>()("@wherefore/extension/PageTabs") {
  static readonly layer: Layer.Layer<PageTabs> = Layer.sync(PageTabs)(() => makeLive())
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const call = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, BrowserError> =>
  Effect.tryPromise({ try: run, catch: (cause) => new BrowserError({ operation, message: messageOf(cause) }) })

const toOpenTab = (tab: Browser.tabs.Tab): ReadonlyArray<OpenTab> =>
  tab.id === undefined || tab.id < 0 || tab.windowId < 0
    ? []
    : [{
      id: TabId.make(tab.id),
      windowId: WindowId.make(tab.windowId),
      title: tab.title ?? "",
      url: tab.url ?? tab.pendingUrl ?? "",
      pinned: tab.pinned
    }]

/** Tab events, coalesced: a burst of changes (closing 100 tabs) re-reads the list once. */
const tabEvents: Stream.Stream<void> = Stream.callback<void>((queue) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const changed = () => void Queue.offerUnsafe(queue, undefined)
      const updated = (_id: number, info: Browser.tabs.OnUpdatedInfo) => {
        if (info.url !== undefined || info.title !== undefined || info.pinned !== undefined) changed()
      }
      browser.tabs.onCreated.addListener(changed)
      browser.tabs.onRemoved.addListener(changed)
      browser.tabs.onUpdated.addListener(updated)
      browser.tabs.onAttached.addListener(changed)
      return { changed, updated }
    }),
    ({ changed, updated }) =>
      Effect.sync(() => {
        browser.tabs.onCreated.removeListener(changed)
        browser.tabs.onRemoved.removeListener(changed)
        browser.tabs.onUpdated.removeListener(updated)
        browser.tabs.onAttached.removeListener(changed)
      })
  ), { bufferSize: 1, strategy: "sliding" }).pipe(Stream.debounce(Duration.millis(250)))

const makeLive = (): PageTabs["Service"] => {
  const list = Effect.map(call("tabs.query", () => browser.tabs.query({})), (tabs) => tabs.flatMap(toOpenTab))
  return {
    windowId: Effect.flatMap(call("windows.getCurrent", () => browser.windows.getCurrent()), (window) =>
      window.id === undefined
        ? Effect.fail(new BrowserError({ operation: "windows.getCurrent", message: "the window has no id" }))
        : Effect.succeed(WindowId.make(window.id))),
    watch: Stream.concat(Stream.fromEffect(list), Stream.mapEffect(tabEvents, () => list)),
    show: (id) =>
      Effect.gen(function*() {
        const tab = yield* call("tabs.update", () => browser.tabs.update(id, { active: true }))
        if (tab?.windowId !== undefined) yield* call("windows.update", () => browser.windows.update(tab.windowId, { focused: true }))
        return true
      }).pipe(Effect.catch(() => Effect.succeed(false)))
  }
}

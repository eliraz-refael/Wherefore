/**
 * Fakes for what a view (side panel) has beyond the worker: its view of the tabs (`PageTabs`, over
 * the same `FakeChrome` the worker uses) and the channel views talk to each other on.
 */
import { TabId, WindowId } from "@wherefore/core"
import { Effect, Layer, Queue, Stream } from "effect"
import { type OpenTab, PageTabs } from "../../src/ui/PageTabs.ts"
import { RelayChannel } from "../../src/ui/Tidy.ts"
import type { FakeChrome } from "./chrome.ts"

const openTabsOf = (chrome: FakeChrome): ReadonlyArray<OpenTab> =>
  chrome.tabs.flatMap((tab) =>
    tab.id === undefined
      ? []
      : [{ id: TabId.make(tab.id), windowId: WindowId.make(tab.windowId), title: tab.title ?? "", url: tab.url ?? "", pinned: tab.pinned }]
  )

/** `PageTabs` for a view in `windowId`. `shown` records "Show me". */
export const fakePageTabs = (chrome: FakeChrome, windowId: number, shown: Array<number> = []): Layer.Layer<PageTabs> =>
  Layer.succeed(PageTabs)({
    windowId: Effect.succeed(WindowId.make(windowId)),
    watch: Stream.callback<ReadonlyArray<OpenTab>>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const emit = () => void Queue.offerUnsafe(queue, openTabsOf(chrome))
          emit()
          return chrome.onTabsChanged(emit)
        }),
        (unsubscribe) => Effect.sync(unsubscribe)
      )
    ),
    show: (id) =>
      Effect.sync(() => {
        shown.push(id)
        return chrome.tabs.some((tab) => tab.id === id)
      })
  })

/** Channels between views of one fake browser: a message reaches every other channel, later. */
export class FakeRelayHub {
  private readonly listeners = new Set<{ readonly from: number; readonly deliver: (message: unknown) => void }>()
  private nextId = 1
  readonly posted: Array<unknown> = []

  channel(): Layer.Layer<RelayChannel> {
    const id = this.nextId++
    return Layer.succeed(RelayChannel)({
      post: (message) =>
        Effect.sync(() => {
          this.posted.push(message)
          const copy = JSON.parse(JSON.stringify(message)) as unknown
          setTimeout(() => {
            for (const listener of this.listeners) if (listener.from !== id) listener.deliver(copy)
          }, 0)
        }),
      messages: Stream.callback<unknown>((queue) =>
        Effect.acquireRelease(
          Effect.sync(() => {
            const listener = { from: id, deliver: (message: unknown) => void Queue.offerUnsafe(queue, message) }
            this.listeners.add(listener)
            return listener
          }),
          (listener) => Effect.sync(() => this.listeners.delete(listener))
        )
      )
    })
  }
}

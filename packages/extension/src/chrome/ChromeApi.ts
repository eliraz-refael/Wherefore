/**
 * The seam around `chrome.*` (architecture A8): every browser call the background services make
 * goes through this service, so tests swap in an in-memory fake (test/fakes/chrome.ts).
 *
 * Only the calls the services use are here. Each one fails with core's `BrowserError`, naming the
 * operation. Events are subscriptions: the listener is added when the effect runs and removed
 * when its scope closes, so nothing can be missed between subscribing and acting.
 */
import { BrowserError } from "@wherefore/core"
import { Context, Effect, Layer, Queue, Scope } from "effect"
import { type Browser, browser } from "wxt/browser"

/** The listener half of a `chrome.events.Event`. */
interface ChromeEvent<Args extends ReadonlyArray<unknown>> {
  addListener(listener: (...args: Args) => void): void
  removeListener(listener: (...args: Args) => void): void
}

/** A change to one tab, from `tabs.onUpdated`. */
export interface TabUpdate {
  readonly tabId: number
  readonly status: string | undefined
}

/** Keys and their old/new values, from `storage.<area>.onChanged`. */
export type StorageChanges = Readonly<Record<string, Browser.storage.StorageChange>>

export interface StorageArea {
  /** `null` reads every key. Missing keys are absent from the result. */
  readonly get: (keys: string | ReadonlyArray<string> | null) => Effect.Effect<Record<string, unknown>, BrowserError>
  readonly set: (items: Readonly<Record<string, unknown>>) => Effect.Effect<void, BrowserError>
  readonly remove: (keys: string | ReadonlyArray<string>) => Effect.Effect<void, BrowserError>
  /** Subscribes to this area's changes until the scope closes. */
  readonly changes: Effect.Effect<Queue.Dequeue<StorageChanges>, never, Scope.Scope>
}

export class ChromeApi extends Context.Service<ChromeApi, {
  readonly tabs: {
    readonly query: (query: Browser.tabs.QueryInfo) => Effect.Effect<ReadonlyArray<Browser.tabs.Tab>, BrowserError>
    readonly get: (tabId: number) => Effect.Effect<Browser.tabs.Tab, BrowserError>
    readonly create: (properties: Browser.tabs.CreateProperties) => Effect.Effect<Browser.tabs.Tab, BrowserError>
    readonly remove: (tabIds: ReadonlyArray<number>) => Effect.Effect<void, BrowserError>
    readonly reload: (tabId: number) => Effect.Effect<void, BrowserError>
    readonly group: (tabIds: readonly [number, ...Array<number>], windowId: number) => Effect.Effect<number, BrowserError>
    /** Subscribes to `tabs.onUpdated` until the scope closes. */
    readonly updates: Effect.Effect<Queue.Dequeue<TabUpdate>, never, Scope.Scope>
  }
  readonly windows: {
    readonly getAll: Effect.Effect<ReadonlyArray<Browser.windows.Window>, BrowserError>
  }
  readonly tabGroups: {
    readonly query: (query: Browser.tabGroups.QueryInfo) => Effect.Effect<ReadonlyArray<Browser.tabGroups.TabGroup>, BrowserError>
    readonly update: (groupId: number, properties: Browser.tabGroups.UpdateProperties) => Effect.Effect<void, BrowserError>
  }
  readonly scripting: {
    /**
     * Runs `func` in the tab's top frame and returns what it returned. The result comes from a
     * web page: it is `unknown` and must be decoded before use.
     */
    readonly executeScript: <const Args extends Array<unknown>>(
      tabId: number,
      func: (...args: Args) => unknown,
      args: Args
    ) => Effect.Effect<unknown, BrowserError>
  }
  readonly sessions: {
    readonly getRecentlyClosed: Effect.Effect<ReadonlyArray<Browser.sessions.Session>, BrowserError>
    readonly restore: (sessionId: string) => Effect.Effect<Browser.sessions.Session, BrowserError>
  }
  readonly storage: {
    readonly local: StorageArea
    /** Survives a worker restart, not a browser restart. Only extension pages and the worker can read it. */
    readonly session: StorageArea
  }
  readonly runtime: {
    /**
     * How many of the extension's views are open in this profile: side panels, and extension
     * pages in tabs (`runtime.getContexts`, Chrome 116+). The worker asks before showing a
     * companion run's questions.
     */
    readonly openViews: Effect.Effect<number, BrowserError>
  }
}>()("@wherefore/extension/ChromeApi") {
  /** The real `chrome.*`, via WXT's `browser`. */
  static readonly layer: Layer.Layer<ChromeApi> = Layer.sync(ChromeApi)(() => makeLive())
}

const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

const call = <A>(operation: string, run: () => Promise<A>): Effect.Effect<A, BrowserError> =>
  Effect.tryPromise({ try: run, catch: (cause) => new BrowserError({ operation, message: messageOf(cause) }) })

/** Adds `listener` to `event` for the lifetime of the scope, feeding a queue. */
export const subscribe = <Args extends ReadonlyArray<unknown>, A>(
  event: ChromeEvent<Args>,
  toItem: (...args: Args) => A
): Effect.Effect<Queue.Dequeue<A>, never, Scope.Scope> =>
  Effect.gen(function*() {
    const queue = yield* Queue.unbounded<A>()
    const listener = (...args: Args): void => {
      Queue.offerUnsafe(queue, toItem(...args))
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => event.addListener(listener)),
      () => Effect.sync(() => event.removeListener(listener))
    )
    return queue
  })

const storageArea = (name: "local" | "session"): StorageArea => {
  const area = browser.storage[name]
  return {
    get: (keys) => call(`storage.${name}.get`, () => area.get(keys === null ? null : typeof keys === "string" ? keys : [...keys])),
    set: (items) => call(`storage.${name}.set`, () => area.set({ ...items })),
    remove: (keys) => call(`storage.${name}.remove`, () => area.remove(typeof keys === "string" ? keys : [...keys])),
    changes: subscribe(area.onChanged, (changes: StorageChanges) => changes)
  }
}

const makeLive = (): ChromeApi["Service"] => ({
  tabs: {
    query: (query) => call("tabs.query", () => browser.tabs.query(query)),
    get: (tabId) => call("tabs.get", () => browser.tabs.get(tabId)),
    create: (properties) => call("tabs.create", () => browser.tabs.create(properties)),
    remove: (tabIds) => call("tabs.remove", () => browser.tabs.remove([...tabIds])),
    reload: (tabId) => call("tabs.reload", () => browser.tabs.reload(tabId)),
    group: (tabIds, windowId) =>
      call("tabs.group", () => browser.tabs.group({ tabIds: [...tabIds], createProperties: { windowId } })),
    updates: subscribe(browser.tabs.onUpdated, (tabId: number, info: Browser.tabs.OnUpdatedInfo) => ({
      tabId,
      status: info.status
    }))
  },
  windows: {
    getAll: call("windows.getAll", () => browser.windows.getAll())
  },
  tabGroups: {
    query: (query) => call("tabGroups.query", () => browser.tabGroups.query(query)),
    update: (groupId, properties) => Effect.asVoid(call("tabGroups.update", () => browser.tabGroups.update(groupId, properties)))
  },
  scripting: {
    executeScript: (tabId, func, args) =>
      Effect.map(
        call("scripting.executeScript", () =>
          browser.scripting.executeScript<typeof args, unknown>({ target: { tabId }, func, args })),
        (results): unknown => results[0]?.result
      )
  },
  sessions: {
    getRecentlyClosed: call("sessions.getRecentlyClosed", () => browser.sessions.getRecentlyClosed()),
    restore: (sessionId) => call("sessions.restore", () => browser.sessions.restore(sessionId))
  },
  storage: {
    local: storageArea("local"),
    session: storageArea("session")
  },
  runtime: {
    openViews: Effect.map(
      call("runtime.getContexts", () => browser.runtime.getContexts({ contextTypes: ["SIDE_PANEL", "TAB"] })),
      (contexts) => contexts.length
    )
  }
})

/**
 * An in-memory `ChromeApi` (architecture A8): tabs, windows, groups, Chrome's recently-closed list,
 * page reads and both storage areas, with just enough behavior for the background services.
 *
 * The state lives outside the service, so a test can build a second `TabTools` or `Store` over the
 * same state: that is a worker restart (memory gone, storage and tabs still there).
 */
import { BrowserError } from "@wherefore/core"
import { Effect, Layer, Queue } from "effect"
import type { Browser } from "wxt/browser"
import { ChromeApi, type StorageArea, type StorageChanges, type TabUpdate } from "../../src/chrome/ChromeApi.ts"

export interface FakeTabInit {
  readonly id: number
  readonly windowId: number
  readonly url: string
  readonly title?: string
  readonly discarded?: boolean
  readonly status?: "unloaded" | "loading" | "complete"
  readonly groupId?: number
  readonly pinned?: boolean
  readonly active?: boolean
  readonly audible?: boolean
  readonly openerTabId?: number
  readonly lastAccessed?: number
}

export interface FakeChromeInit {
  readonly tabs?: ReadonlyArray<FakeTabInit>
  readonly groups?: ReadonlyArray<Browser.tabGroups.TabGroup>
  /** What a page read returns per tab id. A `BrowserError` makes the read fail. */
  readonly pages?: Readonly<Record<number, unknown>>
  readonly local?: Readonly<Record<string, unknown>>
  readonly session?: Readonly<Record<string, unknown>>
  /** False: a reloaded tab never reports `complete` (to test the wake timeout). */
  readonly reloadCompletes?: boolean
  /** How many entries `sessions.getRecentlyClosed` keeps (Chrome: 25). */
  readonly maxRecentlyClosed?: number
  /** URLs `tabs.create` refuses, like Chrome does for `file://` without file access. */
  readonly refuseUrls?: ReadonlyArray<string>
}

const tabOf = (init: FakeTabInit, index: number): Browser.tabs.Tab => ({
  id: init.id,
  windowId: init.windowId,
  index,
  url: init.url,
  title: init.title ?? init.url,
  status: init.status ?? "complete",
  discarded: init.discarded ?? false,
  groupId: init.groupId ?? -1,
  pinned: init.pinned ?? false,
  active: init.active ?? false,
  audible: init.audible ?? false,
  highlighted: false,
  frozen: false,
  incognito: false,
  selected: false,
  autoDiscardable: true,
  lastAccessed: init.lastAccessed ?? 0,
  ...(init.openerTabId !== undefined ? { openerTabId: init.openerTabId } : {})
})

const clone = <A>(value: A): A => (value === undefined ? value : JSON.parse(JSON.stringify(value)))

export class FakeChrome {
  readonly tabs: Array<Browser.tabs.Tab> = []
  readonly groups: Array<Browser.tabGroups.TabGroup>
  readonly windows = new Set<number>()
  readonly recentlyClosed: Array<Browser.sessions.Session> = []
  readonly pages = new Map<number, unknown>()
  readonly local = new Map<string, unknown>()
  readonly session = new Map<string, unknown>()
  /** Every call, e.g. "scripting.executeScript 3", for asserting what was (not) touched. */
  readonly calls: Array<string> = []
  reloadCompletes: boolean
  private readonly maxRecentlyClosed: number
  private readonly refuseUrls: ReadonlySet<string>
  private nextTabId = 1000
  private nextGroupId = 1
  private nextSessionId = 1
  private readonly tabListeners = new Set<Queue.Queue<TabUpdate>>()
  private readonly tabsChangedListeners = new Set<() => void>()
  private readonly storageListeners = { local: new Set<Queue.Queue<StorageChanges>>(), session: new Set<Queue.Queue<StorageChanges>>() }

  constructor(init: FakeChromeInit = {}) {
    for (const tab of init.tabs ?? []) {
      const index = this.tabs.filter((t) => t.windowId === tab.windowId).length
      this.tabs.push(tabOf(tab, index))
      this.windows.add(tab.windowId)
    }
    this.groups = [...(init.groups ?? [])]
    for (const [id, page] of Object.entries(init.pages ?? {})) this.pages.set(Number(id), page)
    for (const [key, value] of Object.entries(init.local ?? {})) this.local.set(key, clone(value))
    for (const [key, value] of Object.entries(init.session ?? {})) this.session.set(key, clone(value))
    this.reloadCompletes = init.reloadCompletes ?? true
    this.maxRecentlyClosed = init.maxRecentlyClosed ?? 25
    this.refuseUrls = new Set(init.refuseUrls ?? [])
  }

  /** Calls `listener` after tabs open or close (for a view's fake `PageTabs`). Returns the unsubscribe. */
  onTabsChanged(listener: () => void): () => void {
    this.tabsChangedListeners.add(listener)
    return () => this.tabsChangedListeners.delete(listener)
  }

  private tabsChanged(): void {
    for (const listener of this.tabsChangedListeners) listener()
  }

  tabsIn(windowId: number): Array<Browser.tabs.Tab> {
    return this.tabs.filter((tab) => tab.windowId === windowId).sort((a, b) => a.index - b.index)
  }

  urlsIn(windowId: number): Array<string | undefined> {
    return this.tabsIn(windowId).map((tab) => tab.url)
  }

  private reindex(windowId: number): void {
    this.tabsIn(windowId).forEach((tab, i) => {
      tab.index = i
    })
  }

  private fail(operation: string, message: string) {
    return Effect.fail(new BrowserError({ operation, message }))
  }

  /** Opens a tab like `tabs.create`, synchronously. */
  createTab(properties: Browser.tabs.CreateProperties): Browser.tabs.Tab {
    const windowId = properties.windowId ?? [...this.windows][0] ?? 1
    this.windows.add(windowId)
    const inWindow = this.tabsIn(windowId)
    const index = Math.min(properties.index ?? inWindow.length, inWindow.length)
    for (const tab of inWindow) if (tab.index >= index) tab.index++
    const tab = tabOf({ id: this.nextTabId++, windowId, url: properties.url ?? "chrome://newtab/" }, index)
    tab.active = properties.active ?? true
    this.tabs.push(tab)
    this.tabsChanged()
    return tab
  }

  private remember(session: Omit<Browser.sessions.Session, "lastModified">): void {
    this.recentlyClosed.unshift({ lastModified: 0, ...session })
    this.recentlyClosed.splice(this.maxRecentlyClosed)
  }

  private closeTabs(ids: ReadonlyArray<number>): void {
    const closing = this.tabs.filter((tab) => tab.id !== undefined && ids.includes(tab.id))
    const byWindow = new Map<number, Array<Browser.tabs.Tab>>()
    for (const tab of closing) byWindow.set(tab.windowId, [...(byWindow.get(tab.windowId) ?? []), tab])
    for (const [windowId, closed] of byWindow) {
      const emptied = this.tabsIn(windowId).length === closed.length
      for (const tab of closed) this.tabs.splice(this.tabs.indexOf(tab), 1)
      if (emptied) {
        this.windows.delete(windowId)
        const tabs = closed.sort((a, b) => a.index - b.index).map((tab) => ({ ...tab, sessionId: `s${this.nextSessionId++}` }))
        this.remember({ window: { id: windowId, focused: false, alwaysOnTop: false, incognito: false, sessionId: `w${this.nextSessionId++}`, tabs } })
      } else {
        for (const tab of closed) this.remember({ tab: { ...tab, sessionId: `s${this.nextSessionId++}` } })
        this.reindex(windowId)
      }
    }
    if (closing.length > 0) this.tabsChanged()
  }

  private restoreSession(sessionId: string): Browser.sessions.Session | undefined {
    const at = this.recentlyClosed.findIndex((s) => s.tab?.sessionId === sessionId || s.window?.sessionId === sessionId)
    const session = this.recentlyClosed[at]
    if (session === undefined) return undefined
    this.recentlyClosed.splice(at, 1)
    if (session.tab !== undefined) {
      const windowId = this.windows.has(session.tab.windowId) ? session.tab.windowId : undefined
      const tab = this.createTab({ url: session.tab.url ?? "", index: session.tab.index, ...(windowId !== undefined ? { windowId } : {}) })
      return { lastModified: 0, tab }
    }
    const windowId = Math.max(0, ...this.windows) + 1
    const tabs = (session.window?.tabs ?? []).map((t) => this.createTab({ url: t.url ?? "", windowId }))
    return { lastModified: 0, window: { id: windowId, focused: true, alwaysOnTop: false, incognito: false, tabs } }
  }

  private area(name: "local" | "session"): StorageArea {
    const store = this[name]
    const listeners = this.storageListeners[name]
    const emit = (changes: Record<string, Browser.storage.StorageChange>) => {
      if (Object.keys(changes).length === 0) return
      for (const queue of listeners) Queue.offerUnsafe(queue, changes)
    }
    return {
      get: (keys) =>
        Effect.sync(() => {
          this.calls.push(`storage.${name}.get`)
          const wanted = keys === null ? [...store.keys()] : typeof keys === "string" ? [keys] : keys
          const result: Record<string, unknown> = {}
          for (const key of wanted) if (store.has(key)) result[key] = clone(store.get(key))
          return result
        }),
      set: (items) =>
        Effect.sync(() => {
          this.calls.push(`storage.${name}.set`)
          const changes: Record<string, Browser.storage.StorageChange> = {}
          for (const [key, value] of Object.entries(items)) {
            changes[key] = { oldValue: clone(store.get(key)), newValue: clone(value) }
            store.set(key, clone(value))
          }
          emit(changes)
        }),
      remove: (keys) =>
        Effect.sync(() => {
          const changes: Record<string, Browser.storage.StorageChange> = {}
          for (const key of typeof keys === "string" ? [keys] : keys) {
            if (!store.has(key)) continue
            changes[key] = { oldValue: clone(store.get(key)) }
            store.delete(key)
          }
          emit(changes)
        }),
      changes: Effect.acquireRelease(
        Effect.tap(Queue.unbounded<StorageChanges>(), (queue) => Effect.sync(() => listeners.add(queue))),
        (queue) => Effect.sync(() => listeners.delete(queue))
      )
    }
  }

  readonly api: ChromeApi["Service"] = {
    tabs: {
      query: (query) =>
        Effect.sync(() => {
          this.calls.push("tabs.query")
          return this.tabs
            .filter((tab) => query.windowId === undefined || tab.windowId === query.windowId)
            .map((tab) => ({ ...tab }))
        }),
      get: (tabId) =>
        Effect.suspend(() => {
          const tab = this.tabs.find((t) => t.id === tabId)
          return tab === undefined ? this.fail("tabs.get", `No tab with id: ${tabId}.`) : Effect.succeed({ ...tab })
        }),
      create: (properties) =>
        Effect.suspend(() => {
          this.calls.push(`tabs.create ${properties.windowId ?? "-"} ${properties.url ?? "newtab"}`)
          return properties.url !== undefined && this.refuseUrls.has(properties.url)
            ? this.fail("tabs.create", `Cannot navigate to ${properties.url}.`)
            : Effect.succeed({ ...this.createTab(properties) })
        }),
      remove: (tabIds) =>
        Effect.sync(() => {
          this.calls.push(`tabs.remove ${tabIds.join(",")}`)
          this.closeTabs(tabIds)
        }),
      reload: (tabId) =>
        Effect.suspend(() => {
          this.calls.push(`tabs.reload ${tabId}`)
          const tab = this.tabs.find((t) => t.id === tabId)
          if (tab === undefined) return this.fail("tabs.reload", `No tab with id: ${tabId}.`)
          tab.discarded = false
          tab.status = this.reloadCompletes ? "complete" : "loading"
          if (this.reloadCompletes) for (const queue of this.tabListeners) Queue.offerUnsafe(queue, { tabId, status: "complete" })
          return Effect.void
        }),
      group: (tabIds, windowId) =>
        Effect.sync(() => {
          const id = this.nextGroupId++
          this.groups.push({ id, windowId, collapsed: false, color: "blue", shared: false })
          for (const tab of this.tabs) if (tab.id !== undefined && tabIds.includes(tab.id)) tab.groupId = id
          return id
        }),
      updates: Effect.acquireRelease(
        Effect.tap(Queue.unbounded<TabUpdate>(), (queue) => Effect.sync(() => this.tabListeners.add(queue))),
        (queue) => Effect.sync(() => this.tabListeners.delete(queue))
      )
    },
    windows: {
      getAll: Effect.sync(() =>
        [...this.windows].map((id) => ({ id, focused: false, alwaysOnTop: false, incognito: false }))
      )
    },
    tabGroups: {
      query: () => Effect.sync(() => this.groups.map((group) => ({ ...group }))),
      update: (groupId, properties) =>
        Effect.sync(() => {
          const group = this.groups.find((g) => g.id === groupId)
          if (group !== undefined && properties.title !== undefined) group.title = properties.title
        })
    },
    scripting: {
      executeScript: (tabId) =>
        Effect.suspend(() => {
          this.calls.push(`scripting.executeScript ${tabId}`)
          const page = this.pages.get(tabId)
          return page instanceof BrowserError ? Effect.fail(page) : Effect.succeed(clone(page))
        })
    },
    sessions: {
      getRecentlyClosed: Effect.sync(() => this.recentlyClosed.map((session) => clone(session))),
      restore: (sessionId) =>
        Effect.suspend(() => {
          this.calls.push(`sessions.restore ${sessionId}`)
          const restored = this.restoreSession(sessionId)
          return restored === undefined
            ? this.fail("sessions.restore", `Invalid session id: "${sessionId}".`)
            : Effect.succeed(restored)
        })
    },
    storage: {
      local: this.area("local"),
      session: this.area("session")
    }
  }

  get layer(): Layer.Layer<ChromeApi> {
    return Layer.succeed(ChromeApi)(this.api)
  }
}

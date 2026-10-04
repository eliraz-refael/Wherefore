/**
 * The worker's tab tools (architecture A4): list, read and wake tabs for the model, close tabs
 * with undo, and reopen a saved item's tabs as a group. Ported from the POC (lib/tabs.ts,
 * lib/page.ts, lib/closing.ts), with every browser call going through `ChromeApi`.
 *
 * Privacy rules (story.md, "Private by default"): sensitive pages (core `isSensitive`) are never
 * read or woken, every URL the model can see is redacted (core `redactUrl`), and page text is
 * untrusted data, decoded and clamped before use.
 *
 * Undo survives the worker: the worker can be stopped between a close and its undo, so the
 * closed tabs are recorded in `chrome.storage.session` under `undo:<token>` before any tab is
 * closed. A record expires after `UNDO_TTL`; expired records are dropped on the next close.
 */
import {
  BrowserError,
  type CloseResult,
  isSensitive,
  type PageContent,
  type PageRead,
  redactUrl,
  type ResumeResult,
  type SavedItem,
  TabId,
  type TabRemap,
  type TabSnapshot,
  UndoToken,
  type UndoResult,
  UndoUnavailable,
  WindowId
} from "@wherefore/core"
import { Clock, Context, Duration, Effect, Layer, Option, Queue, Schema, Semaphore } from "effect"
import type { Browser } from "wxt/browser"
import { ChromeApi } from "../chrome/ChromeApi.ts"
import { extractPage, RawPage } from "./extractPage.ts"

/** How long a close can be undone. The UI's undo toast is shorter; this bounds what we keep. */
export const UNDO_TTL = Duration.minutes(10)
/** How long waking a tab waits for it to finish loading before reading what is there. */
export const WAKE_TIMEOUT = Duration.seconds(15)
export const UNDO_KEY_PREFIX = "undo:"

const ClosedTab = Schema.Struct({
  id: TabId,
  url: Schema.String,
  windowId: Schema.Int,
  index: Schema.Int
})
type ClosedTab = typeof ClosedTab.Type

/** What `undo:<token>` holds in session storage. */
export const UndoRecord = Schema.Struct({
  /** Epoch milliseconds. */
  expiresAt: Schema.Number,
  tabs: Schema.Array(ClosedTab)
})
export type UndoRecord = typeof UndoRecord.Type

export class TabTools extends Context.Service<TabTools, {
  /** Every open tab, POC shape, with Chrome's window ids and redacted URLs. */
  readonly listTabs: Effect.Effect<ReadonlyArray<TabSnapshot>, BrowserError>
  /** Reads tabs in place. A tab that can't be read gets an error entry; the call itself never fails. */
  readonly readPages: (tabIds: ReadonlyArray<TabId>, maxChars: number) => Effect.Effect<ReadonlyArray<PageRead>>
  /** Like `readPages`, but reloads sleeping tabs first (in the background, without focusing them). */
  readonly wakeAndReadPages: (tabIds: ReadonlyArray<TabId>, maxChars: number) => Effect.Effect<ReadonlyArray<PageRead>>
  /**
   * Closes tabs and returns an undo token. If that would close every tab in `keepWindowAlive`
   * (the caller's window), a new tab is opened there first, so the window and its side panel stay.
   */
  readonly closeTabs: (
    tabIds: ReadonlyArray<TabId>,
    options: { readonly keepWindowAlive: WindowId }
  ) => Effect.Effect<CloseResult, BrowserError>
  /**
   * Brings closed tabs back: from Chrome's recently-closed list when it still has them (history
   * and scroll position intact), otherwise by reopening their URLs where they were. One-shot.
   */
  readonly undoClose: (token: UndoToken) => Effect.Effect<UndoResult, UndoUnavailable | BrowserError>
  /** Opens a saved item's tabs in `windowId` as a tab group named after its task. */
  readonly reopenTabs: (
    item: SavedItem,
    options: { readonly windowId: WindowId }
  ) => Effect.Effect<ResumeResult, BrowserError>
}>()("@wherefore/extension/TabTools") {
  static readonly layer: Layer.Layer<TabTools, never, ChromeApi> = Layer.effect(TabTools)(
    Effect.gen(function*() {
      return make(yield* ChromeApi)
    })
  )
}

// ---------- helpers ----------

const urlOf = (tab: Browser.tabs.Tab): string => tab.url ?? tab.pendingUrl ?? ""

/** Discarded by the memory saver, or not loaded yet since the browser started. */
const isAsleep = (tab: Browser.tabs.Tab): boolean => tab.discarded || tab.status === "unloaded"

const ago = (now: number, then: number | undefined): string | undefined => {
  if (then === undefined || then <= 0) return undefined
  const minutes = Math.max(0, Math.round((now - then) / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/** Same page for duplicate detection: the URL without its fragment. */
const dedupeKey = (url: string): string => url.split("#")[0] ?? url

const clampInt = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, Math.round(value)))

/** The page as the model may see it: redacted URL, every field clamped. */
const toPageContent = (id: TabId, raw: RawPage, maxChars: number): PageContent => ({
  id,
  title: raw.title.slice(0, 300),
  url: redactUrl(raw.url),
  headings: raw.headings.slice(0, 8).map((heading) => heading.slice(0, 200)),
  description: raw.description.slice(0, 500),
  text: raw.text.slice(0, maxChars),
  scrollPct: raw.scrollPct === null ? null : clampInt(raw.scrollPct, 0, 100),
  media: raw.media === null ? null : {
    currentSec: clampInt(raw.media.currentSec, 0, Number.MAX_SAFE_INTEGER),
    durationSec: clampInt(raw.media.durationSec, 0, Number.MAX_SAFE_INTEGER)
  },
  selection: raw.selection.slice(0, 500)
})

const decodeRawPage = Schema.decodeUnknownOption(RawPage)
const decodeUndoRecord = Schema.decodeUnknownOption(UndoRecord)
const encodeUndoRecord = Schema.encodeSync(UndoRecord)

const undoKey = (token: UndoToken): string => `${UNDO_KEY_PREFIX}${token}`

const newUndoToken = Effect.sync(() => UndoToken.make(crypto.randomUUID()))

// ---------- the service ----------

export const make = (chrome: ChromeApi["Service"]): TabTools["Service"] => {
  const listTabs = Effect.gen(function*() {
    const [tabs, groups, now] = yield* Effect.all([
      chrome.tabs.query({}),
      chrome.tabGroups.query({}),
      Clock.currentTimeMillis
    ], { concurrency: "unbounded" })
    const groupTitle = new Map(groups.map((group) => [group.id, group.title || `(${group.color} group)`]))
    const firstByUrl = new Map<string, TabId>()
    const snapshots: Array<TabSnapshot> = []
    for (const tab of tabs) {
      if (tab.id === undefined || tab.id < 0 || tab.windowId < 0) continue
      const id = TabId.make(tab.id)
      const url = urlOf(tab)
      const key = dedupeKey(url)
      const duplicateOf = firstByUrl.get(key)
      if (duplicateOf === undefined) firstByUrl.set(key, id)
      const group = tab.groupId > -1 ? groupTitle.get(tab.groupId) : undefined
      const lastUsed = ago(now, tab.lastAccessed)
      snapshots.push({
        id,
        window: WindowId.make(tab.windowId),
        index: Math.max(0, tab.index),
        title: (tab.title ?? "").slice(0, 160),
        url: redactUrl(url),
        ...(group !== undefined && group !== "" ? { group } : {}),
        ...(tab.pinned ? { pinned: true } : {}),
        ...(tab.active ? { active: true } : {}),
        ...(isAsleep(tab) ? { asleep: true } : {}),
        ...(tab.audible === true ? { audible: true } : {}),
        ...(tab.openerTabId !== undefined && tab.openerTabId >= 0 ? { openedFrom: TabId.make(tab.openerTabId) } : {}),
        ...(lastUsed !== undefined ? { lastUsed } : {}),
        ...(duplicateOf !== undefined ? { duplicateOf } : {}),
        ...(isSensitive(url) ? { sensitive: true } : {})
      })
    }
    return snapshots
  })

  const readPage = (id: TabId, maxChars: number): Effect.Effect<PageRead> =>
    Effect.gen(function*() {
      const found = yield* Effect.option(chrome.tabs.get(id))
      if (Option.isNone(found)) return { id, error: "tab no longer exists" }
      const tab = found.value
      if (isSensitive(urlOf(tab))) return { id, error: "sensitive page - not read by policy" }
      if (isAsleep(tab)) return { id, error: "asleep (discarded by memory saver) - use wake_and_read_pages" }
      const result = yield* Effect.result(chrome.scripting.executeScript(id, extractPage, [maxChars]))
      if (result._tag === "Failure") return { id, error: `cannot read: ${result.failure.message}` }
      if (result.success === undefined || result.success === null) {
        return { id, error: "no result (page may still be loading)" }
      }
      const raw = decodeRawPage(result.success)
      if (Option.isNone(raw)) return { id, error: "cannot read: unexpected result from the page" }
      // The tab may have navigated since the check above.
      if (isSensitive(raw.value.url)) return { id, error: "sensitive page - not read by policy" }
      return toPageContent(id, raw.value, maxChars)
    })

  /** Resolves when the tab reports `complete`, or after `WAKE_TIMEOUT`. Subscribes before reloading. */
  const reloadAndWait = (id: TabId) =>
    Effect.scoped(Effect.gen(function*() {
      const updates = yield* chrome.tabs.updates
      yield* chrome.tabs.reload(id)
      yield* Effect.gen(function*() {
        while (true) {
          const update = yield* Queue.take(updates)
          if (update.tabId === id && update.status === "complete") return
        }
      }).pipe(Effect.timeoutOption(WAKE_TIMEOUT))
    }))

  const wakeAndRead = (id: TabId, maxChars: number): Effect.Effect<PageRead> =>
    Effect.gen(function*() {
      const found = yield* Effect.option(chrome.tabs.get(id))
      if (Option.isNone(found)) return { id, error: "tab no longer exists" }
      const before = urlOf(found.value)
      if (isSensitive(before)) return { id, error: "sensitive page - not woken by policy" }
      if (!isAsleep(found.value)) return yield* readPage(id, maxChars)
      const reloaded = yield* Effect.result(reloadAndWait(id))
      if (reloaded._tag === "Failure") return { id, error: `cannot wake: ${reloaded.failure.message}` }
      const read = yield* readPage(id, maxChars)
      if ("error" in read || read.url === redactUrl(before)) return read
      // Reloading can redirect (an expired session lands on a login page). Tell the model.
      return { ...read, description: `[redirected on reload from ${redactUrl(before)}] ${read.description}` }
    })

  const readPages = (tabIds: ReadonlyArray<TabId>, maxChars: number) =>
    Effect.forEach(tabIds, (id) => readPage(id, maxChars), { concurrency: 8 })

  const wakeAndReadPages = (tabIds: ReadonlyArray<TabId>, maxChars: number) =>
    Effect.forEach(tabIds, (id) => wakeAndRead(id, maxChars), { concurrency: 4 })

  // ---------- close and undo ----------

  const purgeExpiredUndo = Effect.gen(function*() {
    const now = yield* Clock.currentTimeMillis
    const all = yield* chrome.storage.session.get(null)
    const stale = Object.entries(all)
      .filter(([key, value]) =>
        key.startsWith(UNDO_KEY_PREFIX) &&
        Option.match(decodeUndoRecord(value), { onNone: () => true, onSome: (record) => record.expiresAt <= now })
      )
      .map(([key]) => key)
    if (stale.length > 0) yield* chrome.storage.session.remove(stale)
  })

  const closeTabs = (tabIds: ReadonlyArray<TabId>, options: { readonly keepWindowAlive: WindowId }) =>
    Effect.gen(function*() {
      const found = yield* Effect.forEach(
        tabIds,
        (id) => Effect.option(chrome.tabs.get(id)),
        { concurrency: "unbounded" }
      )
      const tabs: Array<ClosedTab> = []
      const missing: Array<TabId> = []
      tabIds.forEach((id, i) => {
        const tab = found[i]
        if (tab === undefined || Option.isNone(tab)) missing.push(id)
        else tabs.push({ id, url: urlOf(tab.value), windowId: tab.value.windowId, index: tab.value.index })
      })
      if (tabs.length === 0) return { closed: [], missing, undo: null }

      const closing = new Set<number>(tabs.map((tab) => tab.id))
      const inWindow = yield* chrome.tabs.query({ windowId: options.keepWindowAlive })
      if (inWindow.length > 0 && inWindow.every((tab) => tab.id !== undefined && closing.has(tab.id))) {
        // Closing every tab here would close the window, and the side panel (and its undo) with it.
        yield* chrome.tabs.create({ windowId: options.keepWindowAlive, active: true })
      }

      const token = yield* newUndoToken
      const now = yield* Clock.currentTimeMillis
      const record: UndoRecord = { expiresAt: now + Duration.toMillis(UNDO_TTL), tabs }
      // The record is written before any tab closes, so a worker stopped right after the close
      // can still undo it.
      yield* chrome.storage.session.set({ [undoKey(token)]: encodeUndoRecord(record) })
      yield* chrome.tabs.remove(tabs.map((tab) => tab.id)).pipe(
        Effect.tapError(() => Effect.ignore(chrome.storage.session.remove(undoKey(token))))
      )
      yield* Effect.ignore(purgeExpiredUndo)
      return { closed: tabs.map((tab) => tab.id), missing, undo: token }
    }).pipe(Effect.uninterruptible)

  /** Restores closed tabs; returns old id -> new id, and the ones that couldn't come back. */
  const restore = (closed: ReadonlyArray<ClosedTab>) =>
    Effect.gen(function*() {
      const restored: Array<TabRemap> = []
      const failed: Array<TabId> = []
      const pending = new Map<string, Array<ClosedTab>>()
      for (const tab of closed) pending.set(tab.url, [...(pending.get(tab.url) ?? []), tab])
      const take = (url: string | undefined) => pending.get(url ?? "")?.shift()
      const putBack = (tab: ClosedTab) => pending.set(tab.url, [tab, ...(pending.get(tab.url) ?? [])])
      /** True when every URL in `urls` is pending at least as many times as it appears. */
      const allPending = (urls: ReadonlyArray<string>) => {
        const needed = new Map<string, number>()
        for (const url of urls) needed.set(url, (needed.get(url) ?? 0) + 1)
        return [...needed].every(([url, count]) => (pending.get(url)?.length ?? 0) >= count)
      }

      const sessions = yield* chrome.sessions.getRecentlyClosed.pipe(Effect.orElseSucceed(() => []))
      for (const session of sessions) {
        const { tab, window } = session
        if (tab?.sessionId !== undefined && (pending.get(tab.url ?? "")?.length ?? 0) > 0) {
          const old = take(tab.url)
          if (old === undefined) continue
          const back = yield* Effect.option(chrome.sessions.restore(tab.sessionId))
          const newId = Option.getOrUndefined(back)?.tab?.id
          if (newId !== undefined) restored.push({ from: old.id, to: TabId.make(newId) })
          else putBack(old)
        } else if (
          window?.sessionId !== undefined && window.tabs !== undefined && window.tabs.length > 0 &&
          allPending(window.tabs.map((t) => t.url ?? ""))
        ) {
          // A whole window shows up here when we closed all of its tabs; restore it only if all are ours.
          const olds = window.tabs.map((t) => take(t.url))
          const back = yield* Effect.option(chrome.sessions.restore(window.sessionId))
          const newTabs = Option.getOrUndefined(back)?.window?.tabs ?? []
          olds.forEach((old, i) => {
            if (old === undefined) return
            const newId = newTabs[i]?.id
            if (newId !== undefined) restored.push({ from: old.id, to: TabId.make(newId) })
            else putBack(old)
          })
        }
      }

      // Whatever the recently-closed list no longer had (it keeps 25 entries): reopen by URL where it was.
      const windows = new Set((yield* chrome.windows.getAll).map((window) => window.id))
      const rest = [...pending.values()].flat().sort((a, b) => a.windowId - b.windowId || a.index - b.index)
      for (const tab of rest) {
        if (tab.url === "") {
          failed.push(tab.id)
          continue
        }
        const where = windows.has(tab.windowId) ? { windowId: tab.windowId, index: tab.index } : {}
        const created = yield* Effect.option(chrome.tabs.create({ url: tab.url, active: false, ...where }))
        const newId = Option.getOrUndefined(created)?.id
        if (newId !== undefined) restored.push({ from: tab.id, to: TabId.make(newId) })
        else failed.push(tab.id)
      }
      return { restored, failed }
    })

  const undoLock = Semaphore.makeUnsafe(1)

  const undoClose = (token: UndoToken) =>
    Effect.gen(function*() {
      const key = undoKey(token)
      const stored = yield* chrome.storage.session.get(key)
      const record = decodeUndoRecord(stored[key])
      if (Option.isNone(record)) {
        if (key in stored) yield* chrome.storage.session.remove(key)
        return yield* new UndoUnavailable({ reason: "unknown" })
      }
      const now = yield* Clock.currentTimeMillis
      if (record.value.expiresAt <= now) {
        yield* chrome.storage.session.remove(key)
        return yield* new UndoUnavailable({ reason: "expired" })
      }
      const result = yield* restore(record.value.tabs)
      yield* chrome.storage.session.remove(key)
      return result
    }).pipe(Effect.uninterruptible, Semaphore.withPermit(undoLock))

  // ---------- resume ----------

  const reopenTabs = (item: SavedItem, options: { readonly windowId: WindowId }) =>
    Effect.gen(function*() {
      const created = yield* Effect.forEach(
        item.tabs,
        (tab, i) => chrome.tabs.create({ url: tab.url, windowId: options.windowId, active: i === 0 })
      )
      const tabIds = created.flatMap((tab) => (tab.id === undefined ? [] : [TabId.make(tab.id)]))
      const [first, ...others] = tabIds
      if (first === undefined) return { tabIds, groupId: null }
      const groupId = yield* chrome.tabs.group([first, ...others], options.windowId)
      yield* chrome.tabGroups.update(groupId, { title: item.task.slice(0, 40) })
      return { tabIds, groupId }
    })

  return { listTabs, readPages, wakeAndReadPages, closeTabs, undoClose, reopenTabs }
}

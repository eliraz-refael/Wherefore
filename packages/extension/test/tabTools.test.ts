import { assert, describe, expect, it } from "@effect/vitest"
import { BrowserError, type PageContent, type PageRead, type SavedItem, SavedItemId, TabId, UndoToken, WindowId } from "@wherefore/core"
import { DateTime, Duration, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { make, UNDO_KEY_PREFIX, UNDO_TTL, WAKE_TIMEOUT } from "../src/background/TabTools.ts"
import { FakeChrome } from "./fakes/chrome.ts"

const tabId = (n: number) => TabId.make(n)
const windowId = (n: number) => WindowId.make(n)

const page = (url: string, text = "Hello world") => ({
  title: "A page",
  url,
  headings: ["Heading"],
  description: "Description",
  text,
  scrollPct: 40,
  media: null,
  selection: ""
})

const isError = (read: PageRead | undefined): boolean => read === undefined || "error" in read

/** The page content of a successful read; fails the test otherwise. */
const contentOf = (read: PageRead | undefined): PageContent => {
  if (read === undefined || "error" in read) throw new Error(`expected page content, got ${JSON.stringify(read)}`)
  return read
}

describe("TabTools.listTabs", () => {
  it.effect("returns POC-shaped snapshots with Chrome's window ids and redacted URLs", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Date.parse("2026-10-04T12:00:00Z"))
      const chrome = new FakeChrome({
        tabs: [
          { id: 1, windowId: 7, url: "https://github.com/acme/api/pull/412", active: true, groupId: 3, lastAccessed: Date.parse("2026-10-04T11:30:00Z") },
          { id: 2, windowId: 7, url: "https://example.com/reset?token=abc123&page=2", discarded: true, openerTabId: 1 },
          { id: 3, windowId: 9, url: "https://mail.google.com/mail/u/0/#inbox", pinned: true, lastAccessed: Date.parse("2026-10-01T12:00:00Z") },
          { id: 4, windowId: 9, url: "https://github.com/acme/api/pull/412#discussion", audible: true }
        ],
        groups: [{ id: 3, windowId: 7, title: "Review", color: "blue", collapsed: false, shared: false }]
      })
      const tabs = yield* make(chrome.api).listTabs
      expect(tabs).toEqual([
        { id: 1, window: 7, index: 0, title: "https://github.com/acme/api/pull/412", url: "https://github.com/acme/api/pull/412", group: "Review", active: true, lastUsed: "30m ago" },
        { id: 2, window: 7, index: 1, title: "https://example.com/reset?token=abc123&page=2", url: "https://example.com/reset?token=REDACTED&page=2", asleep: true, openedFrom: 1 },
        { id: 3, window: 9, index: 0, title: "https://mail.google.com/mail/u/0/#inbox", url: "https://mail.google.com/mail/u/0/#inbox", pinned: true, lastUsed: "3d ago", sensitive: true },
        { id: 4, window: 9, index: 1, title: "https://github.com/acme/api/pull/412#discussion", url: "https://github.com/acme/api/pull/412#discussion", audible: true, duplicateOf: 1 }
      ])
    }))
})

describe("TabTools.readPages", () => {
  it.effect("reads a page, redacts its URL and clamps its text", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({
        tabs: [{ id: 1, windowId: 1, url: "https://example.com/doc?sig=secret" }],
        pages: { 1: page("https://example.com/doc?sig=secret", "x".repeat(5000)) }
      })
      const read = contentOf((yield* make(chrome.api).readPages([tabId(1)], 300))[0])
      expect(read.url).toBe("https://example.com/doc?sig=REDACTED")
      expect(read.text).toHaveLength(300)
      expect(read.scrollPct).toBe(40)
    }))

  it.effect("never reads a sensitive host", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({
        tabs: [{ id: 1, windowId: 1, url: "https://mail.google.com/mail/u/0/" }, { id: 2, windowId: 1, url: "http://localhost:3000/" }],
        pages: { 1: page("https://mail.google.com/mail/u/0/"), 2: page("http://localhost:3000/") }
      })
      const reads = yield* make(chrome.api).readPages([tabId(1), tabId(2)], 1500)
      expect(reads).toEqual([
        { id: 1, error: "sensitive page - not read by policy" },
        { id: 2, error: "sensitive page - not read by policy" }
      ])
      expect(chrome.calls.filter((call) => call.startsWith("scripting"))).toEqual([])
    }))

  it.effect("refuses a page that turned out to be sensitive after injection", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({
        tabs: [{ id: 1, windowId: 1, url: "https://example.com/" }],
        pages: { 1: page("https://accounts.google.com/signin") }
      })
      const [read] = yield* make(chrome.api).readPages([tabId(1)], 1500)
      expect(read).toEqual({ id: 1, error: "sensitive page - not read by policy" })
    }))

  it.effect("reports gone, asleep, failing and malformed pages per tab", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({
        tabs: [
          { id: 1, windowId: 1, url: "https://a.example/", discarded: true },
          { id: 2, windowId: 1, url: "https://b.example/" },
          { id: 3, windowId: 1, url: "https://c.example/" },
          { id: 4, windowId: 1, url: "https://d.example/" }
        ],
        pages: {
          2: new BrowserError({ operation: "scripting.executeScript", message: "Cannot access a chrome:// URL" }),
          3: { title: 42 },
          4: null
        }
      })
      const reads = yield* make(chrome.api).readPages([tabId(1), tabId(2), tabId(3), tabId(4), tabId(5)], 1500)
      expect(reads).toEqual([
        { id: 1, error: "asleep (discarded by memory saver) - use wake_and_read_pages" },
        { id: 2, error: "cannot read: Cannot access a chrome:// URL" },
        { id: 3, error: "cannot read: unexpected result from the page" },
        { id: 4, error: "no result (page may still be loading)" },
        { id: 5, error: "tab no longer exists" }
      ])
    }))
})

describe("TabTools.wakeAndReadPages", () => {
  it.effect("reloads a sleeping tab, then reads it and notes a redirect", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({
        tabs: [{ id: 1, windowId: 1, url: "https://app.example/doc/1?code=xyz", discarded: true }],
        pages: { 1: page("https://app.example/login") }
      })
      const read = contentOf((yield* make(chrome.api).wakeAndReadPages([tabId(1)], 1500))[0])
      expect(chrome.calls).toContain("tabs.reload 1")
      expect(read.description).toBe("[redirected on reload from https://app.example/doc/1?code=REDACTED] Description")
    }))

  it.effect("never wakes a sensitive tab, and reads an awake tab without reloading it", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({
        tabs: [
          { id: 1, windowId: 1, url: "https://web.whatsapp.com/", discarded: true },
          { id: 2, windowId: 1, url: "https://example.com/" }
        ],
        pages: { 2: page("https://example.com/") }
      })
      const [sensitive, awake] = yield* make(chrome.api).wakeAndReadPages([tabId(1), tabId(2)], 1500)
      expect(sensitive).toEqual({ id: 1, error: "sensitive page - not woken by policy" })
      expect(isError(awake)).toBe(false)
      expect(chrome.calls.filter((call) => call.startsWith("tabs.reload"))).toEqual([])
    }))

  it.effect("reads what is there when the reload doesn't finish in time", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({
        tabs: [{ id: 1, windowId: 1, url: "https://slow.example/", discarded: true }],
        pages: { 1: page("https://slow.example/") },
        reloadCompletes: false
      })
      const fiber = yield* Effect.forkChild(make(chrome.api).wakeAndReadPages([tabId(1)], 1500))
      yield* TestClock.adjust(Duration.toMillis(WAKE_TIMEOUT))
      const [read] = yield* Fiber.join(fiber)
      expect(isError(read)).toBe(false)
    }))
})

describe("TabTools.closeTabs", () => {
  it.effect("keeps the caller's window open when closing all of its tabs", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({
        tabs: [
          { id: 1, windowId: 1, url: "https://a.example/" },
          { id: 2, windowId: 1, url: "https://b.example/" },
          { id: 3, windowId: 2, url: "https://c.example/" }
        ]
      })
      const result = yield* make(chrome.api).closeTabs([tabId(1), tabId(2), tabId(3), tabId(99)], { keepWindowAlive: windowId(1) })
      expect(result.closed).toEqual([1, 2, 3])
      expect(result.missing).toEqual([99])
      assert(result.undo !== null)
      // A new tab was opened in window 1 before closing; window 2 (not the caller's) closed.
      expect(chrome.urlsIn(1)).toEqual(["chrome://newtab/"])
      expect(chrome.windows.has(2)).toBe(false)
      const createdAt = chrome.calls.indexOf("tabs.create 1 newtab")
      const removedAt = chrome.calls.findIndex((call) => call.startsWith("tabs.remove"))
      expect(createdAt).toBeGreaterThanOrEqual(0)
      expect(createdAt).toBeLessThan(removedAt)
    }))

  it.effect("opens no extra tab when the caller's window keeps a tab", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({
        tabs: [{ id: 1, windowId: 1, url: "https://a.example/" }, { id: 2, windowId: 1, url: "https://b.example/" }]
      })
      yield* make(chrome.api).closeTabs([tabId(1)], { keepWindowAlive: windowId(1) })
      expect(chrome.urlsIn(1)).toEqual(["https://b.example/"])
    }))

  it.effect("closes and records a repeated id once, so undo brings the tab back once", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({
        tabs: [{ id: 1, windowId: 1, url: "https://keep.example/" }, { id: 2, windowId: 1, url: "https://a.example/" }]
      })
      const tools = make(chrome.api)
      const { closed, undo } = yield* tools.closeTabs([tabId(2), tabId(2)], { keepWindowAlive: windowId(1) })
      expect(closed).toEqual([2])
      assert(undo !== null)
      chrome.recentlyClosed.length = 0
      const result = yield* tools.undoClose(undo)
      expect(result.restored.map(({ from }) => from)).toEqual([2])
      expect(chrome.urlsIn(1)).toEqual(["https://keep.example/", "https://a.example/"])
    }))

  it.effect("returns no undo token when nothing was open", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome()
      const result = yield* make(chrome.api).closeTabs([tabId(5)], { keepWindowAlive: windowId(1) })
      expect(result).toEqual({ closed: [], missing: [5], undo: null })
      expect(chrome.session.size).toBe(0)
    }))
})

describe("TabTools.undoClose", () => {
  it.effect("undoes a close after a worker restart, remapping tab ids", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({
        tabs: [
          { id: 1, windowId: 1, url: "https://keep.example/" },
          { id: 2, windowId: 1, url: "https://a.example/" },
          { id: 3, windowId: 2, url: "https://b.example/" },
          { id: 4, windowId: 2, url: "https://c.example/" }
        ]
      })
      const { undo } = yield* make(chrome.api).closeTabs([tabId(2), tabId(3), tabId(4)], { keepWindowAlive: windowId(1) })
      assert(undo !== null)
      expect([...chrome.session.keys()]).toEqual([`${UNDO_KEY_PREFIX}${undo}`])

      // The worker is stopped: a fresh TabTools over the same browser state.
      const afterRestart = make(chrome.api)
      const result = yield* afterRestart.undoClose(undo)
      expect(result.failed).toEqual([])
      expect(result.restored.map(({ from }) => from).sort()).toEqual([2, 3, 4])
      for (const { from, to } of result.restored) expect(to).not.toBe(from)
      // Tab 2 came back from the recently-closed list, the emptied window as a whole.
      expect(chrome.calls.filter((call) => call.startsWith("sessions.restore"))).toHaveLength(2)
      expect(chrome.urlsIn(1)).toEqual(["https://keep.example/", "https://a.example/"])
      expect(chrome.session.size).toBe(0)

      const again = yield* Effect.flip(afterRestart.undoClose(undo))
      expect(again).toMatchObject({ _tag: "UndoUnavailable", reason: "unknown" })
    }))

  it.effect("reopens by URL where the recently-closed list no longer has a tab", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({
        tabs: [
          { id: 1, windowId: 1, url: "https://keep.example/" },
          { id: 2, windowId: 1, url: "https://a.example/" },
          { id: 3, windowId: 1, url: "https://b.example/" }
        ]
      })
      const tools = make(chrome.api)
      const { undo } = yield* tools.closeTabs([tabId(2), tabId(3)], { keepWindowAlive: windowId(1) })
      assert(undo !== null)
      chrome.recentlyClosed.length = 0
      const result = yield* tools.undoClose(undo)
      expect(result.restored.map(({ from }) => from)).toEqual([2, 3])
      expect(chrome.urlsIn(1)).toEqual(["https://keep.example/", "https://a.example/", "https://b.example/"])
    }))

  it.effect("expires, and expired records are dropped", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({
        tabs: [
          { id: 1, windowId: 1, url: "https://keep.example/" },
          { id: 2, windowId: 1, url: "https://a.example/" },
          { id: 3, windowId: 1, url: "https://b.example/" }
        ]
      })
      const tools = make(chrome.api)
      const first = yield* tools.closeTabs([tabId(2)], { keepWindowAlive: windowId(1) })
      assert(first.undo !== null)
      yield* TestClock.adjust(Duration.toMillis(UNDO_TTL) + 1)

      // The next close drops the expired record.
      const second = yield* tools.closeTabs([tabId(3)], { keepWindowAlive: windowId(1) })
      assert(second.undo !== null)
      expect([...chrome.session.keys()]).toEqual([`${UNDO_KEY_PREFIX}${second.undo}`])

      const expired = yield* Effect.flip(tools.undoClose(first.undo))
      expect(expired).toMatchObject({ _tag: "UndoUnavailable", reason: "unknown" })
      yield* TestClock.adjust(Duration.toMillis(UNDO_TTL) + 1)
      const late = yield* Effect.flip(tools.undoClose(second.undo))
      expect(late).toMatchObject({ _tag: "UndoUnavailable", reason: "expired" })
      expect(chrome.session.size).toBe(0)
      expect(chrome.urlsIn(1)).toEqual(["https://keep.example/"])
    }))

  it.effect("reports the tabs it could not restore, and cannot be used twice", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({
        tabs: [
          { id: 1, windowId: 1, url: "https://keep.example/" },
          { id: 2, windowId: 1, url: "https://a.example/" },
          { id: 3, windowId: 1, url: "file:///notes.txt" }
        ],
        refuseUrls: ["file:///notes.txt"]
      })
      const tools = make(chrome.api)
      const { undo } = yield* tools.closeTabs([tabId(2), tabId(3)], { keepWindowAlive: windowId(1) })
      assert(undo !== null)
      chrome.recentlyClosed.length = 0
      const result = yield* tools.undoClose(undo)
      expect(result.restored.map(({ from }) => from)).toEqual([2])
      expect(result.failed).toEqual([3])
      expect(chrome.session.size).toBe(0)
      // A retry can't bring tab 2 back a second time.
      const again = yield* Effect.flip(tools.undoClose(undo))
      expect(again).toMatchObject({ _tag: "UndoUnavailable", reason: "unknown" })
      expect(chrome.urlsIn(1)).toEqual(["https://keep.example/", "https://a.example/"])
    }))

  it.effect("rejects a token it never issued", () =>
    Effect.gen(function*() {
      const error = yield* Effect.flip(make(new FakeChrome().api).undoClose(UndoToken.make("nope")))
      expect(error).toMatchObject({ _tag: "UndoUnavailable", reason: "unknown" })
    }))
})

describe("TabTools.reopenTabs", () => {
  it.effect("opens an item's tabs in the given window as a named group", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({ tabs: [{ id: 1, windowId: 4, url: "https://keep.example/" }] })
      const item: SavedItem = {
        id: SavedItemId.make("item-1"),
        tag: "do",
        title: "Auth PR review",
        task: "Finish reviewing the auth PR and leave comments for Dana",
        intention: "Finish reviewing the auth PR",
        why: "Review requested",
        tabs: [
          { title: "PR", url: "https://github.com/acme/api/pull/412", domain: "github.com" },
          { title: "RFC", url: "https://www.rfc-editor.org/rfc/rfc6749", domain: "rfc-editor.org" }
        ],
        status: "open",
        savedAt: DateTime.makeUnsafe("2026-10-04T09:30:00.000Z")
      }
      const result = yield* make(chrome.api).reopenTabs(item, { windowId: windowId(4) })
      expect(result.tabIds).toHaveLength(2)
      expect(chrome.urlsIn(4)).toEqual([
        "https://keep.example/",
        "https://github.com/acme/api/pull/412",
        "https://www.rfc-editor.org/rfc/rfc6749"
      ])
      const group = chrome.groups.find((g) => g.id === result.groupId)
      expect(group?.title).toBe("Finish reviewing the auth PR and leave c")
      expect(chrome.tabs.filter((tab) => tab.groupId === result.groupId).map((tab) => tab.id)).toEqual([...result.tabIds])
    }))
})

describe("TabTools.reopenTabs with a refused URL", () => {
  it.effect("skips the tab Chrome refuses and groups the rest", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({
        tabs: [{ id: 1, windowId: 4, url: "https://keep.example/" }],
        refuseUrls: ["file:///notes.txt"]
      })
      const item: SavedItem = {
        id: SavedItemId.make("item-2"),
        tag: "read",
        title: "Notes",
        task: "Read the notes",
        intention: "Read the notes",
        why: "Saved for later",
        tabs: [
          { title: "Notes", url: "file:///notes.txt", domain: "" },
          { title: "Post", url: "https://blog.example/post", domain: "blog.example" }
        ],
        status: "open",
        savedAt: DateTime.makeUnsafe("2026-10-04T09:30:00.000Z")
      }
      const result = yield* make(chrome.api).reopenTabs(item, { windowId: windowId(4) })
      expect(result.tabIds).toHaveLength(1)
      assert(result.groupId !== null)
      expect(chrome.urlsIn(4)).toEqual(["https://keep.example/", "https://blog.example/post"])
      expect(chrome.tabs.filter((tab) => tab.groupId === result.groupId).map((tab) => tab.id)).toEqual([...result.tabIds])
    }))
})

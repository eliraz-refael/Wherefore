import { describe, expect, it } from "@effect/vitest"
import { DateTime, Option } from "effect"
import {
  dispositionOf,
  type IntentionKind,
  newSavedItem,
  SavedItem,
  SavedItemId,
  type SavedTab,
  markDone,
  removeItem,
  removeTab,
  reopen,
  restoreItem,
  restoreTab,
  TabRemoval,
  trackerTypeLabel
} from "../src/index.ts"
import { decodeOk, encodeOk, rejects } from "./helpers.ts"

const storedItem = {
  id: "item-1",
  type: "todo",
  task: "Approve or request changes on #412",
  intention: "Finish reviewing the auth PR",
  why: "Review requested yesterday",
  tabs: [
    {
      title: "Add OAuth refresh by dana · Pull Request #412",
      url: "https://github.com/acme/api/pull/412",
      faviconUrl: "https://github.githubassets.com/favicons/favicon.svg",
      domain: "github.com"
    },
    { title: "RFC 6749", url: "https://www.rfc-editor.org/rfc/rfc6749", domain: "rfc-editor.org" }
  ],
  status: "open",
  savedAt: "2026-10-04T09:30:00.000Z"
}

describe("SavedItem", () => {
  it("round-trips through its stored form, with timestamps as ISO strings", () => {
    const item = decodeOk(SavedItem, storedItem)
    expect(DateTime.isDateTime(item.savedAt)).toBe(true)
    expect(item.tabs[1]?.faviconUrl).toBeUndefined()
    expect(encodeOk(SavedItem, item)).toEqual(storedItem)
  })

  it("accepts a done item with doneAt, keeping its tabs and title", () => {
    const item = decodeOk(SavedItem, { ...storedItem, status: "done", doneAt: "2026-10-05T08:00:00.000Z" })
    expect(item.status).toBe("done")
    expect(item.tabs).toHaveLength(2)
    expect(item.intention).toBe("Finish reviewing the auth PR")
    expect(encodeOk(SavedItem, item)).toMatchObject({ doneAt: "2026-10-05T08:00:00.000Z" })
  })

  it("rejects bad input", () => {
    expect(rejects(SavedItem, { ...storedItem, status: "archived" })).toBe(true)
    expect(rejects(SavedItem, { ...storedItem, status: "dropped", doneAt: "2026-10-05T08:00:00.000Z" })).toBe(true)
    expect(rejects(SavedItem, { ...storedItem, type: "work" })).toBe(true)
    expect(rejects(SavedItem, { ...storedItem, tabs: [] })).toBe(true)
    expect(rejects(SavedItem, { ...storedItem, task: "" })).toBe(true)
    expect(rejects(SavedItem, { ...storedItem, id: "" })).toBe(true)
    expect(rejects(SavedItem, { ...storedItem, savedAt: "yesterday" })).toBe(true)
    expect(rejects(SavedItem, { ...storedItem, tabs: [{ title: "x", url: "", domain: "" }] })).toBe(true)
    expect(rejects(SavedItem, { ...storedItem, tabs: [{ title: "x", url: "https://a.example" }] })).toBe(true)
  })

  it("rejects doneAt that doesn't match the status", () => {
    expect(rejects(SavedItem, { ...storedItem, status: "done" })).toBe(true)
    expect(rejects(SavedItem, { ...storedItem, doneAt: "2026-10-05T08:00:00.000Z" })).toBe(true)
  })
})

describe("dispositionOf", () => {
  const cases: ReadonlyArray<[IntentionKind, string]> = [
    ["work", "Save:todo"],
    ["decide", "Save:todo"],
    ["track", "Save:follow_up"],
    ["read", "Save:read"],
    ["reference", "Save:keep"],
    ["done", "Close"],
    ["dead", "Close"],
    ["app", "KeepOpen"]
  ]
  it.each(cases)("%s -> %s", (kind, expected) => {
    const disposition = dispositionOf(kind)
    expect(disposition._tag === "Save" ? `Save:${disposition.type}` : disposition._tag).toBe(expected)
  })

  it("labels tracker types as the UI shows them", () => {
    expect(trackerTypeLabel).toEqual({ todo: "To do", follow_up: "Follow up", read: "Read", keep: "Keep" })
  })
})

describe("newSavedItem", () => {
  const id = decodeOk(SavedItemId, "item-2")
  const savedAt = DateTime.makeUnsafe("2026-10-04T10:00:00.000Z")
  const tab: SavedTab = { title: "Desk A", url: "https://shop.example/desk-a", domain: "shop.example" }
  const intention = {
    title: "Decide between two standing desks",
    why: "Comparing prices",
    nextStep: "Pick a standing desk",
    kind: "decide" as const
  }

  it("makes an open item whose task is the model's next_step", () => {
    const item = Option.getOrThrow(newSavedItem({ id, intention, tabs: [tab], savedAt }))
    expect(item).toEqual({
      id,
      type: "todo",
      task: "Pick a standing desk",
      intention: "Decide between two standing desks",
      why: "Comparing prices",
      tabs: [tab],
      status: "open",
      savedAt
    })
    expect(encodeOk(SavedItem, item)).toMatchObject({ savedAt: "2026-10-04T10:00:00.000Z" })
  })

  it("falls back to the intention title when there is no usable next_step", () => {
    const withoutNextStep = { title: intention.title, why: intention.why, kind: intention.kind }
    const blank = { ...intention, nextStep: "   " }
    for (const source of [withoutNextStep, blank]) {
      const item = Option.getOrThrow(newSavedItem({ id, intention: source, tabs: [tab], savedAt }))
      expect(item.task).toBe("Decide between two standing desks")
    }
  })

  it("saves nothing for done, dead and app", () => {
    for (const kind of ["done", "dead", "app"] as const) {
      expect(Option.isNone(newSavedItem({ id, intention: { ...intention, kind }, tabs: [tab], savedAt }))).toBe(true)
    }
  })
})

describe("markDone and reopen", () => {
  const item = decodeOk(SavedItem, storedItem)
  const at = DateTime.makeUnsafe("2026-10-06T12:00:00.000Z")

  it("sets doneAt when done and clears it when reopened", () => {
    const done = markDone(item, at)
    expect(done.status).toBe("done")
    expect(done.doneAt).toEqual(at)
    expect(done.tabs).toBe(item.tabs)
    const reopened = reopen(done)
    expect(reopened.status).toBe("open")
    expect(reopened).not.toHaveProperty("doneAt")
    for (const next of [done, reopened]) expect(() => encodeOk(SavedItem, next)).not.toThrow()
  })
})

describe("removeItem and restoreItem", () => {
  const make = (id: string) => decodeOk(SavedItem, { ...storedItem, id })
  const [a, b, c] = [make("a"), make("b"), make("c")]
  const ids = (items: ReadonlyArray<SavedItem>) => items.map((item) => item.id)

  it("deletes an item and puts it back where it was", () => {
    const { items, removed } = Option.getOrThrow(removeItem([a, b, c], b.id))
    expect(ids(items)).toEqual(["a", "c"])
    expect(removed).toEqual({ item: b, index: 1 })
    expect(ids(restoreItem(items, removed))).toEqual(["a", "b", "c"])
  })

  it("is None for an unknown id", () => {
    expect(Option.isNone(removeItem([a], decodeOk(SavedItemId, "zzz")))).toBe(true)
  })

  it("restores at the end when the list got shorter, and never duplicates", () => {
    const { removed } = Option.getOrThrow(removeItem([a, b, c], c.id))
    expect(ids(restoreItem([a], removed))).toEqual(["a", "c"])
    expect(ids(restoreItem([a, c], removed))).toEqual(["a", "c"])
  })
})

describe("removeTab and restoreTab", () => {
  const tab = (name: string): SavedTab => ({ title: name, url: `https://${name}.example/`, domain: `${name}.example` })
  const make = (id: string, tabs: ReadonlyArray<SavedTab>) => decodeOk(SavedItem, { ...storedItem, id, tabs })
  const a = make("a", [tab("one")])
  const b = make("b", [tab("one"), tab("two"), tab("three")])
  const titles = (items: ReadonlyArray<SavedItem>, id: string) => items.find((item) => item.id === id)?.tabs.map((t) => t.title)

  it("deletes one tab and puts it back where it was; other items are untouched", () => {
    const { items, removal } = Option.getOrThrow(removeTab([a, b], b.id, { index: 1, url: "https://two.example/" }))
    expect(titles(items, "b")).toEqual(["one", "three"])
    expect(items[0]).toBe(a)
    expect(removal).toEqual({ _tag: "TabRemoved", removed: { itemId: b.id, tab: tab("two"), index: 1 } })
    if (removal._tag !== "TabRemoved") throw new Error("expected TabRemoved")
    expect(titles(restoreTab(items, removal.removed), "b")).toEqual(["one", "two", "three"])
    expect(() => encodeOk(TabRemoval, removal)).not.toThrow()
  })

  it("finds the tab by URL when the index is stale", () => {
    const { items } = Option.getOrThrow(removeTab([b], b.id, { index: 0, url: "https://three.example/" }))
    expect(titles(items, "b")).toEqual(["one", "two"])
  })

  it("removing the last tab removes the item, which restoreItem brings back with its tab", () => {
    const { items, removal } = Option.getOrThrow(removeTab([a, b], a.id, { index: 0, url: "https://one.example/" }))
    expect(items.map((item) => item.id)).toEqual(["b"])
    expect(removal).toEqual({ _tag: "ItemRemoved", removed: { item: a, index: 0 } })
    if (removal._tag !== "ItemRemoved") throw new Error("expected ItemRemoved")
    expect(restoreItem(items, removal.removed)).toEqual([a, b])
  })

  it("is None for an unknown item or tab", () => {
    expect(Option.isNone(removeTab([a], decodeOk(SavedItemId, "zzz"), { index: 0, url: "https://one.example/" }))).toBe(true)
    expect(Option.isNone(removeTab([a], a.id, { index: 0, url: "https://nope.example/" }))).toBe(true)
  })

  it("restores at the end when the item got shorter, never duplicates, and ignores a gone item", () => {
    const { removal } = Option.getOrThrow(removeTab([b], b.id, { index: 2, url: "https://three.example/" }))
    if (removal._tag !== "TabRemoved") throw new Error("expected TabRemoved")
    const shorter = make("b", [tab("one")])
    expect(titles(restoreTab([shorter], removal.removed), "b")).toEqual(["one", "three"])
    expect(restoreTab([b], removal.removed)).toEqual([b])
    expect(restoreTab([a], removal.removed)).toEqual([a])
  })
})

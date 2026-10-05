import { assert, describe, expect, it } from "@effect/vitest"
import { type SavedItem, SavedItemId } from "@wherefore/core"
import { DateTime, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { make as makeStore } from "../src/background/Store.ts"
import { itemsKey, settingsKey } from "../src/store/keys.ts"
import type { StoreKey } from "../src/store/StoreKey.ts"
import { StoreReader } from "../src/store/StoreReader.ts"
import { FakeChrome } from "./fakes/chrome.ts"

const storedItem = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  type: "todo",
  task: `Task ${id}`,
  intention: `Intention ${id}`,
  why: "Because",
  tabs: [{ title: "PR", url: `https://github.com/acme/api/pull/${id}`, domain: "github.com" }],
  status: "open",
  savedAt: "2026-10-04T09:30:00.000Z",
  ...extra
})

const decodeItem = Schema.decodeUnknownSync(itemsKey.schema)
const item = (id: string): SavedItem => {
  const [decoded] = decodeItem([storedItem(id)])
  assert(decoded !== undefined)
  return decoded
}

/** A key at version 3 whose data was a bare string list at version 1 and `{ names }` at version 2. */
const namesKey: StoreKey<ReadonlyArray<{ readonly name: string }>> = {
  name: "names",
  version: 3,
  schema: Schema.Array(Schema.Struct({ name: Schema.String })),
  migrations: {
    1: (data) => ({ names: data }),
    2: (data) => (data as { names: Array<string> }).names.map((name) => ({ name }))
  },
  empty: []
}

describe("Store reads and migrations", () => {
  it.effect("migrates an old version up to the current one and writes it back", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({ local: { names: { version: 1, data: ["ada", "lin"] } } })
      const value = yield* makeStore(chrome.api).read(namesKey)
      expect(value).toEqual([{ name: "ada" }, { name: "lin" }])
      expect(chrome.local.get("names")).toEqual({ version: 3, data: [{ name: "ada" }, { name: "lin" }] })
    }))

  it.effect("doesn't write when the stored version is current, and returns the empty value when absent", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({ local: { items: { version: 1, data: [storedItem("a")] } } })
      const store = makeStore(chrome.api)
      expect((yield* store.read(itemsKey)).map((i) => i.id)).toEqual(["a"])
      expect(yield* store.read(settingsKey)).toEqual({})
      expect(chrome.calls.filter((call) => call === "storage.local.set")).toEqual([])
    }))

  it.effect("never drops a value it can't decode: backs it up and fails with a typed error", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(1_000)
      const broken = { version: 1, data: [storedItem("a", { status: "dropped" })] }
      const chrome = new FakeChrome({ local: { items: broken } })
      const store = makeStore(chrome.api)

      const error = yield* Effect.flip(store.read(itemsKey))
      assert(error._tag === "StoreUnreadable")
      expect(error.key).toBe("items")
      expect(error.backupKey).toBe("backup:items:1000")
      expect(chrome.local.get("backup:items:1000")).toMatchObject({ at: 1000, raw: broken })
      expect(chrome.local.get("items")).toEqual(broken)

      // Writes are refused, so the original stays untouched.
      const writeError = yield* Effect.flip(store.saveItems([item("b")]))
      expect(writeError._tag).toBe("StoreUnreadable")
      expect(chrome.local.get("items")).toEqual(broken)

      // Reading again reuses the same backup instead of piling up copies.
      yield* TestClock.adjust(5_000)
      const again = yield* Effect.flip(store.read(itemsKey))
      assert(again._tag === "StoreUnreadable")
      expect(again.backupKey).toBe("backup:items:1000")
      expect([...chrome.local.keys()].filter((key) => key.startsWith("backup:"))).toEqual(["backup:items:1000"])
    }))

  it.effect("treats a value from a newer version, or without an envelope, as unreadable", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({ local: { items: { version: 2, data: [] }, settings: [storedItem("a")] } })
      const errors = yield* makeStore(chrome.api).migrateAll
      expect(errors.map((e) => [e._tag, "key" in e ? e.key : ""])).toEqual([
        ["StoreUnreadable", "items"],
        ["StoreUnreadable", "settings"]
      ])
      expect(chrome.local.get("items")).toEqual({ version: 2, data: [] })
    }))
})

describe("Store item operations", () => {
  it.effect("saves (replacing by id), marks done and open, removes and restores", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(Date.parse("2026-10-06T12:00:00.000Z"))
      const chrome = new FakeChrome()
      const store = makeStore(chrome.api)
      yield* store.saveItems([item("a"), item("b")])
      yield* store.saveItems([{ ...item("a"), task: "Edited" }, item("c")])
      let items = yield* store.read(itemsKey)
      expect(items.map((i) => [i.id, i.task])).toEqual([["a", "Edited"], ["b", "Task b"], ["c", "Task c"]])

      const done = yield* store.markDone(SavedItemId.make("b"))
      expect(done.status).toBe("done")
      expect(done.doneAt && DateTime.formatIso(done.doneAt)).toBe("2026-10-06T12:00:00.000Z")
      // Done items stay in the list, as the Done archive.
      expect(chrome.local.get("items")).toMatchObject({
        version: 1,
        data: [{ id: "a" }, { id: "b", status: "done", doneAt: "2026-10-06T12:00:00.000Z" }, { id: "c" }]
      })
      const reopened = yield* store.markOpen(SavedItemId.make("b"))
      expect(reopened.status).toBe("open")
      expect("doneAt" in reopened).toBe(false)

      const removed = yield* store.removeItem(SavedItemId.make("b"))
      expect(removed.index).toBe(1)
      expect((yield* store.read(itemsKey)).map((i) => i.id)).toEqual(["a", "c"])
      yield* store.restoreItem(removed)
      items = yield* store.read(itemsKey)
      expect(items.map((i) => i.id)).toEqual(["a", "b", "c"])

      const missing = yield* Effect.flip(store.markDone(SavedItemId.make("zzz")))
      expect(missing).toMatchObject({ _tag: "ItemNotFound", id: "zzz" })
    }))

  it.effect("serializes concurrent writes", () =>
    Effect.gen(function*() {
      const store = makeStore(new FakeChrome().api)
      yield* Effect.forEach(["a", "b", "c", "d"], (id) => store.saveItems([item(id)]), { concurrency: "unbounded" })
      expect((yield* store.read(itemsKey)).map((i) => i.id).sort()).toEqual(["a", "b", "c", "d"])
    }))

  it.effect("stores settings locally", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome()
      const saved = yield* makeStore(chrome.api).updateSettings({ apiKey: "sk-test", model: "some-model" })
      expect(saved).toEqual({ apiKey: "sk-test", model: "some-model" })
      expect(chrome.local.get("settings")).toEqual({ version: 1, data: { apiKey: "sk-test", model: "some-model" } })
    }))
})

describe("StoreReader", () => {
  const readerFor = (chrome: FakeChrome) =>
    Effect.provide(
      Effect.gen(function*() {
        return yield* StoreReader
      }),
      StoreReader.layer.pipe(Layer.provide(chrome.layer))
    )

  it.effect("streams the current value, then every change from storage.onChanged", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({ local: { items: { version: 1, data: [storedItem("a")] } } })
      const reader = yield* readerFor(chrome)
      const store = makeStore(chrome.api)
      const fiber = yield* reader.watch(itemsKey).pipe(
        Stream.map((items) => items.map((i) => i.id)),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* Effect.yieldNow
      yield* store.saveItems([item("b")])
      yield* store.removeItem(SavedItemId.make("a"))
      expect(yield* Fiber.join(fiber)).toEqual([["a"], ["a", "b"], ["b"]])
    }))

  it.effect("migrates in memory without writing", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({ local: { names: { version: 1, data: ["ada"] } } })
      const reader = yield* readerFor(chrome)
      expect(yield* reader.get(namesKey)).toEqual([{ name: "ada" }])
      expect(chrome.local.get("names")).toEqual({ version: 1, data: ["ada"] })
    }))

  it.effect("fails the stream with a typed error when a change can't be read", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome()
      const reader = yield* readerFor(chrome)
      const fiber = yield* reader.watch(settingsKey).pipe(Stream.runCollect, Effect.flip, Effect.forkChild)
      yield* Effect.yieldNow
      yield* chrome.api.storage.local.set({ settings: { version: 1, data: { apiKey: "" } } })
      const error = yield* Fiber.join(fiber)
      expect(error).toMatchObject({ _tag: "StoreUnreadable", key: "settings" })
    }))
})

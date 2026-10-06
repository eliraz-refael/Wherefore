import { assert, describe, expect, it } from "@effect/vitest"
import { MAX_RUNS, Run, RunId, type SavedItem, SavedItemId } from "@wherefore/core"
import { DateTime, Effect, Fiber, Layer, Schema, Stream } from "effect"
import { TestClock } from "effect/testing"
import { make as makeStore } from "../src/background/Store.ts"
import { itemsKey, runIndexKey, runKey, runKeyPrefix, settingsKey } from "../src/store/keys.ts"
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

describe("Store recovery", () => {
  it.effect("resets an unreadable key: the raw value stays in a backup, the key reads as empty again", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({ local: { items: { version: 99, data: "from the future" } } })
      const store = makeStore(chrome.api)
      const backupKey = yield* store.resetKey("items")
      assert(backupKey !== null)
      expect(backupKey.startsWith("backup:items:")).toBe(true)
      expect(chrome.local.get(backupKey)).toMatchObject({ raw: { version: 99, data: "from the future" } })
      expect(chrome.local.has("items")).toBe(false)
      expect(yield* store.read(itemsKey)).toEqual([])
      yield* store.saveItems([item("a")])
      expect((yield* store.read(itemsKey)).map((i) => i.id)).toEqual(["a"])
    }))

  it.effect("reuses the backup the worker already made, and leaves a readable key alone", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome({ local: { items: { version: 1, data: [{ broken: true }] }, settings: { version: 1, data: { apiKey: "k" } } } })
      const store = makeStore(chrome.api)
      const failed = yield* Effect.flip(store.read(itemsKey))
      assert(failed._tag === "StoreUnreadable")
      expect(yield* store.resetKey("items")).toBe(failed.backupKey)
      expect([...chrome.local.keys()].filter((key) => key.startsWith("backup:"))).toHaveLength(1)
      expect(yield* store.resetKey("settings")).toBeNull()
      expect(chrome.local.get("settings")).toEqual({ version: 1, data: { apiKey: "k" } })
    }))

  it.effect("resetting the run index also drops the run keys it listed, and keeps every backup", () =>
    Effect.gen(function*() {
      const oldBackup = { at: 1, reason: "unreadable", raw: { version: 99 } }
      const chrome = new FakeChrome({
        local: {
          runIndex: { version: 99, data: "from the future" },
          [`${runKeyPrefix}a`]: { version: 1, data: { id: "a" } },
          [`${runKeyPrefix}b`]: { version: 1, data: { id: "b" } },
          "backup:run:c:1": oldBackup,
          "backup:items:1": oldBackup,
          items: { version: 1, data: [storedItem("x")] }
        }
      })
      const backupKey = yield* makeStore(chrome.api).resetKey("runIndex")
      assert(backupKey !== null)
      expect(backupKey.startsWith("backup:runIndex:")).toBe(true)
      expect([...chrome.local.keys()].filter((key) => key.startsWith(runKeyPrefix))).toEqual([])
      expect(chrome.local.has("runIndex")).toBe(false)
      expect(chrome.local.get("backup:run:c:1")).toEqual(oldBackup)
      expect(chrome.local.get("backup:items:1")).toEqual(oldBackup)
      expect(chrome.local.get(backupKey)).toMatchObject({ raw: { version: 99, data: "from the future" } })
      expect(chrome.local.has("items")).toBe(true)
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

describe("Store runs: one key per run", () => {
  const wireRun = (id: string, status = "running") => ({
    id,
    mode: "api",
    model: "claude-opus-5-5",
    startedAt: "2026-10-05T09:00:00.000Z",
    ...(status === "running" ? {} : { finishedAt: "2026-10-05T09:05:00.000Z" }),
    status,
    tabs: [],
    steps: [],
    intentions: [],
    usage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  })
  const decodeRun = Schema.decodeUnknownSync(Run)
  const run = (id: string, status = "running"): Run => decodeRun(wireRun(id, status))
  const withNote = (r: Run, message: string): Run => ({
    ...r,
    steps: [...r.steps, { kind: "note", at: r.startedAt, message }]
  })
  const indexOf = (chrome: FakeChrome) => (chrome.local.get(runIndexKey.name) as { data: unknown } | undefined)?.data
  const alive = (live: ReadonlyArray<string>) => (id: RunId) => Effect.succeed(live.includes(id))

  it.effect("stores each run under its own key, and a step rewrites only that run", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome()
      const store = makeStore(chrome.api)
      yield* store.saveRun(run("a"))
      yield* store.saveRun(run("b"))
      expect(chrome.local.get("run:a")).toEqual({ version: 1, data: wireRun("a") })
      expect(indexOf(chrome)).toEqual([{ id: "a", status: "running" }, { id: "b", status: "running" }])

      const b = chrome.local.get("run:b")
      const index = chrome.local.get(runIndexKey.name)
      yield* store.saveRun(withNote(run("a"), "step"))
      expect(chrome.local.get("run:b")).toBe(b) // untouched
      expect(chrome.local.get(runIndexKey.name)).toBe(index) // same status: the index isn't rewritten
      expect(yield* store.read(runKey(RunId.make("a")))).toMatchObject({ steps: [{ message: "step" }] })

      // A status change updates the index in the same write.
      yield* store.saveRun(run("a", "succeeded"))
      expect(indexOf(chrome)).toEqual([{ id: "a", status: "succeeded" }, { id: "b", status: "running" }])
      expect(yield* store.read(runKey(RunId.make("zzz")))).toBeUndefined()
    }))

  it.effect("marks a run's result reviewed and back, and ignores runs that aren't stored", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome()
      const store = makeStore(chrome.api)
      yield* store.saveRun(run("a", "succeeded"))
      yield* store.setRunReviewed(RunId.make("a"), true)
      expect((chrome.local.get("run:a") as { data: { reviewedAt?: string } }).data.reviewedAt).toBeDefined()
      yield* store.setRunReviewed(RunId.make("a"), false)
      expect(chrome.local.get("run:a")).toEqual({ version: 1, data: wireRun("a", "succeeded") })
      yield* store.setRunReviewed(RunId.make("missing"), true)
      expect(chrome.local.has("run:missing")).toBe(false)
    }))

  it.effect(`keeps the newest ${MAX_RUNS} runs and removes the older run keys`, () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome()
      const store = makeStore(chrome.api)
      for (let i = 0; i < MAX_RUNS + 2; i++) yield* store.saveRun(run(`r${i}`, "succeeded"))
      const ids = (indexOf(chrome) as ReadonlyArray<{ id: string }>).map((entry) => entry.id)
      expect(ids).toHaveLength(MAX_RUNS)
      expect(ids[0]).toBe("r2")
      expect(chrome.local.has("run:r0")).toBe(false)
      expect(chrome.local.has("run:r1")).toBe(false)
      expect([...chrome.local.keys()].filter((key) => key.startsWith(runKeyPrefix))).toHaveLength(MAX_RUNS)
    }))

  it.effect("marks runs whose page is gone, leaves live and finished ones alone, and writes nothing when there is nothing to do", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome()
      const store = makeStore(chrome.api)
      yield* store.saveRun(run("gone"))
      yield* store.saveRun(run("live"))
      yield* store.saveRun(run("done", "succeeded"))
      expect(yield* store.interruptRuns(alive(["live"]))).toEqual(["gone"])
      expect(yield* store.read(runKey(RunId.make("gone")))).toMatchObject({ status: "interrupted" })
      expect(indexOf(chrome)).toEqual([
        { id: "gone", status: "interrupted" },
        { id: "live", status: "running" },
        { id: "done", status: "succeeded" }
      ])
      const writes = chrome.calls.filter((call) => call === "storage.local.set").length
      expect(yield* store.interruptRuns(alive(["live"]))).toEqual([])
      expect(chrome.calls.filter((call) => call === "storage.local.set")).toHaveLength(writes)
    }))

  it.effect("backs up an unreadable run and refuses it alone: the other runs keep working", () =>
    Effect.gen(function*() {
      yield* TestClock.setTime(1_000)
      const broken = { version: 1, data: { ...wireRun("bad"), status: "exploded" } }
      const chrome = new FakeChrome({
        local: {
          "run:bad": broken,
          "run:old": { version: 1, data: wireRun("old") },
          runIndex: { version: 1, data: [{ id: "bad", status: "running" }, { id: "old", status: "running" }] }
        }
      })
      const store = makeStore(chrome.api)

      const errors = yield* store.migrateAll
      expect(errors.map((e) => [e._tag, "key" in e ? e.key : "", "backupKey" in e ? e.backupKey : ""])).toEqual([
        ["StoreUnreadable", "run:bad", "backup:run:bad:1000"]
      ])
      expect(chrome.local.get("backup:run:bad:1000")).toMatchObject({ raw: broken })

      // The sweep skips the bad run and still marks the other one.
      expect(yield* store.interruptRuns(alive([]))).toEqual(["old"])
      expect(chrome.local.get("run:bad")).toEqual(broken)
      // Its index entry no longer says "running", so the next sweep doesn't read it again.
      expect(indexOf(chrome)).toEqual([{ id: "bad", status: "interrupted" }, { id: "old", status: "interrupted" }])
      const reads = chrome.calls.length
      expect(yield* store.interruptRuns(alive([]))).toEqual([])
      expect(chrome.calls.slice(reads)).toEqual(["storage.local.get"])

      // Saving over the bad run is refused; other runs save.
      const refused = yield* Effect.flip(store.saveRun(run("bad")))
      expect(refused).toMatchObject({ _tag: "StoreUnreadable", key: "run:bad" })
      expect(chrome.local.get("run:bad")).toEqual(broken)
      yield* store.saveRun(run("new"))
      expect(yield* store.read(runKey(RunId.make("new")))).toMatchObject({ id: "new" })
    }))

  it.effect("StoreReader follows one run, or every run, and lists an unreadable run without hiding the others", () =>
    Effect.gen(function*() {
      const chrome = new FakeChrome()
      const reader = yield* Effect.provide(
        Effect.gen(function*() {
          return yield* StoreReader
        }),
        StoreReader.layer.pipe(Layer.provide(chrome.layer))
      )
      const store = makeStore(chrome.api)
      yield* store.saveRun(run("a"))

      const one = yield* reader.watch(runKey(RunId.make("a"))).pipe(
        Stream.map((r) => r?.steps.length),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild
      )
      const all = yield* reader.watchRuns.pipe(
        Stream.map(({ runs, unreadable }) => `${runs.map((r) => `${r.id}:${r.status}`).join(",")}|${unreadable.length}`),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild
      )
      yield* Effect.yieldNow
      yield* store.saveRun(withNote(run("a"), "one"))
      yield* store.saveRun(run("b")) // another run: not seen by the one-run mirror
      yield* store.saveRun(withNote(withNote(run("a"), "one"), "two"))
      yield* chrome.api.storage.local.set({ "run:b": { version: 1, data: { id: "b" } } })
      expect(yield* Fiber.join(one)).toEqual([0, 1, 2])
      expect(yield* Fiber.join(all)).toEqual([
        "a:running|0",
        "a:running|0",
        "a:running,b:running|0",
        "a:running,b:running|0",
        "a:running|1" // b can't be read: listed apart, a still shown
      ])

      const list = yield* reader.runs
      expect(list.runs.map((r) => r.id)).toEqual(["a"])
      expect(list.unreadable).toMatchObject([{ _tag: "StoreUnreadable", key: "run:b" }])
    }))
})

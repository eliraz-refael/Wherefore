/**
 * The write half of the Store (architecture A5), owned by the service worker (A4).
 *
 * Reads go through `decodeStored`: an older version is migrated and written back. A value that
 * can't be read is never overwritten or dropped: its raw form is copied to a backup key
 * (`backup:<key>:<epoch ms>`, reused when the same value was already backed up), and the read,
 * and therefore every write to that key, fails with `StoreUnreadable`.
 *
 * Writes are read-modify-write under one lock, so concurrent RPCs can't lose each other's
 * updates; a change that returns the value it was given writes nothing. Item and run operations
 * are core's pure helpers (savedItem.ts, run.ts).
 *
 * Each run has its own key (`run:<id>`), so a step rewrites one run, not all of them. The run
 * index (`runIndex`: ids and statuses, oldest first) is written in the same `set` as the run when
 * the run is new or its status changes; pruning and the interrupted-run sweep read it. An
 * unreadable run is backed up and refused on its own: the other runs keep working.
 */
import {
  type BrowserError,
  interruptRun,
  ItemNotFound,
  markDone,
  type ProfileId,
  type RemovedItem,
  removeItem,
  reopen,
  restoreItem,
  type Run,
  type RunId,
  type RunIndexEntry,
  type SavedItem,
  type SavedItemId,
  type ResettableKey,
  setReviewed,
  type Settings,
  StoreUnreadable,
  upsertRunIndex
} from "@wherefore/core"
import { Clock, Context, DateTime, Effect, Layer, Option, Semaphore } from "effect"
import { ChromeApi } from "../chrome/ChromeApi.ts"
import { itemsKey, profileKey, runIndexKey, runKey, runKeyPrefix, settingsKey, storeKeys } from "../store/keys.ts"
import { decodeStored, encodeStored, type StoreKey } from "../store/StoreKey.ts"

export type StoreError = StoreUnreadable | BrowserError

export const backupKeyPrefix = (key: StoreKey<unknown>): string => `backup:${key.name}:`

/** What a backup key holds. */
export interface Backup {
  /** Epoch milliseconds. */
  readonly at: number
  readonly reason: string
  /** Exactly what was stored. */
  readonly raw: unknown
}

export class Store extends Context.Service<Store, {
  readonly read: <A>(key: StoreKey<A>) => Effect.Effect<A, StoreError>
  /**
   * Reads every key once (every run in the index too), so old versions are migrated and
   * unreadable values backed up at startup.
   */
  readonly migrateAll: Effect.Effect<ReadonlyArray<StoreError>>
  /** Adds items; an item whose id is already saved replaces it in place. */
  readonly saveItems: (items: ReadonlyArray<SavedItem>) => Effect.Effect<void, StoreError>
  readonly markDone: (id: SavedItemId) => Effect.Effect<SavedItem, ItemNotFound | StoreError>
  readonly markOpen: (id: SavedItemId) => Effect.Effect<SavedItem, ItemNotFound | StoreError>
  readonly removeItem: (id: SavedItemId) => Effect.Effect<RemovedItem, ItemNotFound | StoreError>
  readonly restoreItem: (removed: RemovedItem) => Effect.Effect<void, StoreError>
  readonly updateSettings: (settings: Settings) => Effect.Effect<Settings, StoreError>
  /**
   * Stores a run under its own key: replaces the one with the same id, or adds it, keeping the
   * newest `MAX_RUNS` (older run keys are removed). Fails if the stored copy of this run, or the
   * index, can't be read.
   */
  readonly saveRun: (run: Run) => Effect.Effect<void, StoreError>
  /**
   * Marks every "running" run whose page is gone (`isLive` says false) as interrupted, except
   * `except`. Returns the ids it marked. A run that can't be read is backed up and skipped.
   */
  readonly interruptRuns: (
    isLive: (id: RunId) => Effect.Effect<boolean>,
    except?: RunId
  ) => Effect.Effect<ReadonlyArray<RunId>, StoreError>
  /**
   * Marks a stored run's result reviewed (now), or waiting for review again. A run that is no longer
   * stored is ignored.
   */
  readonly setRunReviewed: (id: RunId, reviewed: boolean) => Effect.Effect<void, StoreError>
  /**
   * The way out of `StoreUnreadable` for a fixed key: makes sure the unreadable value is backed up,
   * then removes the key, so it reads as empty. Returns the backup key; `null` (and no change) when
   * the value was readable after all.
   */
  readonly resetKey: (name: ResettableKey) => Effect.Effect<string | null, BrowserError>
  /** This profile's id for the companion: the stored one, or a new one from `make`, stored now. */
  readonly profileId: (make: () => ProfileId) => Effect.Effect<ProfileId, StoreError>
}>()("@wherefore/extension/Store") {
  static readonly layer: Layer.Layer<Store, never, ChromeApi> = Layer.effect(Store)(
    Effect.gen(function*() {
      return make(yield* ChromeApi)
    })
  )
}

const sameJson = (a: unknown, b: unknown): boolean => {
  try {
    return JSON.stringify(a) === JSON.stringify(b)
  } catch {
    return false
  }
}

export const make = (chrome: ChromeApi["Service"]): Store["Service"] => {
  const local = chrome.storage.local
  const lock = Semaphore.makeUnsafe(1)

  /** Copies `raw` to a backup key, unless an identical backup of this key exists. Returns the key. */
  const backUp = (key: StoreKey<unknown>, raw: unknown, reason: string) =>
    Effect.gen(function*() {
      const prefix = backupKeyPrefix(key)
      const all = yield* local.get(null)
      const existing = Object.entries(all).find(([name, value]) =>
        name.startsWith(prefix) && typeof value === "object" && value !== null && sameJson((value as Backup).raw, raw)
      )
      if (existing !== undefined) return existing[0]
      const at = yield* Clock.currentTimeMillis
      const backupKey = `${prefix}${at}`
      yield* local.set({ [backupKey]: { at, reason, raw } satisfies Backup })
      return backupKey
    })

  const readUnlocked = <A>(key: StoreKey<A>): Effect.Effect<A, StoreError> =>
    Effect.gen(function*() {
      const raw = (yield* local.get(key.name))[key.name]
      const result = decodeStored(key, raw)
      if (result._tag === "Failure") {
        const backupKey = yield* backUp(key, raw, result.failure)
        yield* Effect.logWarning(`Store: "${key.name}" is unreadable (${result.failure}); raw value kept in ${backupKey}`)
        return yield* new StoreUnreadable({ key: key.name, message: result.failure, backupKey })
      }
      const { value, migratedFrom } = result.success
      if (migratedFrom !== undefined) {
        yield* local.set({ [key.name]: encodeStored(key, value) })
        yield* Effect.logInfo(`Store: migrated "${key.name}" from version ${migratedFrom} to ${key.version}`)
      }
      return value
    })

  const read = <A>(key: StoreKey<A>) => readUnlocked(key).pipe(Semaphore.withPermit(lock))

  /** Read, change, write, under the lock. `change` returns the result and the new value. */
  const update = <A, B, E>(
    key: StoreKey<A>,
    change: (value: A) => Effect.Effect<readonly [B, A], E>
  ): Effect.Effect<B, E | StoreError> =>
    Effect.gen(function*() {
      const current = yield* readUnlocked(key)
      const [result, next] = yield* change(current)
      if (next !== current) yield* local.set({ [key.name]: encodeStored(key, next) })
      return result
    }).pipe(Semaphore.withPermit(lock))

  const errorsOf = (effect: Effect.Effect<unknown, StoreError>) =>
    Effect.match(effect, {
      onFailure: (error): ReadonlyArray<StoreError> => [error],
      onSuccess: (): ReadonlyArray<StoreError> => []
    })

  const migrateAll = Effect.gen(function*() {
    const errors = yield* Effect.forEach(storeKeys, (key) => errorsOf(read(key)))
    // An unreadable index is already in `errors`.
    const index = yield* Effect.option(read(runIndexKey))
    const runErrors = index._tag === "Some"
      ? yield* Effect.forEach(index.value, (entry) => errorsOf(read(runKey(entry.id))))
      : []
    return [...errors, ...runErrors].flat()
  })

  const saveRun = (run: Run) =>
    Effect.gen(function*() {
      const key = runKey(run.id)
      const index = yield* readUnlocked(runIndexKey)
      // Never overwrite a stored copy that can't be read (the read backs it up).
      yield* readUnlocked(key)
      const next = upsertRunIndex(index, { id: run.id, status: run.status })
      yield* local.set({
        [key.name]: encodeStored(key, run),
        ...(next.index === index ? {} : { [runIndexKey.name]: encodeStored(runIndexKey, next.index) })
      })
      if (next.dropped.length > 0) yield* local.remove(next.dropped.map((id) => runKey(id).name))
    }).pipe(Semaphore.withPermit(lock))

  const interruptRuns = (isLive: (id: RunId) => Effect.Effect<boolean>, except?: RunId) =>
    Effect.gen(function*() {
      const index = yield* readUnlocked(runIndexKey)
      const writes: Record<string, unknown> = {}
      const marked: Array<RunId> = []
      let nextIndex: ReadonlyArray<RunIndexEntry> = index
      for (const entry of index) {
        if (entry.status !== "running" || entry.id === except || (yield* isLive(entry.id))) continue
        const key = runKey(entry.id)
        // An unreadable run is backed up by the read and skipped; the others are still checked. Its
        // page is gone, so its index entry stops saying "running": later sweeps (one per saved step)
        // don't read it and back it up again.
        const stored = yield* readUnlocked(key).pipe(
          Effect.map(Option.some),
          Effect.catchTag("StoreUnreadable", () => Effect.succeed(Option.none<Run | undefined>()))
        )
        if (stored._tag === "None") {
          nextIndex = upsertRunIndex(nextIndex, { id: entry.id, status: "interrupted" }).index
          continue
        }
        const run = stored.value
        if (run === undefined) {
          // The index names a run that isn't stored: drop the entry.
          nextIndex = nextIndex.filter((e) => e.id !== entry.id)
          continue
        }
        const interrupted = interruptRun(run, yield* DateTime.now)
        if (interrupted !== run) {
          writes[key.name] = encodeStored(key, interrupted)
          marked.push(run.id)
        }
        nextIndex = upsertRunIndex(nextIndex, { id: run.id, status: interrupted.status }).index
      }
      if (nextIndex !== index) writes[runIndexKey.name] = encodeStored(runIndexKey, nextIndex)
      if (Object.keys(writes).length > 0) yield* local.set(writes)
      if (marked.length > 0) yield* Effect.logInfo(`Store: marked ${marked.length} run(s) interrupted: their page is gone`)
      return marked
    }).pipe(Semaphore.withPermit(lock))

  const updateItem = (id: SavedItemId, change: (item: SavedItem, now: DateTime.Utc) => SavedItem) =>
    update(itemsKey, (items) =>
      Effect.gen(function*() {
        const index = items.findIndex((item) => item.id === id)
        const item = items[index]
        if (item === undefined) return yield* new ItemNotFound({ id })
        const changed = change(item, yield* DateTime.now)
        return [changed, items.map((existing, i) => (i === index ? changed : existing))] as const
      }))

  const setRunReviewed = (id: RunId, reviewed: boolean) =>
    Effect.gen(function*() {
      const key = runKey(id)
      const run = yield* readUnlocked(key)
      if (run === undefined) return
      const next = setReviewed(run, reviewed ? yield* DateTime.now : undefined)
      if (next !== run) yield* local.set({ [key.name]: encodeStored(key, next) })
    }).pipe(Semaphore.withPermit(lock))

  const resetKey = (name: ResettableKey) =>
    Effect.gen(function*() {
      const key = storeKeys.find((candidate) => candidate.name === name)
      if (key === undefined) return null
      const raw = (yield* local.get(key.name))[key.name]
      const result = decodeStored(key, raw)
      if (result._tag === "Success") return null
      const backupKey = yield* backUp(key, raw, result.failure)
      // Run keys are found (and pruned) only through the index: starting the index over would leave
      // every stored run behind for good. A running run's page stores it again on its next step.
      const runKeys = name === runIndexKey.name
        ? Object.keys(yield* local.get(null)).filter((stored) => stored.startsWith(runKeyPrefix))
        : []
      yield* local.remove([key.name, ...runKeys])
      yield* Effect.logWarning(`Store: reset "${key.name}" at the user's request; the old value is kept in ${backupKey}`)
      return backupKey
    }).pipe(Semaphore.withPermit(lock))

  const profileId = (make: () => ProfileId) =>
    update(profileKey, (stored) => {
      if (stored !== undefined) return Effect.succeed([stored.id, stored] as const)
      const id = make()
      return Effect.succeed([id, { id }] as const)
    })

  return {
    read,
    migrateAll,
    profileId,
    setRunReviewed,
    resetKey,
    saveItems: (incoming) =>
      update(itemsKey, (items) => {
        const byId = new Map(incoming.map((item) => [item.id, item]))
        const replaced = items.map((item) => byId.get(item.id) ?? item)
        const existing = new Set(items.map((item) => item.id))
        const added = [...byId.values()].filter((item) => !existing.has(item.id))
        return Effect.succeed([undefined, [...replaced, ...added]] as const)
      }),
    markDone: (id) => updateItem(id, (item, now) => (item.status === "done" ? item : markDone(item, now))),
    markOpen: (id) => updateItem(id, (item) => (item.status === "open" ? item : reopen(item))),
    removeItem: (id) =>
      update(itemsKey, (items) =>
        Option.match(removeItem(items, id), {
          onNone: () => Effect.fail(new ItemNotFound({ id })),
          onSome: ({ items: rest, removed }) => Effect.succeed([removed, rest] as const)
        })),
    restoreItem: (removed) => update(itemsKey, (items) => Effect.succeed([undefined, restoreItem(items, removed)] as const)),
    updateSettings: (settings) => update(settingsKey, () => Effect.succeed([settings, settings] as const)),
    saveRun,
    interruptRuns
  }
}

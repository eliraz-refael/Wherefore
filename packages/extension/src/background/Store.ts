/**
 * The write half of the Store (architecture A5), owned by the service worker (A4).
 *
 * Reads go through `decodeStored`: an older version is migrated and written back. A value that
 * can't be read is never overwritten or dropped: its raw form is copied to a backup key
 * (`backup:<key>:<epoch ms>`, reused when the same value was already backed up), and the read,
 * and therefore every write to that key, fails with `StoreUnreadable`.
 *
 * Writes are read-modify-write under one lock, so concurrent RPCs can't lose each other's
 * updates. Item operations are core's pure helpers (savedItem.ts).
 */
import {
  type BrowserError,
  ItemNotFound,
  markDone,
  type RemovedItem,
  removeItem,
  reopen,
  restoreItem,
  type SavedItem,
  type SavedItemId,
  type Settings,
  StoreUnreadable
} from "@wherefore/core"
import { Clock, Context, DateTime, Effect, Layer, Option, Semaphore } from "effect"
import { ChromeApi } from "../chrome/ChromeApi.ts"
import { itemsKey, settingsKey, storeKeys } from "../store/keys.ts"
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
  /** Reads every key once, so old versions are migrated and unreadable values backed up at startup. */
  readonly migrateAll: Effect.Effect<ReadonlyArray<StoreError>>
  /** Adds items; an item whose id is already saved replaces it in place. */
  readonly saveItems: (items: ReadonlyArray<SavedItem>) => Effect.Effect<void, StoreError>
  readonly markDone: (id: SavedItemId) => Effect.Effect<SavedItem, ItemNotFound | StoreError>
  readonly markOpen: (id: SavedItemId) => Effect.Effect<SavedItem, ItemNotFound | StoreError>
  readonly removeItem: (id: SavedItemId) => Effect.Effect<RemovedItem, ItemNotFound | StoreError>
  readonly restoreItem: (removed: RemovedItem) => Effect.Effect<void, StoreError>
  readonly updateSettings: (settings: Settings) => Effect.Effect<Settings, StoreError>
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
      const [result, next] = yield* Effect.flatMap(readUnlocked(key), change)
      yield* local.set({ [key.name]: encodeStored(key, next) })
      return result
    }).pipe(Semaphore.withPermit(lock))

  const migrateAll = Effect.forEach(storeKeys, (key) =>
    Effect.match(read(key), {
      onFailure: (error): ReadonlyArray<StoreError> => [error],
      onSuccess: (): ReadonlyArray<StoreError> => []
    })).pipe(Effect.map((errors) => errors.flat()))

  const updateItem = (id: SavedItemId, change: (item: SavedItem, now: DateTime.Utc) => SavedItem) =>
    update(itemsKey, (items) =>
      Effect.gen(function*() {
        const index = items.findIndex((item) => item.id === id)
        const item = items[index]
        if (item === undefined) return yield* new ItemNotFound({ id })
        const changed = change(item, yield* DateTime.now)
        return [changed, items.map((existing, i) => (i === index ? changed : existing))] as const
      }))

  return {
    read,
    migrateAll,
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
    updateSettings: (settings) => update(settingsKey, () => Effect.succeed([settings, settings] as const))
  }
}

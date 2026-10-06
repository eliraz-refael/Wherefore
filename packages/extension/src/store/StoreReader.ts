/**
 * The read half of the Store, for views (side panel, full page) and the worker alike.
 *
 * Views read `chrome.storage.local` directly and follow `storage.onChanged`; only the worker
 * writes (architecture A4/A5). So this half never writes: an old version is migrated in memory
 * (the worker writes it back), and an unreadable value is reported without a backup (the worker
 * makes the backup when it reads it). PR 4 backs Atoms with `watch` and `watchRuns`.
 *
 * Runs: follow one run with `watch(runKey(id))` (it reads only that run's key), or every stored
 * run with `watchRuns`. A run that can't be read is listed in `unreadable` and doesn't hide the
 * others.
 */
import { type BrowserError, CompanionStatus, type Run, type RunId, type RunIndexEntry, StoreUnreadable } from "@wherefore/core"
import { Context, Effect, Layer, Option, Result, Schema, Stream } from "effect"
import { ChromeApi } from "../chrome/ChromeApi.ts"
import { companionStatusKey, runIndexKey, runKey, runKeyPrefix } from "./keys.ts"
import { decodeStored, type StoreKey } from "./StoreKey.ts"

/** Every stored run, oldest first. */
export interface RunList {
  readonly runs: ReadonlyArray<Run>
  /** Runs whose stored value can't be read (the worker backs them up). */
  readonly unreadable: ReadonlyArray<StoreUnreadable>
}

const decodeCompanionOption = Schema.decodeUnknownOption(CompanionStatus)

export class StoreReader extends Context.Service<StoreReader, {
  /** The key's current value; its `empty` value when nothing is stored. */
  readonly get: <A>(key: StoreKey<A>) => Effect.Effect<A, StoreUnreadable | BrowserError>
  /**
   * The current value, then the value after every change. Subscribes before reading, so no
   * change is missed. Fails (and ends) if a stored value can't be read.
   */
  readonly watch: <A>(key: StoreKey<A>) => Stream.Stream<A, StoreUnreadable | BrowserError>
  /** Every stored run. Fails only if the run index can't be read. */
  readonly runs: Effect.Effect<RunList, StoreUnreadable | BrowserError>
  /**
   * The stored runs now, then after every change to a run or the index. Only changed runs are
   * decoded again. Fails (and ends) only if the run index can't be read.
   */
  readonly watchRuns: Stream.Stream<RunList, StoreUnreadable | BrowserError>
  /**
   * The worker's link to the companion (from `chrome.storage.session`) now, then after every
   * change. `Checking` until the worker has written one.
   */
  readonly watchCompanion: Stream.Stream<CompanionStatus, BrowserError>
}>()("@wherefore/extension/StoreReader") {
  static readonly layer: Layer.Layer<StoreReader, never, ChromeApi> = Layer.effect(StoreReader)(
    Effect.gen(function*() {
      const local = (yield* ChromeApi).storage.local
      const decodeResult = <A>(key: StoreKey<A>, raw: unknown): Result.Result<A, StoreUnreadable> => {
        const result = decodeStored(key, raw)
        return result._tag === "Success"
          ? Result.succeed(result.success.value)
          : Result.fail(new StoreUnreadable({ key: key.name, message: result.failure }))
      }
      const decode = <A>(key: StoreKey<A>, raw: unknown): Effect.Effect<A, StoreUnreadable> => {
        const result = decodeResult(key, raw)
        return result._tag === "Success" ? Effect.succeed(result.success) : Effect.fail(result.failure)
      }
      const get = <A>(key: StoreKey<A>) => Effect.flatMap(local.get(key.name), (stored) => decode(key, stored[key.name]))
      const watch = <A>(key: StoreKey<A>): Stream.Stream<A, StoreUnreadable | BrowserError> =>
        Stream.unwrap(Effect.gen(function*() {
          const changes = yield* local.changes
          const current = yield* get(key)
          const updates = Stream.fromQueue(changes).pipe(
            Stream.filter((change) => Object.hasOwn(change, key.name)),
            Stream.mapEffect((change) => decode(key, change[key.name]?.newValue))
          )
          return Stream.concat(Stream.succeed(current), updates)
        }))

      type Decoded = ReadonlyMap<RunId, Result.Result<Run | undefined, StoreUnreadable>>

      /** The runs in `index`: the ones in `known` as they are, the rest read in one call. */
      const load = (index: ReadonlyArray<RunIndexEntry>, known: Decoded) =>
        Effect.gen(function*() {
          const missing = index.filter((entry) => !known.has(entry.id)).map((entry) => runKey(entry.id))
          const stored = missing.length === 0 ? {} : yield* local.get(missing.map((key) => key.name))
          const decoded = new Map<RunId, Result.Result<Run | undefined, StoreUnreadable>>()
          for (const entry of index) {
            const key = runKey(entry.id)
            decoded.set(entry.id, known.get(entry.id) ?? decodeResult(key, stored[key.name]))
          }
          return decoded as Decoded
        })

      const listOf = (index: ReadonlyArray<RunIndexEntry>, decoded: Decoded): RunList => {
        const runs: Array<Run> = []
        const unreadable: Array<StoreUnreadable> = []
        for (const entry of index) {
          const result = decoded.get(entry.id)
          if (result === undefined) continue
          if (result._tag === "Failure") unreadable.push(result.failure)
          // A run the index names but storage doesn't have (pruned meanwhile) is left out.
          else if (result.success !== undefined) runs.push(result.success)
        }
        return { runs, unreadable }
      }

      const runs = Effect.gen(function*() {
        const index = yield* get(runIndexKey)
        return listOf(index, yield* load(index, new Map()))
      })

      const touchesRuns = (name: string) => name === runIndexKey.name || name.startsWith(runKeyPrefix)

      const watchRuns: Stream.Stream<RunList, StoreUnreadable | BrowserError> = Stream.unwrap(Effect.gen(function*() {
        const changes = yield* local.changes
        let index = yield* get(runIndexKey)
        let decoded = yield* load(index, new Map())
        const updates = Stream.fromQueue(changes).pipe(
          Stream.filter((change) => Object.keys(change).some(touchesRuns)),
          Stream.mapEffect((change) =>
            Effect.gen(function*() {
              if (Object.hasOwn(change, runIndexKey.name)) {
                index = yield* decode(runIndexKey, change[runIndexKey.name]?.newValue)
              }
              const known = new Map(decoded)
              for (const entry of index) {
                const key = runKey(entry.id)
                if (Object.hasOwn(change, key.name)) known.set(entry.id, decodeResult(key, change[key.name]?.newValue))
              }
              decoded = yield* load(index, known)
              return listOf(index, decoded)
            })
          )
        )
        return Stream.concat(Stream.succeed(listOf(index, decoded)), updates)
      }))

      const session = (yield* ChromeApi).storage.session
      const checking: CompanionStatus = { _tag: "Checking" }
      const decodeCompanion = (raw: unknown): CompanionStatus =>
        Option.getOrElse(decodeCompanionOption(raw), () => checking)
      const watchCompanion: Stream.Stream<CompanionStatus, BrowserError> = Stream.unwrap(Effect.gen(function*() {
        const changes = yield* session.changes
        const current = decodeCompanion((yield* session.get(companionStatusKey))[companionStatusKey])
        const updates = Stream.fromQueue(changes).pipe(
          Stream.filter((change) => Object.hasOwn(change, companionStatusKey)),
          Stream.map((change) => decodeCompanion(change[companionStatusKey]?.newValue))
        )
        return Stream.concat(Stream.succeed(current), updates)
      }))

      return StoreReader.of({ get, watch, runs, watchRuns, watchCompanion })
    })
  )
}

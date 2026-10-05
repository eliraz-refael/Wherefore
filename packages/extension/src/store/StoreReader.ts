/**
 * The read half of the Store, for views (side panel, full page) and the worker alike.
 *
 * Views read `chrome.storage.local` directly and follow `storage.onChanged`; only the worker
 * writes (architecture A4/A5). So this half never writes: an old version is migrated in memory
 * (the worker writes it back), and an unreadable value is reported without a backup (the worker
 * makes the backup when it reads it). PR 4 backs Atoms with `watch`.
 */
import { type BrowserError, StoreUnreadable } from "@wherefore/core"
import { Context, Effect, Layer, Stream } from "effect"
import { ChromeApi } from "../chrome/ChromeApi.ts"
import { decodeStored, type StoreKey } from "./StoreKey.ts"

export class StoreReader extends Context.Service<StoreReader, {
  /** The key's current value; its `empty` value when nothing is stored. */
  readonly get: <A>(key: StoreKey<A>) => Effect.Effect<A, StoreUnreadable | BrowserError>
  /**
   * The current value, then the value after every change. Subscribes before reading, so no
   * change is missed. Fails (and ends) if a stored value can't be read.
   */
  readonly watch: <A>(key: StoreKey<A>) => Stream.Stream<A, StoreUnreadable | BrowserError>
}>()("@wherefore/extension/StoreReader") {
  static readonly layer: Layer.Layer<StoreReader, never, ChromeApi> = Layer.effect(StoreReader)(
    Effect.gen(function*() {
      const chrome = yield* ChromeApi
      const decode = <A>(key: StoreKey<A>, raw: unknown): Effect.Effect<A, StoreUnreadable> => {
        const result = decodeStored(key, raw)
        return result._tag === "Success"
          ? Effect.succeed(result.success.value)
          : Effect.fail(new StoreUnreadable({ key: key.name, message: result.failure }))
      }
      const get = <A>(key: StoreKey<A>) =>
        Effect.flatMap(chrome.storage.local.get(key.name), (stored) => decode(key, stored[key.name]))
      const watch = <A>(key: StoreKey<A>): Stream.Stream<A, StoreUnreadable | BrowserError> =>
        Stream.unwrap(Effect.gen(function*() {
          const changes = yield* chrome.storage.local.changes
          const current = yield* get(key)
          const updates = Stream.fromQueue(changes).pipe(
            Stream.filter((change) => Object.hasOwn(change, key.name)),
            Stream.mapEffect((change) => decode(key, change[key.name]?.newValue))
          )
          return Stream.concat(Stream.succeed(current), updates)
        }))
      return StoreReader.of({ get, watch })
    })
  )
}

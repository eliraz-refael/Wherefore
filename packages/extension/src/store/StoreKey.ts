/**
 * Versioned keys in `chrome.storage.local` (architecture A5).
 *
 * Each key is stored as `{ version, data }`: one version for the whole value, not per item.
 * Reading decodes the envelope, runs the key's migrations from the stored version up to the
 * current one (on the stored JSON form), then decodes `data` with the key's schema.
 *
 * Adding a key is one `StoreKey` value in keys.ts. Changing a key's shape is:
 * bump `version`, add `migrations[oldVersion]`, update the schema.
 */
import { Result, Schema } from "effect"

export interface StoreKey<A> {
  /** The storage key. */
  readonly name: string
  /** The current version, from 1. */
  readonly version: number
  /** Decodes the current version's `data`. Its encoded form must be plain JSON. */
  readonly schema: Schema.Codec<A, unknown>
  /** `migrations[v]` turns data stored at version `v` into version `v + 1`. Pure; may throw. */
  readonly migrations: Readonly<Record<number, (data: unknown) => unknown>>
  /** The value when nothing is stored yet. */
  readonly empty: A
}

export const Envelope = Schema.Struct({
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  data: Schema.Unknown
})
export type Envelope = typeof Envelope.Type

export interface Decoded<A> {
  readonly value: A
  /** The stored version when it was older than the current one, so the value should be written back. */
  readonly migratedFrom: number | undefined
}

const decodeEnvelope = Schema.decodeUnknownExit(Envelope)
const messageOf = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause))

/**
 * A stored value (as read from storage; `undefined` when absent) decoded to the current version.
 * Fails with a message saying why it can't be read. Never throws.
 */
export const decodeStored = <A>(key: StoreKey<A>, raw: unknown): Result.Result<Decoded<A>, string> => {
  if (raw === undefined) return Result.succeed({ value: key.empty, migratedFrom: undefined })
  const envelope = decodeEnvelope(raw)
  if (envelope._tag === "Failure") return Result.fail(`not a versioned value: ${String(envelope.cause)}`)
  const { version, data } = envelope.value
  if (version > key.version) {
    return Result.fail(`stored at version ${version}, newer than this build's ${key.version}`)
  }
  let current = data
  for (let v = version; v < key.version; v++) {
    const migrate = key.migrations[v]
    if (migrate === undefined) return Result.fail(`no migration from version ${v}`)
    try {
      current = migrate(current)
    } catch (cause) {
      return Result.fail(`migration from version ${v} failed: ${messageOf(cause)}`)
    }
  }
  const decoded = Schema.decodeUnknownExit(key.schema)(current)
  if (decoded._tag === "Failure") return Result.fail(`doesn't match version ${key.version}: ${String(decoded.cause)}`)
  return Result.succeed({ value: decoded.value, migratedFrom: version < key.version ? version : undefined })
}

/** The stored form of a current-version value. */
export const encodeStored = <A>(key: StoreKey<A>, value: A): Envelope => ({
  version: key.version,
  data: Schema.encodeSync(key.schema)(value)
})

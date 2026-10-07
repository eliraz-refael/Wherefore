/**
 * The registry of live brokers: a directory with one `<profileId>.json` per broker (paths.ts),
 * so an MCP server (M2 PR B) or `status` can find every connected Chrome profile.
 *
 * - **User-only.** On macOS and Linux the directory is created 0700 and checked before use: it
 *   must be a real directory (not a symlink) owned by this user, and nobody else may have access.
 *   A looser mode on our own directory is tightened; anything else is refused. Entries are 0600.
 * - **Written last, removed first.** A broker registers after its socket listens, and removes its
 *   entry before it stops. Entries are written atomically (temp file + rename).
 * - **Robust to crashes.** A broker killed without cleanup (Windows terminates hosts outright)
 *   leaves its entry behind. `list` drops an entry whose process is gone or whose socket refuses
 *   connections, and removes socket files whose process is gone.
 * - **Newest wins.** A second broker for the same profile (Chrome reconnected before the old one
 *   exited) overwrites the entry. The old one removes the entry on exit only if it is still its
 *   own.
 */
import * as Fs from "node:fs/promises"
import * as Net from "node:net"
import { BrokerInfo, ProfileId } from "@wherefore/core"
import { Effect, Schema } from "effect"
import { type Location, pathFor, pidOfSocketFile, registryDir } from "../paths.ts"

export class RegistryError extends Schema.TaggedError<RegistryError>()("RegistryError", {
  message: Schema.String
}) {}

/**
 * One broker, as registered: its identity, where to reach it, and the access token every request
 * must carry (core broker.ts). The entry is user-only, so only this user's processes learn the
 * token. Entries without one (a broker from before M2 PR B) don't decode and are pruned.
 */
export const RegistryEntry = Schema.Struct({
  ...BrokerInfo.fields,
  profileId: ProfileId,
  /** The Unix socket path or Windows pipe name. */
  socket: Schema.String,
  token: Schema.NonEmptyString
})
export type RegistryEntry = typeof RegistryEntry.Type

const decodeEntry = Schema.decodeUnknownExit(Schema.fromJsonString(RegistryEntry))
const encodeEntry = Schema.encodeSync(Schema.fromJsonString(RegistryEntry))

/** What a connection attempt says about a socket. */
export type Probe = "live" | "dead" | "unknown"

export interface RegistryDeps {
  readonly location: Location
  /** Whether a process exists. */
  readonly isAlive: (pid: number) => boolean
  /** Tries to connect to a socket. */
  readonly probe: (socket: string) => Effect.Effect<Probe>
}

export const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, it just isn't ours to signal.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** Connects and hangs up. Refused or missing means no broker is there; anything else is unknown. */
export const probe = (socket: string): Effect.Effect<Probe> =>
  Effect.callback<Probe>((resume) => {
    const connection = Net.connect({ path: socket })
    const done = (result: Probe) => {
      clearTimeout(timer)
      connection.destroy()
      resume(Effect.succeed(result))
    }
    const timer = setTimeout(() => done("unknown"), 1000)
    connection.once("connect", () => done("live"))
    connection.once("error", (error: NodeJS.ErrnoException) =>
      done(error.code === "ECONNREFUSED" || error.code === "ENOENT" ? "dead" : "unknown"))
  })

export const liveDeps = (location: Location): RegistryDeps => ({ location, isAlive, probe })

const fail = (what: string) => (cause: unknown) =>
  new RegistryError({ message: `${what}: ${cause instanceof Error ? cause.message : String(cause)}` })

const removeQuietly = (path: string) => Effect.promise(() => Fs.rm(path, { force: true }).catch(() => undefined))

export interface Listing {
  /** Brokers whose process is running and whose socket answered (or couldn't be checked). */
  readonly live: ReadonlyArray<RegistryEntry & { readonly probe: Probe }>
  /** Entries and socket files removed because their broker is gone. */
  readonly removed: ReadonlyArray<string>
}

export const makeRegistry = ({ location, isAlive, probe }: RegistryDeps) => {
  const path = pathFor(location.platform)
  const dir = registryDir(location)
  const unix = location.platform !== "win32"
  const entryPath = (profileId: ProfileId) => path.join(dir, `${profileId}.json`)

  /** Creates the directory if needed and checks that only this user can use it. */
  const ensureDir = Effect.gen(function*() {
    yield* Effect.tryPromise({ try: () => Fs.mkdir(dir, { recursive: true, mode: 0o700 }), catch: fail(`cannot create ${dir}`) })
    if (!unix) return
    const stat = yield* Effect.tryPromise({ try: () => Fs.lstat(dir), catch: fail(`cannot inspect ${dir}`) })
    if (!stat.isDirectory()) return yield* new RegistryError({ message: `${dir} is not a directory` })
    const uid = process.getuid?.()
    if (uid !== undefined && stat.uid !== uid) {
      return yield* new RegistryError({ message: `${dir} belongs to another user; refusing to use it` })
    }
    if ((stat.mode & 0o077) !== 0) {
      yield* Effect.tryPromise({ try: () => Fs.chmod(dir, 0o700), catch: fail(`cannot make ${dir} private`) })
    }
  })

  const register = (entry: RegistryEntry) =>
    Effect.gen(function*() {
      const target = entryPath(entry.profileId)
      const temp = `${target}.${entry.pid}.tmp`
      yield* Effect.tryPromise({
        try: async () => {
          await Fs.writeFile(temp, encodeEntry(entry), { mode: 0o600 })
          await Fs.rename(temp, target)
        },
        catch: fail(`cannot write ${target}`)
      }).pipe(Effect.tapError(() => removeQuietly(temp)))
    })

  const read = (file: string) =>
    Effect.map(
      Effect.promise(() => Fs.readFile(file, "utf8").catch(() => undefined)),
      (text) => {
        if (text === undefined) return undefined
        const decoded = decodeEntry(text)
        return decoded._tag === "Success" ? decoded.value : null
      }
    )

  /** Removes the entry only if it is still this broker's, and this broker's socket file. Never fails. */
  const unregister = (entry: RegistryEntry) =>
    Effect.gen(function*() {
      const target = entryPath(entry.profileId)
      const current = yield* read(target)
      if (current !== undefined && current !== null && current.pid === entry.pid && current.socket === entry.socket) {
        yield* removeQuietly(target)
      }
      if (unix) yield* removeQuietly(entry.socket)
    })

  const list: Effect.Effect<Listing, RegistryError> = Effect.gen(function*() {
    const names = yield* Effect.tryPromise({
      try: () => Fs.readdir(dir).catch((error: NodeJS.ErrnoException) => (error.code === "ENOENT" ? [] : Promise.reject(error))),
      catch: fail(`cannot read ${dir}`)
    })
    const live: Array<RegistryEntry & { readonly probe: Probe }> = []
    const removed: Array<string> = []
    for (const name of names.sort()) {
      const file = path.join(dir, name)
      if (name.endsWith(".json")) {
        const entry = yield* read(file)
        if (entry === undefined) continue
        // Unreadable: not ours, or a stray file. Entries are written atomically, so never half-written.
        if (entry === null) {
          yield* removeQuietly(file)
          removed.push(file)
          continue
        }
        const state = isAlive(entry.pid) ? yield* probe(entry.socket) : "dead"
        if (state === "dead") {
          yield* removeQuietly(file)
          removed.push(file)
          if (unix) yield* removeQuietly(entry.socket)
        } else {
          live.push({ ...entry, probe: state })
        }
      } else if (/\.json\.\d+\.tmp$/.test(name)) {
        // A registration that crashed between write and rename.
        const pid = Number(/\.(\d+)\.tmp$/.exec(name)?.[1])
        if (!isAlive(pid)) {
          yield* removeQuietly(file)
          removed.push(file)
        }
      } else if (unix) {
        const pid = pidOfSocketFile(name)
        if (pid !== undefined && !isAlive(pid)) {
          yield* removeQuietly(file)
          removed.push(file)
        }
      }
    }
    return { live, removed }
  })

  /**
   * The registered brokers whose process is running, read-only: no probes, nothing removed. For
   * callers that connect anyway (the MCP server) and treat a refused connection as a gone broker.
   */
  const entries: Effect.Effect<ReadonlyArray<RegistryEntry>> = Effect.gen(function*() {
    const names = yield* Effect.promise(() => Fs.readdir(dir).catch(() => [] as Array<string>))
    const found: Array<RegistryEntry> = []
    for (const name of names.sort()) {
      if (!name.endsWith(".json")) continue
      const entry = yield* read(path.join(dir, name))
      if (entry !== undefined && entry !== null && isAlive(entry.pid)) found.push(entry)
    }
    return found
  })

  return { dir, ensureDir, register, unregister, list, entries, entryPath }
}

export type Registry = ReturnType<typeof makeRegistry>

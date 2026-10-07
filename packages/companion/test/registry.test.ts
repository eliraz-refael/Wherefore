import { spawnSync } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as Net from "node:net"
import * as NodePath from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { NATIVE_PROTOCOL_VERSION, type ProfileId } from "@wherefore/core"
import { Effect } from "effect"
import { isAlive, liveDeps, makeRegistry, type RegistryEntry } from "../src/broker/registry.ts"
import { type Location, registryDir, socketPath } from "../src/paths.ts"
import { PROFILE, tempLocation } from "./fakes.ts"

const OTHER = "bbbbbbbbbbbbbbbbbbbbbbbbbb" as ProfileId
const THIRD = "cccccccccccccccccccccccccc" as ProfileId

/** The pid of a process that has exited. */
const deadPid = (): number => {
  const child = spawnSync(process.execPath, ["-e", ""])
  if (child.pid === undefined) throw new Error("couldn't spawn")
  return child.pid
}

const entryFor = (location: Location, profileId: ProfileId, pid: number): RegistryEntry => ({
  profileId,
  extensionVersion: "1",
  companionVersion: "1",
  protocol: NATIVE_PROTOCOL_VERSION,
  pid,
  startedAt: 0,
  socket: socketPath(location, profileId, pid),
  token: "test-token"
})

const exists = (path: string) => Effect.promise(() => Fs.stat(path).then(() => true, () => false))

/** A socket that accepts connections, until the scope closes. */
const listen = (path: string) =>
  Effect.acquireRelease(
    Effect.callback<Net.Server>((resume) => {
      const server = Net.createServer((connection) => connection.end())
      server.listen(path, () => {
        resume(Effect.succeed(server))
      })
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void))
      })
  )

describe("broker registry", () => {
  it.live("creates a user-only directory, and tightens a loose one it owns", () =>
    Effect.gen(function*() {
      if (process.platform === "win32") return
      const location = yield* tempLocation
      const registry = makeRegistry(liveDeps(location))
      yield* registry.ensureDir
      expect((yield* Effect.promise(() => Fs.stat(registry.dir))).mode & 0o777).toBe(0o700)
      yield* Effect.promise(() => Fs.chmod(registry.dir, 0o755))
      yield* registry.ensureDir
      expect((yield* Effect.promise(() => Fs.stat(registry.dir))).mode & 0o777).toBe(0o700)
    }))

  it.live("refuses a registry directory that is a symlink", () =>
    Effect.gen(function*() {
      if (process.platform === "win32") return
      const location = yield* tempLocation
      const elsewhere = yield* tempLocation
      yield* Effect.promise(() => Fs.symlink(elsewhere.home, registryDir(location)))
      const failure = yield* Effect.flip(makeRegistry(liveDeps(location)).ensureDir)
      expect(failure.message).toContain("is not a directory")
    }))

  it.live("drops entries whose broker is gone (process dead, or nothing listening) and keeps live ones", () =>
    Effect.gen(function*() {
      if (process.platform === "win32") return
      const location = yield* tempLocation
      const registry = makeRegistry(liveDeps(location))
      yield* registry.ensureDir
      const dir = registry.dir

      // Live: this process, listening.
      const live = entryFor(location, PROFILE, process.pid)
      yield* listen(live.socket)
      yield* registry.register(live)
      // Crashed: its process is gone, its socket file left behind.
      const crashed = entryFor(location, OTHER, deadPid())
      yield* Effect.promise(() => Fs.writeFile(crashed.socket, ""))
      yield* registry.register(crashed)
      // Pid reused by some other process: alive, but nobody listens on the socket.
      const reused = { ...entryFor(location, THIRD, process.pid), socket: NodePath.join(dir, `${THIRD}.1.sock`) }
      yield* registry.register(reused)
      // Leftovers: an orphan socket, a half-done registration and a stray file.
      const orphan = NodePath.join(dir, `${OTHER}.${deadPid()}.sock`)
      yield* Effect.promise(() => Fs.writeFile(orphan, ""))
      const temp = NodePath.join(dir, `${OTHER}.json.${deadPid()}.tmp`)
      yield* Effect.promise(() => Fs.writeFile(temp, "{"))
      const junk = NodePath.join(dir, "junk.json")
      yield* Effect.promise(() => Fs.writeFile(junk, "not json"))

      const { live: found, removed } = yield* registry.list
      expect(found.map((entry) => [entry.profileId, entry.probe])).toEqual([[PROFILE, "live"]])
      expect([...removed].sort()).toEqual(
        [registry.entryPath(OTHER), crashed.socket, registry.entryPath(THIRD), orphan, temp, junk].sort()
      )
      expect(yield* exists(crashed.socket)).toBe(false)
      expect(yield* exists(live.socket)).toBe(true)
      expect(yield* exists(registry.entryPath(PROFILE))).toBe(true)
    }))

  it.live("keeps an entry whose socket couldn't be checked", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      const registry = makeRegistry({ location, isAlive: () => true, probe: () => Effect.succeed("unknown") })
      yield* registry.ensureDir
      yield* registry.register(entryFor(location, PROFILE, 123))
      const { live } = yield* registry.list
      expect(live.map((entry) => entry.probe)).toEqual(["unknown"])
    }))

  it.live("unregisters only its own entry: a newer broker for the same profile stays", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      const registry = makeRegistry(liveDeps(location))
      yield* registry.ensureDir
      const older = entryFor(location, PROFILE, 111)
      const newer = entryFor(location, PROFILE, 222)
      yield* registry.register(older)
      yield* registry.register(newer)
      yield* registry.unregister(older)
      const stored = JSON.parse(yield* Effect.promise(() => Fs.readFile(registry.entryPath(PROFILE), "utf8")))
      expect(stored.pid).toBe(222)
      yield* registry.unregister(newer)
      expect(yield* exists(registry.entryPath(PROFILE))).toBe(false)
    }))

  it("tells live processes from dead ones", () => {
    expect(isAlive(process.pid)).toBe(true)
    expect(isAlive(deadPid())).toBe(false)
  })

  it.live("lists nothing when no broker ever ran", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      expect(yield* makeRegistry(liveDeps(location)).list).toEqual({ live: [], removed: [] })
    }))
})

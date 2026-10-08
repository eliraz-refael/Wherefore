/**
 * Carries out an install or uninstall plan (plan.ts) on the real file system and registry, and
 * reads back what is installed for `status`. Commands run without a shell. `install` also copies
 * the running CLI to its stable place and prunes older copies (plan.ts explains which).
 */
import { execFile } from "node:child_process"
import * as Fs from "node:fs/promises"
import { EXTENSION_ORIGIN, NATIVE_HOST_NAME } from "@wherefore/core"
import { Effect, Schema } from "effect"
import { type Location, pathFor, platformOf, stateDir } from "../paths.ts"
import {
  browserTargets,
  claudeMcpAdd,
  cliTarget,
  type Command,
  copiesDir,
  type InstallPlan,
  isCheckoutBuild,
  isVersionName,
  keptVersions,
  launcherPath,
  manifestFileName,
  planInstall,
  prunableCopies,
  registryQuery,
  type UninstallPlan,
  windowsManifestPath,
  wrapperPath,
  wrapperTargets
} from "./plan.ts"

export class InstallError extends Schema.TaggedError<InstallError>()("InstallError", {
  message: Schema.String
}) {}

export interface CommandResult {
  readonly ok: boolean
  readonly output: string
}

/** Runs a command (no shell) and reports whether it exited 0. Never fails. */
export type RunCommand = (command: Command) => Effect.Effect<CommandResult>

export const runCommand: RunCommand = (command) =>
  Effect.callback<CommandResult>((resume) => {
    execFile(command.file, [...command.args], { windowsHide: true }, (error, stdout, stderr) => {
      resume(Effect.succeed({ ok: error === null, output: `${stdout}${stderr}`.trim() }))
    })
  })

const attempt = <A>(what: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => new InstallError({ message: `${what}: ${cause instanceof Error ? cause.message : String(cause)}` })
  })

const exists = (path: string) => Effect.promise(() => Fs.stat(path).then(() => true, () => false))

export interface Registered {
  readonly browser: string
  readonly where?: string
  readonly skipped?: string
  readonly failed?: string
}

export const applyInstall = (location: Location, plan: InstallPlan, run: RunCommand) =>
  Effect.gen(function*() {
    const posix = location.platform !== "win32"
    for (const [index, dir] of plan.dirs.entries()) {
      // The state directory (first) holds the broker registry: user-only.
      yield* attempt(`cannot create ${dir}`, () => Fs.mkdir(dir, { recursive: true, ...(index === 0 ? { mode: 0o700 } : {}) }))
    }
    for (const file of plan.files) {
      // Atomically (a temporary file, then a rename): Chrome may start the wrapper, and Claude Code
      // the launcher, while `install` rewrites them; a shell reading one mid-write would run half.
      yield* attempt(`cannot write ${file.path}`, async () => {
        const temp = `${file.path}.${process.pid}.tmp`
        try {
          await Fs.writeFile(temp, file.content, { mode: file.mode })
          if (posix) await Fs.chmod(temp, file.mode)
          await Fs.rename(temp, file.path)
        } catch (error) {
          await Fs.rm(temp, { force: true })
          throw error
        }
      })
    }
    const failedBrowsers = new Map<string, string>()
    for (const command of plan.commands) {
      const result = yield* run(command)
      if (!result.ok) failedBrowsers.set(command.browser, result.output || "the command failed")
    }
    return plan.report.map((entry): Registered => {
      const failed = failedBrowsers.get(entry.browser)
      return failed === undefined ? entry : { browser: entry.browser, failed }
    })
  })

const scriptTargets = (location: Location, file: string) =>
  Effect.map(
    Effect.promise(() => Fs.readFile(file, "utf8").catch(() => undefined)),
    (script) => (script === undefined ? undefined : wrapperTargets(location.platform, script))
  )

/** The Node and CLI the installed wrapper starts, if there is a wrapper `install` wrote. */
export const installedWrapper = (location: Location) => scriptTargets(location, wrapperPath(location))

/** The Node and CLI the launcher runs, if `install` wrote one. */
export const installedLauncher = (location: Location) => scriptTargets(location, launcherPath(location))

const versionsIn = (dir: string) =>
  Effect.map(
    Effect.promise(() => Fs.readdir(dir).catch(() => [] as Array<string>)),
    (names) => names.filter(isVersionName).sort()
  )

/** The versions in the copies directory, oldest name first. */
export const installedCopies = (location: Location) => versionsIn(copiesDir(location))

/**
 * Copies the running CLI to `to`, atomically (a temporary file, then a rename), so a broker
 * starting from it meanwhile reads the old file or the new one, never half of one. The bundle is
 * an ES module: a `package.json` next to it says so, whatever package.json sits above the state
 * directory.
 */
export const copyCli = (platform: Location["platform"], from: string, to: string) =>
  attempt(`cannot copy ${from} to ${to}`, async () => {
    const path = pathFor(platform)
    const dir = path.dirname(to)
    await Fs.mkdir(dir, { recursive: true, mode: 0o700 })
    await Fs.writeFile(path.join(dir, "package.json"), `${JSON.stringify({ type: "module" })}\n`, { mode: 0o644 })
    const temp = `${to}.${process.pid}.tmp`
    try {
      await Fs.copyFile(from, temp)
      if (platform !== "win32") await Fs.chmod(temp, 0o755)
      await Fs.rename(temp, to)
    } catch (error) {
      await Fs.rm(temp, { force: true })
      throw error
    }
  })

/**
 * Removes the copies in `copies` (a copies directory) not in `kept`; entries that aren't version
 * directories are left alone. Never fails: a copy that can't be removed is reported.
 */
const removeCopies = (platform: Location["platform"], copies: string, kept: ReadonlySet<string>) =>
  Effect.gen(function*() {
    const path = pathFor(platform)
    const names = yield* versionsIn(copies)
    const removed: Array<string> = []
    const failed: Array<string> = []
    for (const name of prunableCopies(names, kept)) {
      const dir = path.join(copies, name)
      const ok = yield* Effect.promise(() => Fs.rm(dir, { recursive: true, force: true }).then(() => true, () => false))
      if (ok) removed.push(dir)
      else failed.push(dir)
    }
    return { removed, failed }
  })

/** Removes the copies not in `kept`. Never fails: a copy that can't be removed is reported. */
export const pruneCopies = (location: Location, kept: ReadonlySet<string>) =>
  removeCopies(location.platform, copiesDir(location), kept)

export interface InstallInput {
  /** The CLI file that is running `install` (resolved). */
  readonly running: string
  readonly version: string
  /** The Node to pin (plan.ts `stableNode`). */
  readonly node: string
  readonly env: Readonly<Record<string, string | undefined>>
  /** The versions live brokers report (registry entries): their copies are kept. */
  readonly liveVersions: ReadonlyArray<string>
  readonly exists: (path: string) => boolean
  readonly run: RunCommand
}

export interface InstallReport {
  /** What the wrapper runs now. */
  readonly cli: string
  /** Whether `install` copied the running CLI there. */
  readonly copied: boolean
  /** Whether it runs a checkout's build in place. */
  readonly checkout: boolean
  /** What the wrapper ran before, if there was one. */
  readonly previous: string | undefined
  /** The launcher, which runs `cli` too. */
  readonly launcher: string
  /** The line that adds the MCP server to Claude Code: the same for every install in this state directory. */
  readonly mcpCommand: string
  /**
   * An install from before the launcher was here: a `claude mcp add` line from then named a Node
   * and a `cli.js`, which may be gone.
   */
  readonly migrated: boolean
  readonly registered: ReadonlyArray<Registered>
  readonly pruned: { readonly removed: ReadonlyArray<string>; readonly failed: ReadonlyArray<string> }
}

/**
 * `install`: copy the CLI to its stable place (unless it runs from a checkout), write the wrapper
 * and manifests that point at it, then prune the copies nothing needs any more.
 */
export const installCompanion = (location: Location, input: InstallInput) =>
  Effect.gen(function*() {
    // A relative WHEREFORE_HOME would resolve against whatever directory Chrome or Claude Code
    // starts the wrapper or launcher in: bake the state directory this install uses.
    const home = input.env["WHEREFORE_HOME"]
    const env = home !== undefined && home !== "" ? { ...input.env, WHEREFORE_HOME: stateDir(location) } : input.env
    const previous = (yield* installedWrapper(location))?.cli
    const hadLauncher = yield* exists(launcherPath(location))
    const checkout = isCheckoutBuild(location.platform, input.running, input.exists)
    const target = cliTarget(location, input.running, input.version, checkout)
    if (target.copy) yield* copyCli(location.platform, input.running, target.cli)
    const plan = planInstall(location, { node: input.node, cli: target.cli, env }, input.exists)
    const registered = yield* applyInstall(location, plan, input.run)
    const pruned = yield* pruneCopies(
      location,
      keptVersions(location, { installed: target.cli, previous, live: input.liveVersions })
    )
    return {
      cli: target.cli,
      copied: target.copy,
      checkout,
      previous,
      launcher: launcherPath(location),
      mcpCommand: claudeMcpAdd(location),
      migrated: previous !== undefined && !hadLauncher,
      registered,
      pruned
    } satisfies InstallReport
  })

export const applyUninstall = (plan: UninstallPlan, run: RunCommand) =>
  Effect.gen(function*() {
    const removed: Array<string> = []
    for (const file of plan.files) {
      if (!(yield* exists(file))) continue
      yield* attempt(`cannot remove ${file}`, () => Fs.rm(file, { force: true }))
      removed.push(file)
    }
    for (const dir of plan.dirs) {
      if (!(yield* exists(dir))) continue
      // Only the version directories `install` made, then the directory if that empties it:
      // anything else someone put there stays.
      const copies = yield* removeCopies(platformOf(process.platform), dir, new Set())
      if (copies.failed.length > 0) {
        return yield* new InstallError({ message: `cannot remove ${copies.failed.join(", ")}` })
      }
      const empty = yield* Effect.promise(() => Fs.rmdir(dir).then(() => true, () => false))
      if (empty) removed.push(dir)
      else removed.push(...copies.removed)
    }
    for (const command of plan.commands) {
      // Deleting a key that isn't there fails; that is the state we want anyway.
      const result = yield* run(command)
      if (result.ok) removed.push(command.args[1] ?? command.browser)
    }
    return removed
  })

export type HostState =
  | { readonly _tag: "Installed"; readonly where: string }
  | { readonly _tag: "Different"; readonly where: string; readonly problem: string }
  | { readonly _tag: "Absent" }

export interface BrowserState {
  readonly browser: string
  /** Whether the browser itself looks installed (unknown on Windows). */
  readonly present: boolean | undefined
  readonly host: HostState
}

const checkManifest = (location: Location, file: string) =>
  Effect.gen(function*() {
    const text = yield* Effect.promise(() => Fs.readFile(file, "utf8").catch(() => undefined))
    if (text === undefined) return { _tag: "Absent" } as const
    let parsed: { name?: unknown; path?: unknown; allowed_origins?: unknown }
    try {
      parsed = JSON.parse(text) as typeof parsed
    } catch {
      return { _tag: "Different", where: file, problem: "the manifest isn't valid JSON" } as const
    }
    if (parsed.name !== NATIVE_HOST_NAME) return { _tag: "Different", where: file, problem: "it names another host" } as const
    if (!Array.isArray(parsed.allowed_origins) || !parsed.allowed_origins.includes(EXTENSION_ORIGIN)) {
      return { _tag: "Different", where: file, problem: "it doesn't allow the Wherefore extension" } as const
    }
    if (parsed.path !== wrapperPath(location)) {
      return { _tag: "Different", where: file, problem: `it starts ${String(parsed.path)}` } as const
    }
    const script = yield* Effect.promise(() => Fs.readFile(wrapperPath(location), "utf8").catch(() => undefined))
    if (script === undefined) {
      return { _tag: "Different", where: file, problem: `${wrapperPath(location)} is missing` } as const
    }
    // The wrapper pins a Node and a cli.js; a removed Node version or a moved checkout breaks it.
    const targets = wrapperTargets(location.platform, script)
    if (targets === undefined) {
      return { _tag: "Different", where: file, problem: `${wrapperPath(location)} is from an older install` } as const
    }
    if (!(yield* exists(targets.cli))) {
      return { _tag: "Different", where: file, problem: `the wrapper starts ${targets.cli}, which is gone` } as const
    }
    if (!(yield* exists(targets.node))) {
      return {
        _tag: "Different",
        where: file,
        problem: `the Node it pins (${targets.node}) is gone; it falls back to \`node\` on PATH`
      } as const
    }
    return { _tag: "Installed", where: file } as const
  })

/** Where the host is registered, per browser. */
export const installedHosts = (location: Location, run: RunCommand): Effect.Effect<ReadonlyArray<BrowserState>> =>
  Effect.forEach(browserTargets(location.platform, location.home), (target) =>
    Effect.gen(function*() {
      if (target.registryKey !== undefined) {
        const query = yield* run(registryQuery(target.registryKey))
        const host: HostState = query.ok
          ? yield* checkManifest(location, windowsManifestPath(location))
          : { _tag: "Absent" }
        return { browser: target.browser, present: undefined, host }
      }
      const dir = target.manifestDir ?? ""
      const present = target.configDir === undefined ? undefined : yield* exists(target.configDir)
      const host = yield* checkManifest(location, pathFor(location.platform).join(dir, manifestFileName))
      return { browser: target.browser, present, host }
    }))

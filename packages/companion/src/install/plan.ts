/**
 * What `install` and `uninstall` do, as pure data per OS: which files to write or remove, with
 * what content, and which registry commands to run. `apply.ts` carries a plan out; tests check
 * plans for every OS without touching a real home directory or registry.
 *
 * Chrome finds a native host by its manifest (architecture A3):
 * - macOS and Linux: `<browser config>/NativeMessagingHosts/<name>.json`, per browser.
 * - Windows: a registry key, `HKCU\Software\<browser>\NativeMessagingHosts\<name>`, whose default
 *   value is the manifest's path.
 * The manifest's `path` is a small wrapper script in the state directory, which runs this CLI
 * with the same Node that ran `install`. Chrome launches it with a minimal environment, so the
 * wrapper also sets a few variables from the installing shell, which the ACP agent the broker
 * starts inherits (`PATH` to find `npx`, `CLAUDE_CONFIG_DIR` for the user's Claude Code login), and
 * the pinned Node and CLI (`WHEREFORE_NODE`, `WHEREFORE_CLI`), which the broker gives the agent for
 * its MCP server. API keys are never copied.
 *
 * The wrapper runs a copy of this CLI that `install` keeps in the state directory,
 * `<state>/companion/<version>/cli.js`, not the file that ran `install`: under `npx` that is a
 * cache entry npm may clear, and a global install is replaced by an upgrade. A build in a checkout
 * of the repository (a `src/cli.ts` next to its `dist/`) runs in place instead, so a developer's
 * rebuild takes effect without another `install`. Older copies are pruned, except the one the
 * previous install ran and any a live broker reports: a running broker starts `wherefore mcp`
 * from its own copy for every ACP tidy-up, and a `claude mcp add` line may still point at the
 * previous one.
 *
 * Next to the wrapper, `install` writes a **launcher**, `<state>/bin/wherefore` (`bin\wherefore.cmd`
 * on Windows; in its own folder, so it can't clash with a `Wherefore` folder on a case-insensitive
 * file system): the same pinned Node and CLI, every argument passed on. Claude Code's MCP config names
 * the launcher (`claudeMcpAdd`), so that config never changes when the copy does.
 */
import { EXTENSION_ORIGIN, NATIVE_HOST_NAME } from "@wherefore/core"
import { type Location, pathFor, type Platform, stateDir } from "../paths.ts"

/** Copied from the installing shell into the wrapper, when set. */
export const BAKED_ENV = [
  "PATH",
  "WHEREFORE_HOME",
  "CLAUDE_CONFIG_DIR",
  "XDG_CONFIG_HOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "NODE_EXTRA_CA_CERTS"
] as const

/** A Chromium-family browser we register the host with. */
export interface BrowserTarget {
  readonly browser: string
  /** macOS and Linux: where the manifest goes. */
  readonly manifestDir?: string
  /** macOS and Linux: the browser's own config directory; the manifest is written only if it exists (Chrome always). */
  readonly configDir?: string
  /** Windows: the registry key (without the host name). */
  readonly registryKey?: string
}

export const browserTargets = (platform: Platform, home: string): ReadonlyArray<BrowserTarget> => {
  const path = pathFor(platform)
  const dirTarget = (browser: string, configDir: string): BrowserTarget => ({
    browser,
    configDir,
    manifestDir: path.join(configDir, "NativeMessagingHosts")
  })
  switch (platform) {
    case "darwin": {
      const support = (dir: string) => path.join(home, "Library", "Application Support", dir)
      return [
        dirTarget("Chrome", support("Google/Chrome")),
        dirTarget("Chrome Beta", support("Google/Chrome Beta")),
        dirTarget("Chromium", support("Chromium")),
        dirTarget("Brave", support("BraveSoftware/Brave-Browser")),
        dirTarget("Edge", support("Microsoft Edge")),
        dirTarget("Arc", support("Arc/User Data"))
      ]
    }
    case "linux": {
      const config = (dir: string) => path.join(home, ".config", dir)
      return [
        dirTarget("Chrome", config("google-chrome")),
        dirTarget("Chrome Beta", config("google-chrome-beta")),
        dirTarget("Chromium", config("chromium")),
        dirTarget("Brave", config("BraveSoftware/Brave-Browser")),
        dirTarget("Edge", config("microsoft-edge"))
      ]
    }
    case "win32":
      // Chrome Beta and Canary read Chrome's key on Windows.
      return [
        { browser: "Chrome", registryKey: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts" },
        { browser: "Chromium", registryKey: "HKCU\\Software\\Chromium\\NativeMessagingHosts" },
        { browser: "Brave", registryKey: "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts" },
        { browser: "Edge", registryKey: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts" }
      ]
  }
}

export interface HostManifest {
  readonly name: string
  readonly description: string
  readonly path: string
  readonly type: "stdio"
  readonly allowed_origins: ReadonlyArray<string>
}

export const hostManifest = (wrapper: string): HostManifest => ({
  name: NATIVE_HOST_NAME,
  description: "Wherefore companion: lets local agents reach your tabs through the Wherefore extension",
  path: wrapper,
  type: "stdio",
  allowed_origins: [EXTENSION_ORIGIN]
})

export const manifestFileName = `${NATIVE_HOST_NAME}.json`

export const wrapperPath = (location: Location): string =>
  pathFor(location.platform).join(stateDir(location), location.platform === "win32" ? "native-host.bat" : "native-host.sh")

/** Where `install` keeps its copies of the CLI, one directory per version. */
export const copiesDir = (location: Location): string => pathFor(location.platform).join(stateDir(location), "companion")

/** A copies directory entry that `install` made: a version, e.g. `0.1.0` or `1.2.0-rc.1`. */
const VERSION_NAME = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

export const isVersionName = (name: string): boolean => VERSION_NAME.test(name)

/** The copy of version `version`: `<state>/companion/<version>/cli.js`. */
export const copyPath = (location: Location, version: string): string =>
  pathFor(location.platform).join(copiesDir(location), version, "cli.js")

/** The version of the copy at `cli`, when `cli` is one of `install`'s copies. */
export const copyVersion = (location: Location, cli: string): string | undefined => {
  const path = pathFor(location.platform)
  const parts = path.relative(copiesDir(location), cli).split(path.sep)
  return parts.length === 2 && parts[1] === "cli.js" && parts[0] !== undefined && isVersionName(parts[0]) ? parts[0] : undefined
}

/**
 * Whether `cli` (a bundled `dist/cli.js`) was built in a checkout of the repository: its sources,
 * `src/cli.ts`, sit next to `dist/`. The published package ships no sources.
 */
export const isCheckoutBuild = (platform: Platform, cli: string, exists: (path: string) => boolean): boolean => {
  const path = pathFor(platform)
  return exists(path.join(path.dirname(path.dirname(cli)), "src", "cli.ts"))
}

/** What the wrapper runs, and whether `install` must copy the running CLI there first. */
export interface CliTarget {
  readonly cli: string
  readonly copy: boolean
}

/**
 * The CLI the wrapper should run: a checkout's build in place; anything else (npx's cache, a
 * global install, a tarball) as this version's copy, copied unless it is the copy already.
 */
export const cliTarget = (location: Location, running: string, version: string, checkout: boolean): CliTarget => {
  if (checkout) return { cli: running, copy: false }
  const target = copyPath(location, version)
  const path = pathFor(location.platform)
  const same = location.platform === "win32"
    ? path.resolve(running).toLowerCase() === path.resolve(target).toLowerCase()
    : path.resolve(running) === path.resolve(target)
  return { cli: target, copy: !same }
}

/**
 * The copies to keep: the one installed now, the one the previous wrapper ran (a broker may still
 * be starting from it, and Claude Code's MCP config may point at it), and every version a live
 * broker reports.
 */
export const keptVersions = (
  location: Location,
  input: { readonly installed: string; readonly previous: string | undefined; readonly live: ReadonlyArray<string> }
): ReadonlySet<string> => {
  const kept = new Set(input.live)
  for (const cli of [input.installed, input.previous]) {
    const version = cli === undefined ? undefined : copyVersion(location, cli)
    if (version !== undefined) kept.add(version)
  }
  return kept
}

/** Entries of the copies directory to remove: versions not kept. Anything else is left alone. */
export const prunableCopies = (names: ReadonlyArray<string>, kept: ReadonlySet<string>): ReadonlyArray<string> =>
  names.filter((name) => isVersionName(name) && !kept.has(name)).sort()

/** Where the launcher lives. */
export const launcherDir = (location: Location): string => pathFor(location.platform).join(stateDir(location), "bin")

/** The launcher: runs the installed CLI with any arguments (`claude mcp add` names it). */
export const launcherPath = (location: Location): string =>
  pathFor(location.platform).join(launcherDir(location), location.platform === "win32" ? "wherefore.cmd" : "wherefore")

/** The Windows host manifest lives in the state directory; the registry points at it. */
export const windowsManifestPath = (location: Location): string =>
  pathFor(location.platform).join(stateDir(location), manifestFileName)

/** POSIX single quotes: everything inside is literal; a quote is closed, escaped and reopened. */
export const shQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

/** In a batch file, `%` starts a variable even inside quotes; `%%` is a literal percent sign. */
export const batEscape = (value: string): string => value.replaceAll("%", "%%")

export interface WrapperInput {
  /** The Node binary that ran `install`. */
  readonly node: string
  /** The CLI the wrapper runs: this version's copy, or a checkout's dist/cli.js (`cliTarget`). */
  readonly cli: string
  readonly env: Readonly<Record<string, string | undefined>>
}

/** Variables worth copying: set, and representable in the script. */
export const bakedEnv = (platform: Platform, env: WrapperInput["env"]): ReadonlyArray<readonly [string, string]> =>
  BAKED_ENV.flatMap((name) => {
    const value = env[name]
    if (value === undefined || value === "") return []
    // A batch `set "NAME=value"` can't hold a quote or a line break.
    if (platform === "win32" && /["\r\n]/.test(value)) return []
    return [[name, value] as const]
  })

/**
 * The Node the wrapper should start: an entry on `PATH` that resolves to the same binary as the
 * running one, if there is one. `process.execPath` is the resolved binary, which under Nix
 * (`/nix/store/<hash>-nodejs-22.x/bin/node`), nvm, fnm or Volta is a versioned path that an upgrade
 * or a garbage collection removes; the `PATH` entry (`/run/current-system/sw/bin/node`, a
 * version manager's shim) keeps working across upgrades. `resolve` returns a path's real path, or
 * undefined when it doesn't exist.
 */
export const stableNode = (
  platform: Platform,
  execPath: string,
  pathEnv: string | undefined,
  resolve: (path: string) => string | undefined
): string => {
  const path = pathFor(platform)
  const target = resolve(execPath)
  if (target === undefined || pathEnv === undefined) return execPath
  const names = platform === "win32" ? ["node.exe"] : ["node"]
  for (const dir of pathEnv.split(platform === "win32" ? ";" : ":")) {
    if (dir === "" || !path.isAbsolute(dir)) continue
    for (const name of names) {
      const candidate = path.join(dir, name)
      if (candidate !== execPath && resolve(candidate) === target) return candidate
    }
  }
  return execPath
}

/**
 * The script Chrome launches. Paths are quoted, so spaces (and on POSIX any character) are safe;
 * Chrome's arguments (the caller's origin, and on Windows `--parent-window`) are passed through.
 * If the pinned Node is gone (a version manager removed it, or Nix garbage-collected it), the
 * script falls back to `node` on the baked `PATH` rather than failing to start.
 */
export const wrapperScript = (platform: Platform, input: WrapperInput): string => {
  const env = bakedEnv(platform, input.env)
  if (platform === "win32") {
    return [
      "@echo off",
      "rem Generated by `wherefore install`. Chrome starts this for the Wherefore extension.",
      ...env.map(([name, value]) => `set "${name}=${batEscape(value)}"`),
      `set "WHEREFORE_NODE=${batEscape(input.node)}"`,
      `set "WHEREFORE_CLI=${batEscape(input.cli)}"`,
      'if not exist "%WHEREFORE_NODE%" set "WHEREFORE_NODE=node"',
      '"%WHEREFORE_NODE%" "%WHEREFORE_CLI%" native-host %*',
      ""
    ].join("\r\n")
  }
  return [
    "#!/bin/sh",
    "# Generated by `wherefore install`. Chrome starts this for the Wherefore extension.",
    ...env.map(([name, value]) => `export ${name}=${shQuote(value)}`),
    `node=${shQuote(input.node)}`,
    `cli=${shQuote(input.cli)}`,
    'if [ ! -x "$node" ]; then',
    '  node=$(command -v node) || { echo "wherefore: no Node found (pinned one is gone, none on PATH); run install again" >&2; exit 127; }',
    "fi",
    // The broker starts `wherefore mcp` for ACP agents with these (src/acp/command.ts).
    'export WHEREFORE_NODE="$node" WHEREFORE_CLI="$cli"',
    'exec "$node" "$cli" native-host "$@"',
    ""
  ].join("\n")
}

/**
 * The launcher (`launcherPath`): the installed CLI with the pinned Node, every argument passed on,
 * and `WHEREFORE_HOME` when `install` ran with one, so `<launcher> mcp` finds the same brokers.
 * Like the wrapper, it falls back to `node` on `PATH` if the pinned Node is gone. `wrapperTargets`
 * reads it back too.
 */
export const launcherScript = (platform: Platform, input: WrapperInput): string => {
  const home = input.env["WHEREFORE_HOME"]
  const baked = home !== undefined && home !== "" && !(platform === "win32" && /["\r\n]/.test(home))
  if (platform === "win32") {
    return [
      "@echo off",
      "rem Generated by `wherefore install`: runs the installed Wherefore companion. Claude Code's MCP config names this file.",
      "setlocal",
      ...(baked ? [`set "WHEREFORE_HOME=${batEscape(home)}"`] : []),
      `set "WHEREFORE_NODE=${batEscape(input.node)}"`,
      `set "WHEREFORE_CLI=${batEscape(input.cli)}"`,
      'if not exist "%WHEREFORE_NODE%" set "WHEREFORE_NODE=node"',
      '"%WHEREFORE_NODE%" "%WHEREFORE_CLI%" %*',
      ""
    ].join("\r\n")
  }
  return [
    "#!/bin/sh",
    "# Generated by `wherefore install`: runs the installed Wherefore companion. Claude Code's MCP config names this file.",
    ...(baked ? [`export WHEREFORE_HOME=${shQuote(home)}`] : []),
    `node=${shQuote(input.node)}`,
    `cli=${shQuote(input.cli)}`,
    'if [ ! -x "$node" ]; then',
    '  node=$(command -v node) || { echo "wherefore: no Node found (pinned one is gone, none on PATH); run install again" >&2; exit 127; }',
    "fi",
    'exec "$node" "$cli" "$@"',
    ""
  ].join("\n")
}

/** Reads back the Node and CLI paths a wrapper (or launcher) written by `wrapperScript` starts. */
export const wrapperTargets = (
  platform: Platform,
  script: string
): { readonly node: string; readonly cli: string } | undefined => {
  if (platform === "win32") {
    const node = /^set "WHEREFORE_NODE=(.*)"\r?$/m.exec(script)?.[1]
    const cli = /^set "WHEREFORE_CLI=(.*)"\r?$/m.exec(script)?.[1]
    return node === undefined || cli === undefined ? undefined : { node: node.replaceAll("%%", "%"), cli: cli.replaceAll("%%", "%") }
  }
  const unquote = (quoted: string) => quoted.slice(1, -1).replaceAll(`'\\''`, "'")
  const node = /^node=('(?:[^']|'\\'')*')$/m.exec(script)?.[1]
  const cli = /^cli=('(?:[^']|'\\'')*')$/m.exec(script)?.[1]
  return node === undefined || cli === undefined ? undefined : { node: unquote(node), cli: unquote(cli) }
}

/** A command to run (never through a shell, so arguments with spaces stay whole). */
export interface Command {
  readonly file: string
  readonly args: ReadonlyArray<string>
}

export const registryAdd = (key: string, manifest: string): Command => ({
  file: "reg",
  args: ["add", `${key}\\${NATIVE_HOST_NAME}`, "/ve", "/t", "REG_SZ", "/d", manifest, "/f"]
})

export const registryDelete = (key: string): Command => ({
  file: "reg",
  args: ["delete", `${key}\\${NATIVE_HOST_NAME}`, "/f"]
})

export const registryQuery = (key: string): Command => ({
  file: "reg",
  args: ["query", `${key}\\${NATIVE_HOST_NAME}`, "/ve"]
})

export interface FileWrite {
  readonly path: string
  readonly content: string
  /** POSIX mode; ignored on Windows. */
  readonly mode: number
}

export interface InstallPlan {
  /** Directories to create (user-only on POSIX). */
  readonly dirs: ReadonlyArray<string>
  readonly files: ReadonlyArray<FileWrite>
  readonly commands: ReadonlyArray<Command & { readonly browser: string }>
  /** Per browser: where it was registered, or why not. */
  readonly report: ReadonlyArray<{ readonly browser: string; readonly where?: string; readonly skipped?: string }>
}

/**
 * `exists(dir)` says whether a browser's config directory exists. Chrome is always registered;
 * other browsers only when they look installed, so we don't create their directories.
 */
export const planInstall = (
  location: Location,
  input: WrapperInput,
  exists: (dir: string) => boolean
): InstallPlan => {
  const { platform } = location
  const path = pathFor(platform)
  const wrapper = wrapperPath(location)
  const manifest = `${JSON.stringify(hostManifest(wrapper), null, 2)}\n`
  const dirs: Array<string> = [stateDir(location), launcherDir(location)]
  const files: Array<FileWrite> = [
    { path: wrapper, content: wrapperScript(platform, input), mode: 0o755 },
    { path: launcherPath(location), content: launcherScript(platform, input), mode: 0o755 }
  ]
  const commands: Array<Command & { readonly browser: string }> = []
  const report: Array<{ readonly browser: string; readonly where?: string; readonly skipped?: string }> = []

  if (platform === "win32") files.push({ path: windowsManifestPath(location), content: manifest, mode: 0o644 })
  for (const target of browserTargets(platform, location.home)) {
    if (target.registryKey !== undefined) {
      commands.push({ ...registryAdd(target.registryKey, windowsManifestPath(location)), browser: target.browser })
      report.push({ browser: target.browser, where: `${target.registryKey}\\${NATIVE_HOST_NAME}` })
    } else if (target.manifestDir !== undefined && target.configDir !== undefined) {
      if (target.browser !== "Chrome" && !exists(target.configDir)) {
        report.push({ browser: target.browser, skipped: "not installed" })
        continue
      }
      dirs.push(target.manifestDir)
      const file = path.join(target.manifestDir, manifestFileName)
      files.push({ path: file, content: manifest, mode: 0o644 })
      report.push({ browser: target.browser, where: file })
    }
  }
  return { dirs, files, commands, report }
}

export interface UninstallPlan {
  readonly platform: Platform
  /** Files to remove if present. */
  readonly files: ReadonlyArray<string>
  /** Copies directories: their version directories go, then the directory itself if that empties it. */
  readonly dirs: ReadonlyArray<string>
  /** Directories to remove once the files are gone, only if empty: the launcher's. */
  readonly emptyDirs: ReadonlyArray<string>
  /** Where a killed install may have left temporary files (`<name>.<pid>.tmp`). */
  readonly tempDirs: ReadonlyArray<string>
  readonly commands: ReadonlyArray<Command & { readonly browser: string }>
}

export const planUninstall = (location: Location): UninstallPlan => {
  const { platform } = location
  const path = pathFor(platform)
  const files: Array<string> = [wrapperPath(location), launcherPath(location)]
  const commands: Array<Command & { readonly browser: string }> = []
  if (platform === "win32") files.push(windowsManifestPath(location))
  for (const target of browserTargets(platform, location.home)) {
    if (target.registryKey !== undefined) commands.push({ ...registryDelete(target.registryKey), browser: target.browser })
    if (target.manifestDir !== undefined) files.push(path.join(target.manifestDir, manifestFileName))
  }
  return {
    platform,
    files,
    dirs: [copiesDir(location)],
    emptyDirs: [launcherDir(location)],
    tempDirs: [stateDir(location), launcherDir(location)],
    commands
  }
}

/** Quotes an argument for the user's shell when it needs it (POSIX shells, or cmd/PowerShell). */
export const shellArg = (platform: Platform, text: string): string =>
  /^[A-Za-z0-9_./:\\=@+-]+$/.test(text)
    ? text
    : platform === "win32"
    ? `"${text}"`
    : `'${text.replaceAll("'", "'\\''")}'`

/**
 * The Claude Code command that registers the companion's MCP server for every project (user
 * scope), through the launcher, so it stays the same across updates. On Windows a `.cmd` needs
 * `cmd /c` to start.
 */
export const claudeMcpAdd = (location: Location): string => {
  const launcher = shellArg(location.platform, launcherPath(location))
  return `claude mcp add --scope user wherefore -- ${location.platform === "win32" ? `cmd /c ${launcher}` : launcher} mcp`
}

/**
 * Where the companion keeps things, as pure functions of the platform, home directory and
 * environment, so tests (and `install` against a temporary HOME) never touch the real home.
 *
 * - **State directory** `~/.wherefore` (or `$WHEREFORE_HOME`): the wrapper script Chrome
 *   launches, the Windows host manifest, and the broker registry.
 * - **Broker registry** `<state>/run`: one `<profileId>.json` per live broker (one broker per
 *   Chrome profile; architecture A3). Created user-only (0700) on macOS and Linux.
 * - **Broker socket**: on macOS and Linux a Unix domain socket in the registry directory,
 *   `<state>/run/<profileId>.<pid>.sock`; on Windows a named pipe,
 *   `\\.\pipe\wherefore-<hash of the state dir>-<profileId>-<pid>` (pipes share one global
 *   namespace, so the hash keeps users and state directories apart). The pid makes every
 *   broker's socket its own, so a broker exiting late can never remove its successor's socket.
 *
 * The same functions run in Chrome's host process and in a terminal (`status`, and the MCP
 * server in M2 PR B), so both find the same registry from HOME alone.
 */
import { createHash } from "node:crypto"
import * as NodePath from "node:path"
import type { ProfileId } from "@wherefore/core"

export type Platform = "darwin" | "linux" | "win32"

export interface Location {
  readonly platform: Platform
  readonly home: string
  readonly env: Readonly<Record<string, string | undefined>>
}

/** The Node platform, narrowed: anything that isn't macOS or Windows is treated like Linux. */
export const platformOf = (platform: string): Platform =>
  platform === "darwin" || platform === "win32" ? platform : "linux"

export const pathFor = (platform: Platform): NodePath.PlatformPath => (platform === "win32" ? NodePath.win32 : NodePath.posix)

export const stateDir = ({ platform, home, env }: Location): string => {
  const override = env["WHEREFORE_HOME"]
  return override !== undefined && override !== "" ? pathFor(platform).resolve(override) : pathFor(platform).join(home, ".wherefore")
}

export const registryDir = (location: Location): string => pathFor(location.platform).join(stateDir(location), "run")

/**
 * The longest Unix socket path every platform accepts: `sun_path` is 104 bytes on macOS and 108
 * on Linux, including the terminating NUL.
 */
export const MAX_UNIX_SOCKET_PATH = 103

export const socketPath = (location: Location, profileId: ProfileId, pid: number): string => {
  if (location.platform === "win32") {
    const hash = createHash("sha256").update(stateDir(location).toLowerCase()).digest("hex").slice(0, 12)
    return `\\\\.\\pipe\\wherefore-${hash}-${profileId}-${pid}`
  }
  return pathFor(location.platform).join(registryDir(location), `${profileId}.${pid}.sock`)
}

/** A socket file's pid, from its name (`<profileId>.<pid>.sock`); undefined for anything else. */
export const pidOfSocketFile = (name: string): number | undefined => {
  const match = /^[a-z2-7]{26}\.(\d+)\.sock$/.exec(name)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

export const isUnixSocketPathTooLong = (location: Location, path: string): boolean =>
  location.platform !== "win32" && Buffer.byteLength(path, "utf8") > MAX_UNIX_SOCKET_PATH

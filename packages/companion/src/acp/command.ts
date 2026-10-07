/**
 * How the broker starts an ACP agent and hands it Wherefore's tools (architecture A2, A4), as pure
 * functions of the platform and environment, so tests check them for every OS.
 *
 * - **The agent's command** is the user's (Settings) or `DEFAULT_AGENT_COMMAND`, split into words
 *   (quotes group words; no other shell features). On Windows it runs through `cmd.exe`, because
 *   `npx` is `npx.cmd` there and Node can't start a `.cmd` file without a shell.
 * - **The MCP server** the agent gets is this CLI, `wherefore mcp --profile <profile> --run <run>`,
 *   with the Node and CLI the install wrapper pinned (`WHEREFORE_NODE`, `WHEREFORE_CLI`), so it
 *   sees only this profile and attaches to the run the panel created.
 */
import { AGENT_MCP_SERVER_NAME, type ProfileId, type RunId } from "@wherefore/core"
import type { Platform } from "../paths.ts"

/** What `--run` accepts: the run ids the worker makes (UUIDs), and nothing that needs quoting. */
export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/

/**
 * A command line in words: whitespace separates them, and single or double quotes group them (the
 * quotes themselves are dropped). Backslashes are kept as they are, so Windows paths work.
 */
export const splitCommand = (command: string): ReadonlyArray<string> => {
  const words: Array<string> = []
  let word = ""
  let quote: string | undefined
  let inWord = false
  for (const char of command.trim()) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else word += char
    } else if (char === '"' || char === "'") {
      quote = char
      inWord = true
    } else if (/\s/.test(char)) {
      if (inWord) words.push(word)
      word = ""
      inWord = false
    } else {
      word += char
      inWord = true
    }
  }
  if (inWord) words.push(word)
  return words
}

/** How to spawn `command` on `platform`: directly (POSIX), or as one line through `cmd.exe` (Windows). */
export const spawnPlan = (
  platform: Platform,
  command: string
): { readonly program: string; readonly args: ReadonlyArray<string>; readonly shell: boolean } | undefined => {
  const words = splitCommand(command)
  const [program, ...args] = words
  if (program === undefined) return undefined
  return platform === "win32" ? { program: command.trim(), args: [], shell: true } : { program, args, shell: false }
}

/** cmd.exe's words for a program it can't find. */
export const WINDOWS_NOT_FOUND = /is not recognized as an internal or external command/i

/** The Node and CLI paths for the agent's MCP server: the wrapper's pins, else this process's own. */
export const mcpLauncher = (
  env: Readonly<Record<string, string | undefined>>,
  fallback: { readonly node: string; readonly cli: string }
): { readonly node: string; readonly cli: string } => ({
  node: env["WHEREFORE_NODE"] !== undefined && env["WHEREFORE_NODE"] !== "" ? env["WHEREFORE_NODE"] : fallback.node,
  cli: env["WHEREFORE_CLI"] !== undefined && env["WHEREFORE_CLI"] !== "" ? env["WHEREFORE_CLI"] : fallback.cli
})

/** An ACP stdio MCP server (the protocol's `McpServerStdio`). */
export interface StdioMcpServer {
  readonly name: string
  readonly command: string
  readonly args: Array<string>
  readonly env: Array<{ readonly name: string; readonly value: string }>
}

/**
 * The MCP server an ACP run's agent gets: `wherefore mcp --profile <id> --run <run id>`. The
 * agent's MCP client may start it with only a few of the agent's variables, so `WHEREFORE_HOME` is
 * passed on when set (the server finds the brokers through it).
 */
export const agentMcpServer = (options: {
  readonly node: string
  readonly cli: string
  readonly profile: ProfileId
  readonly runId: RunId
  readonly env: Readonly<Record<string, string | undefined>>
}): StdioMcpServer => {
  const home = options.env["WHEREFORE_HOME"]
  return {
    name: AGENT_MCP_SERVER_NAME,
    command: options.node,
    args: [options.cli, "mcp", "--profile", options.profile, "--run", options.runId],
    env: home === undefined || home === "" ? [] : [{ name: "WHEREFORE_HOME", value: home }]
  }
}

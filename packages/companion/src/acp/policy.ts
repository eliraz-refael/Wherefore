/**
 * What the companion decides about an ACP agent, as pure functions (tested without a process):
 *
 * - **The permission guard.** The agent may use Wherefore's five MCP tools and nothing else: its
 *   own tools (shell, file edits, web fetches, ...) are refused. Claude Code also gets no built-in
 *   tools at all for this session (AgentRun.ts), so the guard is the second line, and the one that
 *   holds for any other ACP agent. Permission modes are never offered to the user, and a session
 *   that starts in another mode is put back to "default", so nothing skips the guard.
 * - **The agent's settings**, flattened to what Settings shows (model, effort; never modes).
 * - **Why a run failed**, from the ACP error, the exit code and the start of stderr.
 */
import {
  AGENT_MCP_SERVER_NAME,
  AgentExited,
  AgentFailed,
  AgentNotFound,
  AgentNotLoggedIn,
  type AgentRunError,
  type AgentSetting,
  agentExitedMessage,
  agentFailedMessage,
  agentNotFoundMessage,
  agentNotLoggedInMessage,
  isAgentSettingCategory,
  TriageToolkit
} from "@wherefore/core"
import type { RequestPermissionRequest, RequestPermissionResponse, SessionConfigOption } from "./AcpConnection.ts"
import { WINDOWS_NOT_FOUND } from "./command.ts"

// ---------- permissions ----------

/** Wherefore's tool names, as the model calls them. */
export const WHEREFORE_TOOLS: ReadonlyArray<string> = Object.keys(TriageToolkit.tools)

/** How Claude Code names an MCP server's tool. */
const mcpToolName = (tool: string) => `mcp__${AGENT_MCP_SERVER_NAME}__${tool}`
const OUR_NAMES = new Set(WHEREFORE_TOOLS.flatMap((tool) => [mcpToolName(tool), tool]))

/** Tool kinds that are never ours, whatever the tool calls itself. */
const FOREIGN_KINDS = new Set(["execute", "edit", "delete", "move", "fetch", "switch_mode"])

type ToolCall = RequestPermissionRequest["toolCall"]

/** The tool's real name, when the agent reports it (`_meta.claudeCode.toolName`, claude-agent-acp). */
const reportedName = (toolCall: ToolCall): string | undefined => {
  const meta = toolCall._meta
  const claudeCode = meta !== null && meta !== undefined && typeof meta === "object" ? (meta as Record<string, unknown>)["claudeCode"] : undefined
  const name = claudeCode !== null && typeof claudeCode === "object" ? (claudeCode as Record<string, unknown>)["toolName"] : undefined
  return typeof name === "string" ? name : undefined
}

/**
 * Whether a permission request is for one of Wherefore's tools. The agent's own name for the tool
 * decides when it gives one; otherwise the tool's name or title must be exactly one of ours, and
 * its kind not one of a shell, an edit or a fetch.
 */
export const isWhereforeTool = (toolCall: ToolCall): boolean => {
  const reported = reportedName(toolCall)
  if (reported !== undefined) return OUR_NAMES.has(reported)
  if (toolCall.kind !== undefined && toolCall.kind !== null && FOREIGN_KINDS.has(toolCall.kind)) return false
  return [toolCall.name, toolCall.title].some((name) => typeof name === "string" && OUR_NAMES.has(name.trim()))
}

/** The answer to a permission request: allow ours once (never "always"), refuse everything else. */
export const decidePermission = (
  request: RequestPermissionRequest
): { readonly allowed: boolean; readonly response: RequestPermissionResponse } => {
  const allowed = isWhereforeTool(request.toolCall)
  const order = allowed ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"]
  const option = order.flatMap((kind) => request.options.filter((candidate) => candidate.kind === kind))[0]
  // No fitting option: a refusal either way (an allow we can't express is a refusal too).
  if (option === undefined) return { allowed: false, response: { outcome: { outcome: "cancelled" } } }
  return { allowed, response: { outcome: { outcome: "selected", optionId: option.optionId } } }
}

// ---------- settings ----------

/** The agent's config options Settings may show: model, effort and model options; never permission modes. */
export const flattenSettings = (options: ReadonlyArray<SessionConfigOption> | null | undefined): ReadonlyArray<AgentSetting> =>
  (options ?? []).flatMap((option): ReadonlyArray<AgentSetting> => {
    const category = option.category
    if (!isAgentSettingCategory(category) || option.id === "") return []
    const base = {
      id: option.id,
      name: option.name,
      category,
      ...(typeof option.description === "string" && option.description !== "" ? { description: option.description } : {})
    }
    if (option.type === "boolean") return [{ ...base, value: option.currentValue }]
    // A kind of option this companion doesn't know: left out, rather than failing the run.
    if (option.type !== "select" || !Array.isArray(option.options)) return []
    const choices = option.options.flatMap((choice) => ("group" in choice ? choice.options : [choice]))
    return [{
      ...base,
      value: option.currentValue,
      choices: choices.map((choice) => ({
        value: choice.value,
        name: choice.name,
        ...(typeof choice.description === "string" && choice.description !== "" ? { description: choice.description } : {})
      }))
    }]
  })

/** Mode ids that skip or loosen permission requests (Claude Code's bypass, auto and accept modes, Gemini's yolo, ...). */
const LOOSE_MODE = /bypass|yolo|skip|dont.?ask|accept|auto/i

/** What to do about the session's permission mode before the prompt goes out. */
export type ModePlan =
  /** Already asking for every tool, or a mode that doesn't loosen permissions: nothing to do. */
  | { readonly _tag: "Keep" }
  /** Set it to "default" (ACP config option, or the older `session/set_mode`), and check it took. */
  | { readonly _tag: "SetOption"; readonly id: string }
  | { readonly _tag: "SetMode" }
  /** A loose mode with no way back to "default": the run must not start. */
  | { readonly _tag: "Refuse"; readonly mode: string }

/**
 * The permission mode the session must be in: "default" (ask for every tool, so the guard sees every
 * tool). A session that starts elsewhere is set back, through its `mode` config option or, for agents
 * that only report the older `modes`, `session/set_mode`. A loose mode that can't be set back refuses
 * the run (fail closed); another mode the agent offers no "default" for is kept.
 */
export const modePlan = (
  options: ReadonlyArray<SessionConfigOption> | null | undefined,
  modes: { readonly currentModeId: string; readonly availableModes: ReadonlyArray<{ readonly id: string }> } | null | undefined
): ModePlan => {
  const option = (options ?? []).find((candidate) => candidate.category === "mode")
  if (option !== undefined) {
    const current = String(option.currentValue)
    if (current === "default") return { _tag: "Keep" }
    const offered = option.type === "select"
      ? option.options.flatMap((choice) => ("group" in choice ? choice.options : [choice])).some((choice) => choice.value === "default")
      : false
    if (offered) return { _tag: "SetOption", id: option.id }
    return LOOSE_MODE.test(current) ? { _tag: "Refuse", mode: current } : { _tag: "Keep" }
  }
  if (modes === null || modes === undefined || modes.currentModeId === "default") return { _tag: "Keep" }
  if (modes.availableModes.some((mode) => mode.id === "default")) return { _tag: "SetMode" }
  return LOOSE_MODE.test(modes.currentModeId) ? { _tag: "Refuse", mode: modes.currentModeId } : { _tag: "Keep" }
}

/** The session's current permission mode, from its config options (or undefined when it reports none there). */
export const currentMode = (options: ReadonlyArray<SessionConfigOption> | null | undefined): string | undefined => {
  const option = (options ?? []).find((candidate) => candidate.category === "mode")
  return option === undefined ? undefined : String(option.currentValue)
}

// ---------- failures ----------

/** ACP's `authRequired` error code. */
export const AUTH_REQUIRED = -32000

const LOGIN_TEXT = /not logged in|please run \/login|run `?claude`? \/login|authentication required|invalid api key|oauth token (?:has )?expired|log in to claude/i

/** Text that says the agent needs a login. */
export const saysLogin = (text: string): boolean => LOGIN_TEXT.test(text)

/** The last line of stderr worth showing (startup only: no page text can be there yet), shortened. */
export const lastLine = (stderr: string): string | undefined => {
  const line = stderr.split(/\r?\n/).map((text) => text.trim()).filter((text) => text !== "").at(-1)
  return line === undefined ? undefined : line.length > 200 ? `${line.slice(0, 199)}…` : line
}

/** Where the agent was when it failed. */
export type Phase = "starting" | "working"

export interface FailureFacts {
  readonly command: string
  readonly phase: Phase
  /** The ACP request that failed, if one did. */
  readonly request?: { readonly code: number | undefined; readonly message: string } | undefined
  /** Set when the process exited: its code (null for a signal). */
  readonly exit?: { readonly code: number | null } | undefined
  readonly stderr: string
}

/**
 * Why the agent's run failed, in the user's words:
 * - a login problem, from ACP's `authRequired` or the agent's own words, at any point;
 * - before the agent started working, cmd.exe's "not recognized" is a missing command, and an
 *   exit is a failed start (with the last line of stderr);
 * - after, an exit is a crash. stderr is not shown then: by now it may hold page text.
 */
export const classifyFailure = (facts: FailureFacts): AgentRunError => {
  const { command, phase, request, exit, stderr } = facts
  if (request?.code === AUTH_REQUIRED || (request !== undefined && saysLogin(request.message))) {
    return new AgentNotLoggedIn({ message: agentNotLoggedInMessage(command) })
  }
  if (phase === "starting") {
    if (saysLogin(stderr)) return new AgentNotLoggedIn({ message: agentNotLoggedInMessage(command) })
    // 127: a POSIX shell's "command not found"; 9009: cmd.exe's (its words are localized).
    if (WINDOWS_NOT_FOUND.test(stderr) || exit?.code === 127 || exit?.code === 9009) {
      return new AgentNotFound({ command, message: agentNotFoundMessage(command) })
    }
    if (exit !== undefined) {
      const line = lastLine(stderr)
      const how = exit.code === null ? "it was stopped" : `it exited with code ${exit.code}`
      return new AgentFailed({ message: agentFailedMessage(command, line === undefined ? `${how}.` : `${how}: ${line}`) })
    }
  }
  if (exit !== undefined) return new AgentExited({ code: exit.code, message: agentExitedMessage(command, exit.code) })
  const detail = request === undefined ? "it stopped answering." : shorten(request.message)
  return new AgentFailed({ message: agentFailedMessage(command, detail.endsWith(".") ? detail : `${detail}.`, phase === "working") })
}

const shorten = (text: string) => (text.length > 200 ? `${text.slice(0, 199)}…` : text)

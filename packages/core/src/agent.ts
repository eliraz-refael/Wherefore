/**
 * ACP mode (architecture A2, A4; M2 PR C): the side panel starts an ACP agent (Claude Code by
 * default, through `claude-agent-acp`) in the companion, and the agent works on the tabs through
 * the companion's MCP server, scoped to this profile and to the run the panel created.
 *
 * Defined once for both sides of the native port:
 * - the agent's settings (model, effort) as the agent offers them, the user's preferences for them,
 *   and how a stale preference is checked against what the agent offers;
 * - `AgentRpcs`, what the broker serves the worker on the native port: `start_agent`, a stream of
 *   `AgentEvent`s that lasts as long as the agent runs, and fails with a typed `AgentRunError`;
 * - the words the panel shows when an agent can't start or stops early.
 *
 * The agent's command comes only from the user's own Settings or `DEFAULT_AGENT_COMMAND`, never
 * from a page or a model.
 */
import { Schema } from "effect"
import { RunId } from "./ids.ts"
import { Rpc, RpcGroup } from "./unstable.ts"

/** Claude Code over ACP, fetched and run by npx (the POC's default). */
export const DEFAULT_AGENT_COMMAND = "npx -y @agentclientprotocol/claude-agent-acp"

/** `Run.agent` for runs of the default command. */
export const CLAUDE_CODE_AGENT = "claude-code"

/** The MCP server name the agent gets for Wherefore's tools (its tools read `mcp__wherefore__<tool>`). */
export const AGENT_MCP_SERVER_NAME = "wherefore"

/**
 * The kinds of agent settings the user may change (ACP config option categories). Permission modes
 * (`mode`) are left out on purpose: "bypass permissions" would skip the companion's permission
 * guard, which is what keeps the agent to Wherefore's tools.
 */
export const AGENT_SETTING_CATEGORIES = ["model", "thought_level", "model_config"] as const
export type AgentSettingCategory = (typeof AGENT_SETTING_CATEGORIES)[number]

export const isAgentSettingCategory = (category: string | null | undefined): category is AgentSettingCategory =>
  AGENT_SETTING_CATEGORIES.some((known) => known === category)

export const AgentChoice = Schema.Struct({
  value: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String)
})
export type AgentChoice = typeof AgentChoice.Type

/** One agent setting (an ACP session config option such as model or effort), flattened for the panel. */
export const AgentSetting = Schema.Struct({
  id: Schema.NonEmptyString,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  category: Schema.Literals(AGENT_SETTING_CATEGORIES),
  /** The agent's current value. */
  value: Schema.Union([Schema.String, Schema.Boolean]),
  /** The choices of a select; absent for an on/off setting. */
  choices: Schema.optionalKey(Schema.Array(AgentChoice))
})
export type AgentSetting = typeof AgentSetting.Type

/** The user's picks, by setting id. Applied when a run starts, and only if the agent offers them. */
export const AgentPrefs = Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean]))
export type AgentPrefs = typeof AgentPrefs.Type

/** Applied when the user hasn't picked, and only if the agent offers these values (the POC's defaults). */
export const DEFAULT_AGENT_PREFS: AgentPrefs = { model: "sonnet", effort: "medium" }

/** Whether `value` is one the agent offers for `setting` (a preference may be stale, or meant for another agent). */
export const acceptsPref = (setting: AgentSetting, value: string | boolean): boolean =>
  setting.choices !== undefined
    ? typeof value === "string" && setting.choices.some((choice) => choice.value === value)
    : typeof value === "boolean"

/**
 * The value to ask the agent for, for one of its settings: the user's pick if the agent offers it,
 * else the default if it offers that, else nothing (the agent keeps its own). Nothing, too, when
 * the setting already has that value.
 */
export const prefFor = (setting: AgentSetting, prefs: AgentPrefs): string | boolean | undefined => {
  const candidates = [prefs[setting.id], DEFAULT_AGENT_PREFS[setting.id]]
  const wanted = candidates.find((value) => value !== undefined && acceptsPref(setting, value))
  return wanted === undefined || wanted === setting.value ? undefined : wanted
}

/** What Settings shows for a setting the agent offered last time: the user's pick while it is still offered. */
export const shownPref = (setting: AgentSetting, prefs: AgentPrefs): string | boolean => {
  const picked = prefs[setting.id]
  return picked !== undefined && acceptsPref(setting, picked) ? picked : setting.value
}

/** What the agent offered on its last run, for Settings (kept per command: another agent offers other settings). */
export const AgentOptions = Schema.Struct({
  command: Schema.String,
  settings: Schema.Array(AgentSetting),
  /** Epoch ms. */
  at: Schema.Number
})
export type AgentOptions = typeof AgentOptions.Type

// ---------- the agent's run, on the native port ----------

const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** What the agent reported spending so far in this run. */
export const AgentUsage = Schema.Struct({
  inputTokens: Count,
  outputTokens: Count,
  cacheReadTokens: Count,
  cacheWriteTokens: Count,
  /** The agent's own cost figure, when it reports one in US dollars. */
  costUsd: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)))
})
export type AgentUsage = typeof AgentUsage.Type

/** What `start_agent` reports while the agent runs, in order. `Finished` is the last. */
export const AgentEvent = Schema.Union([
  /** The agent answered `initialize`; `agent` is the name it gave. */
  Schema.TaggedStruct("Started", { agent: Schema.optionalKey(Schema.String) }),
  /** The agent's settings, after the user's preferences were applied. */
  Schema.TaggedStruct("Settings", { settings: Schema.Array(AgentSetting) }),
  /** The session is set up and the prompt is sent: the agent is working. */
  Schema.TaggedStruct("Working", {}),
  Schema.TaggedStruct("Usage", { usage: AgentUsage }),
  /** The agent ended its turn (ACP's stop reason). The run's result, if any, came through MCP. */
  Schema.TaggedStruct("Finished", { stopReason: Schema.String })
])
export type AgentEvent = typeof AgentEvent.Type

/** The agent's command couldn't be found (no `npx`, or a mistyped custom command). */
export class AgentNotFound extends Schema.TaggedError<AgentNotFound>()("AgentNotFound", {
  command: Schema.String,
  message: Schema.String
}) {}

/** The agent says it isn't logged in (ACP's `authRequired`). */
export class AgentNotLoggedIn extends Schema.TaggedError<AgentNotLoggedIn>()("AgentNotLoggedIn", {
  message: Schema.String
}) {}

/** The agent's process exited or crashed before it finished. */
export class AgentExited extends Schema.TaggedError<AgentExited>()("AgentExited", {
  code: Schema.NullOr(Schema.Int),
  message: Schema.String
}) {}

/** The agent started but couldn't run the tidy-up (it refused the session, or broke the protocol). */
export class AgentFailed extends Schema.TaggedError<AgentFailed>()("AgentFailed", {
  message: Schema.String
}) {}

export const AgentRunError = Schema.Union([AgentNotFound, AgentNotLoggedIn, AgentExited, AgentFailed])
export type AgentRunError = typeof AgentRunError.Type

/**
 * Starts the agent for run `runId` (which the worker created and holds) and runs the tidy-up. The
 * stream lasts as long as the agent's turn; interrupting it (the user pressed Stop, or the worker
 * went away) cancels the turn and ends the agent's whole process tree.
 */
export const StartAgentRpc = Rpc.make("start_agent", {
  payload: { runId: RunId, command: Schema.NonEmptyString, prefs: AgentPrefs },
  success: AgentEvent,
  error: AgentRunError,
  stream: true
})

/** What the broker serves the worker on the native port (`ToBroker`/`FromBroker` frames, companion.ts). */
export const AgentRpcs = RpcGroup.make(StartAgentRpc)

// ---------- what the user reads ----------

/** The command's program, for messages: its first word. */
export const programOf = (command: string): string => command.trim().split(/\s+/)[0] ?? command

/** "Claude Code" for the default command, else "The agent". */
export const agentLabel = (command: string): string =>
  command.trim() === DEFAULT_AGENT_COMMAND ? "Claude Code" : "The agent"

export const agentNotFoundMessage = (command: string): string =>
  command.trim() === DEFAULT_AGENT_COMMAND
    ? "Wherefore couldn't start Claude Code: npx wasn't found. Install Node.js (it comes with npx), then run the companion's install command again from that terminal, so it picks up your PATH."
    : `Wherefore couldn't start the agent: "${programOf(command)}" wasn't found. Check the agent command in Settings, or run the companion's install command again from a terminal where it works.`

export const agentNotLoggedInMessage = (command: string): string =>
  command.trim() === DEFAULT_AGENT_COMMAND
    ? "Claude Code isn't logged in. Run `claude` once in a terminal and log in, then try again. If you keep your Claude Code login in another folder (CLAUDE_CONFIG_DIR), run the companion's install command from a terminal where it is set."
    : "The agent isn't logged in. Log in to it in a terminal, then try again."

export const agentExitedMessage = (command: string, code: number | null): string =>
  `${agentLabel(command)} stopped unexpectedly${code === null ? "" : ` (exit code ${code})`}. Try again. If it keeps happening, run "${command.trim()}" in a terminal to see why.`

export const agentFailedMessage = (command: string, detail: string): string =>
  `${agentLabel(command)} couldn't start the tidy-up: ${detail}`

/** Why a run ended without a result, from the agent's stop reason. */
export const noSubmissionMessage = (command: string, stopReason: string): string => {
  const who = agentLabel(command)
  switch (stopReason) {
    case "max_tokens":
    case "max_turn_requests":
      return `${who} hit its limit before it saved the results. Try again.`
    case "refusal":
      return `${who} declined to finish this tidy-up.`
    default:
      return `${who} finished without saving the results. Try again.`
  }
}

export const COMPANION_NOT_CONNECTED_MESSAGE =
  "The Wherefore companion isn't connected, so Claude Code can't start. Settings → Companion says why; or switch to an API key in Settings."

/** Tidy-up through the companion was asked for, but the companion isn't connected. */
export class CompanionNotConnected extends Schema.TaggedError<CompanionNotConnected>()("CompanionNotConnected", {
  message: Schema.String
}) {}

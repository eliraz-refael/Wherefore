/**
 * The user's settings. Stored by the extension in `chrome.storage.local` only: never synced,
 * never sent anywhere except that the API key goes to the model provider the user chose.
 */
import { Schema } from "effect"
import { AgentPrefs, DEFAULT_AGENT_COMMAND } from "./agent.ts"

/**
 * The models API mode offers (owner's decision: Opus and Sonnet only; Haiku is too weak for
 * triage). Both take adaptive thinking and an effort level, which every request sends.
 */
export const API_MODELS = [
  { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" }
] as const
export type ApiModel = (typeof API_MODELS)[number]["id"]

/** The model API mode uses when Settings name none, or name one it doesn't offer. */
export const DEFAULT_MODEL: ApiModel = "claude-opus-5-5"

export const isApiModel = (model: string): model is ApiModel => API_MODELS.some((offered) => offered.id === model)

export const Settings = Schema.Struct({
  /** The model provider's API key, for API mode. Absent until the user enters one. */
  apiKey: Schema.optionalKey(Schema.NonEmptyString),
  /**
   * The model id for API mode, one of `API_MODELS`. Stored as any string, so settings that name a
   * model no longer offered still load; `modelOf` falls back to `DEFAULT_MODEL` for them.
   */
  model: Schema.optionalKey(Schema.NonEmptyString),
  /**
   * How Tidy up runs: `companion` starts Claude Code (or the agent command) through the companion,
   * on the user's own Claude Code login (ACP mode); `api` runs in the page with the API key. Absent
   * until the user chooses: `tidyModeOf` decides then.
   */
  mode: Schema.optionalKey(Schema.Literals(["companion", "api"])),
  /** The ACP agent's command line, when the user changed it (`DEFAULT_AGENT_COMMAND` otherwise). */
  agentCommand: Schema.optionalKey(Schema.NonEmptyString),
  /** The user's picks for the agent's settings (model, effort), by setting id. */
  agentPrefs: Schema.optionalKey(AgentPrefs)
})
export type Settings = typeof Settings.Type

/** The model a run uses: the one Settings name if it is offered, else `DEFAULT_MODEL`. */
export const modelOf = (settings: Settings): ApiModel =>
  settings.model !== undefined && isApiModel(settings.model) ? settings.model : DEFAULT_MODEL

export type TidyMode = "companion" | "api"

/**
 * How Tidy up runs: the user's choice, else API mode once they have saved a key (as before ACP
 * mode existed), else through the companion.
 */
export const tidyModeOf = (settings: Settings): TidyMode =>
  settings.mode ?? (settings.apiKey !== undefined ? "api" : "companion")

/** The ACP agent's command line: the user's, trimmed, or the default. */
export const agentCommandOf = (settings: Settings): string => {
  const command = settings.agentCommand?.trim() ?? ""
  return command === "" ? DEFAULT_AGENT_COMMAND : command
}

/** Settings before the user has changed anything. */
export const defaultSettings: Settings = {}

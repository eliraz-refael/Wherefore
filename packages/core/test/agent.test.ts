import { describe, expect, it } from "@effect/vitest"
import {
  acceptsPref,
  AgentEvent,
  agentCommandOf,
  AgentOptions,
  AgentRpcs,
  AgentRunError,
  type AgentSetting,
  agentNotFoundMessage,
  agentNotLoggedInMessage,
  DEFAULT_AGENT_COMMAND,
  noSubmissionMessage,
  prefFor,
  programOf,
  Run,
  Settings,
  shownPref,
  tidyModeOf
} from "../src/index.ts"
import { decodeOk, rejects } from "./helpers.ts"

const model: AgentSetting = {
  id: "model",
  name: "Model",
  category: "model",
  value: "default",
  choices: [{ value: "default", name: "Default" }, { value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }]
}
const effort: AgentSetting = {
  id: "effort",
  name: "Effort",
  category: "thought_level",
  value: "high",
  choices: [{ value: "low", name: "Low" }, { value: "medium", name: "Medium" }, { value: "high", name: "High" }]
}
const fast: AgentSetting = { id: "fast", name: "Fast mode", category: "model_config", value: false }

describe("agent settings", () => {
  it("accepts only values the agent offers", () => {
    expect(acceptsPref(model, "opus")).toBe(true)
    expect(acceptsPref(model, "haiku")).toBe(false)
    expect(acceptsPref(model, true)).toBe(false)
    expect(acceptsPref(fast, true)).toBe(true)
    expect(acceptsPref(fast, "on")).toBe(false)
  })

  it("asks for the user's pick, else the default (sonnet, medium), and never for a stale value", () => {
    expect(prefFor(model, {})).toBe("sonnet")
    expect(prefFor(effort, {})).toBe("medium")
    expect(prefFor(model, { model: "opus" })).toBe("opus")
    // A pick the agent no longer offers falls back to the default...
    expect(prefFor(model, { model: "claude-3-haiku" })).toBe("sonnet")
    // ...and to nothing when the agent doesn't offer the default either.
    expect(prefFor({ ...effort, choices: [{ value: "high", name: "High" }] }, { effort: "max" })).toBeUndefined()
    // Nothing to do when the agent already has it.
    expect(prefFor({ ...model, value: "opus" }, { model: "opus" })).toBeUndefined()
    expect(prefFor(fast, { fast: true })).toBe(true)
    expect(prefFor(fast, {})).toBeUndefined()
  })

  it("shows the user's pick while the agent still offers it", () => {
    expect(shownPref(model, { model: "opus" })).toBe("opus")
    expect(shownPref(model, { model: "gone" })).toBe("default")
    expect(shownPref(effort, {})).toBe("high")
  })

  it("never lets a permission mode in", () => {
    expect(rejects(AgentOptions, { command: "x", at: 1, settings: [{ ...model, category: "mode" }] })).toBe(true)
    expect(decodeOk(AgentOptions, { command: "x", at: 1, settings: [model, effort, fast] }).settings).toHaveLength(3)
  })
})

describe("Settings for ACP mode", () => {
  it("keeps the mode, the agent command and the agent preferences, all optional", () => {
    const settings = decodeOk(Settings, { mode: "companion", agentCommand: "my-agent --acp", agentPrefs: { model: "opus", fast: true } })
    expect(settings).toEqual({ mode: "companion", agentCommand: "my-agent --acp", agentPrefs: { model: "opus", fast: true } })
    expect(rejects(Settings, { mode: "acp" })).toBe(true)
    expect(rejects(Settings, { agentCommand: "" })).toBe(true)
  })

  it("decides the tidy-up mode: the user's choice, else API once there is a key, else the companion", () => {
    expect(tidyModeOf({})).toBe("companion")
    expect(tidyModeOf({ apiKey: "sk" })).toBe("api")
    expect(tidyModeOf({ apiKey: "sk", mode: "companion" })).toBe("companion")
    expect(tidyModeOf({ mode: "api" })).toBe("api")
  })

  it("uses the default agent command unless the user set one", () => {
    expect(agentCommandOf({})).toBe(DEFAULT_AGENT_COMMAND)
    expect(agentCommandOf({ agentCommand: "  my-agent  " })).toBe("my-agent")
    expect(agentCommandOf({ agentCommand: "   " })).toBe(DEFAULT_AGENT_COMMAND)
  })
})

describe("the agent's run on the native port", () => {
  it("streams agent events and fails with typed errors", () => {
    const rpc = AgentRpcs.requests.get("start_agent")
    expect(rpc).toBeDefined()
    expect(decodeOk(AgentEvent, { _tag: "Started", agent: "claude-agent-acp" })).toEqual({ _tag: "Started", agent: "claude-agent-acp" })
    expect(decodeOk(AgentEvent, { _tag: "Usage", usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.01 } }))
      .toMatchObject({ _tag: "Usage" })
    expect(rejects(AgentEvent, { _tag: "Usage", usage: { inputTokens: -1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } })).toBe(true)
    for (const error of [
      { _tag: "AgentNotFound", command: "npx", message: "m" },
      { _tag: "AgentNotLoggedIn", message: "m" },
      { _tag: "AgentExited", code: null, message: "m" },
      { _tag: "AgentExited", code: 1, message: "m" },
      { _tag: "AgentFailed", message: "m" }
    ]) expect(decodeOk(AgentRunError, error)).toMatchObject({ _tag: error._tag })
  })

  it("stores ACP failures with their own reasons", () => {
    const run = {
      id: "r",
      mode: "acp",
      model: "unknown",
      agent: "claude-code",
      startedAt: "2026-10-07T09:00:00.000Z",
      finishedAt: "2026-10-07T09:00:05.000Z",
      status: "failed",
      tabs: [],
      steps: [],
      intentions: [],
      usage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
    }
    for (const reason of ["companion", "agent_not_found", "agent_login", "agent_crashed", "agent_failed", "no_submission"]) {
      expect(decodeOk(Run, { ...run, error: { reason, message: "m" } }).error?.reason).toBe(reason)
    }
  })
})

describe("what the user reads", () => {
  it("tells them how to fix a missing command or a missing login", () => {
    expect(programOf("  npx -y @agentclientprotocol/claude-agent-acp")).toBe("npx")
    expect(agentNotFoundMessage(DEFAULT_AGENT_COMMAND)).toContain("npx wasn't found")
    expect(agentNotFoundMessage("my-agent --acp")).toContain('"my-agent" wasn\'t found')
    expect(agentNotLoggedInMessage(DEFAULT_AGENT_COMMAND)).toContain("Run `claude` once")
    expect(agentNotLoggedInMessage(DEFAULT_AGENT_COMMAND)).toContain("CLAUDE_CONFIG_DIR")
    expect(noSubmissionMessage(DEFAULT_AGENT_COMMAND, "end_turn")).toBe("Claude Code finished without saving the results. Try again.")
    expect(noSubmissionMessage("other", "max_tokens")).toBe("The agent hit its limit before it saved the results. Try again.")
  })
})

/**
 * ACP mode end to end, in the companion: a real broker (in this process, on a real socket in a
 * temporary WHEREFORE_HOME) with a fake worker on its native port asks for an agent
 * (`start_agent`); the broker spawns a real fake ACP agent process (fakeAgent.ts), which starts the
 * real `wherefore mcp --profile … --run …` the session gave it and runs the tidy-up through it.
 */
import { describe, expect, it } from "@effect/vitest"
import { type AgentEvent, CLAUDE_CODE_AGENT, DEFAULT_AGENT_COMMAND, KICKOFF } from "@wherefore/core"
import { existsSync, readFileSync } from "node:fs"
import * as NodePath from "node:path"
import { fileURLToPath } from "node:url"
import { Effect, Exit, Fiber, Stream } from "effect"
import { CLAUDE_CODE_SESSION_META } from "../src/acp/AgentRun.ts"
import { PROFILE, sampleTabs, startFakeChrome, tempLocation } from "./fakes.ts"
import { eventually, runCli, startMcp } from "./mcpProcess.ts"

const here = NodePath.dirname(fileURLToPath(import.meta.url))
const cliSource = NodePath.join(here, "..", "src", "cli.ts")
const fakeAgent = NodePath.join(here, "fakeAgent.ts")

/** The command line that runs the fake agent in `scenario`. */
export const fakeAgentCommand = (scenario: string) =>
  `"${process.execPath}" --experimental-strip-types --disable-warning=ExperimentalWarning "${fakeAgent}" ${scenario}`

const twoTabs = [
  ...sampleTabs,
  { id: 2, window: 1, index: 1, title: "Docs", url: "https://docs.example/" }
]

/** A broker over a fake Chrome, set up for ACP runs: its MCP server is src/cli.ts, logs go to a file. */
const acpChrome = Effect.gen(function*() {
  const location = yield* tempLocation
  const home = location.env["WHEREFORE_HOME"] ?? ""
  const logFile = NodePath.join(home, "agent.log")
  const chrome = yield* startFakeChrome({
    location,
    listTabs: Effect.succeed({ tabs: twoTabs }),
    askPanel: ({ questions }) => Effect.succeed({ answers: questions.map((question) => ({ id: question.id, answer: "Yes" })) }),
    mcp: { node: process.execPath, cli: cliSource },
    env: { ...process.env, WHEREFORE_HOME: home, FAKE_AGENT_LOG: logFile }
  })
  yield* chrome.welcome
  yield* chrome.entry
  const logged = (): Array<Record<string, any>> =>
    existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter((line) => line !== "").map((line) => JSON.parse(line)) : []
  return { chrome, home, logged }
})

/** Runs an agent to its end; the events, and the error if it failed. */
const runToEnd = (stream: Stream.Stream<AgentEvent, unknown>) =>
  Effect.gen(function*() {
    const events: Array<AgentEvent> = []
    const exit = yield* stream.pipe(Stream.runForEach((event) => Effect.sync(() => events.push(event))), Effect.exit)
    return { events, error: Exit.isFailure(exit) ? exit.cause.reasons.find((reason) => reason._tag === "Fail")?.error : undefined }
  })

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe("ACP mode", () => {
  it.live("runs a whole tidy-up: the agent attaches to the panel's run through wherefore mcp --run", () =>
    Effect.gen(function*() {
      const { chrome, logged } = yield* acpChrome
      const { events, error } = yield* runToEnd(chrome.startAgent("run-acp-1", fakeAgentCommand("succeed")))
      expect(error).toBeUndefined()
      expect(events.map((event) => event._tag)).toEqual(["Started", "Settings", "Working", "Usage", "Usage", "Finished"])
      expect(events[0]).toEqual({ _tag: "Started", agent: "fake-agent" })
      // The default preferences (sonnet, medium), as the agent offers them; permission modes never show.
      const settings = events[1]
      expect(settings?._tag === "Settings" ? settings.settings.map((s) => [s.id, s.value]) : undefined).toEqual([["model", "sonnet"], ["effort", "medium"]])
      expect(events.at(-2)).toEqual({ _tag: "Usage", usage: { inputTokens: 1000, outputTokens: 400, cacheReadTokens: 100, cacheWriteTokens: 0, costUsd: 0.042 } })
      expect(events.at(-1)).toEqual({ _tag: "Finished", stopReason: "end_turn" })

      // The MCP session attached to the panel's run and stored the result in it.
      const run = chrome.runs.get("run-acp-1")
      expect(run).toMatchObject({ id: "run-acp-1", mode: "acp", status: "succeeded" })
      expect(run?.intentions.map((intention) => intention.tabIds)).toEqual([[1], [2]])
      expect(chrome.runs.size).toBe(1)

      const log = logged()
      const session = log.find((entry) => entry.event === "session")
      expect(session?.mcpServers).toEqual([{
        name: "wherefore",
        command: process.execPath,
        args: [cliSource, "mcp", "--profile", PROFILE, "--run", "run-acp-1"],
        env: [{ name: "WHEREFORE_HOME", value: chrome.location.env["WHEREFORE_HOME"] }]
      }])
      // Claude Code gets no built-in tools, only this MCP server, and no bypass mode.
      expect(session?.meta).toEqual(CLAUDE_CODE_SESSION_META)
      // The mode is put back to "default" first, then the preferences, in the agent's order.
      expect(log.filter((entry) => entry.event === "set").map((entry) => [entry.id, entry.value])).toEqual([
        ["mode", "default"],
        ["model", "sonnet"],
        ["effort", "medium"]
      ])
      expect(log.find((entry) => entry.event === "prompt")?.mentionsListTabs).toBe(true)
      expect(log.find((entry) => entry.event === "submitted")?.isError).toBe(false)
      expect(KICKOFF).toContain("list_tabs")
    }), 60_000)

  it.live("applies the user's preferences only where the agent offers them", () =>
    Effect.gen(function*() {
      const { chrome, logged } = yield* acpChrome
      const { events } = yield* runToEnd(chrome.startAgent("run-acp-2", fakeAgentCommand("nosubmit"), { model: "opus", effort: "max" }))
      const settings = events.find((event) => event._tag === "Settings")
      expect(settings?._tag === "Settings" ? settings.settings.map((s) => [s.id, s.value]) : undefined).toEqual([["model", "opus"], ["effort", "medium"]])
      expect(logged().filter((entry) => entry.event === "set").map((entry) => entry.value)).toEqual(["default", "opus", "medium"])
    }), 60_000)

  it.live("allows Wherefore's tools and refuses the agent's own", () =>
    Effect.gen(function*() {
      const { chrome, logged } = yield* acpChrome
      const { error } = yield* runToEnd(chrome.startAgent("run-acp-3", fakeAgentCommand("forbidden")))
      expect(error).toBeUndefined()
      const outcomes = logged().filter((entry) => entry.event === "permission").map((entry) => [entry.tool, entry.outcome])
      expect(outcomes).toEqual([
        ["rm -rf ~", { outcome: "selected", optionId: "reject" }],
        ["mcp__wherefore__list_tabs", { outcome: "selected", optionId: "allow" }]
      ])
      expect(chrome.runs.get("run-acp-3")?.status).toBe("succeeded")
    }), 60_000)

  it.live("asks its question in the panel", () =>
    Effect.gen(function*() {
      const { chrome, logged } = yield* acpChrome
      yield* runToEnd(chrome.startAgent("run-acp-4", fakeAgentCommand("ask")))
      expect(logged().find((entry) => entry.event === "asked")).toMatchObject({ isError: false, answers: [{ id: "q1", answer: "Yes" }] })
      expect(chrome.runs.get("run-acp-4")?.steps.some((step) => step.kind === "question")).toBe(true)
    }), 60_000)

  it.live("Stop cancels the turn and ends the agent's whole process tree", () =>
    Effect.gen(function*() {
      const { chrome, logged } = yield* acpChrome
      const events: Array<AgentEvent> = []
      const fiber = yield* chrome.startAgent("run-acp-5", fakeAgentCommand("hang")).pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkChild
      )
      yield* eventually(() => logged().some((entry) => entry.event === "listed") && logged().some((entry) => entry.event === "child"), 30_000)
      const agentPid: number = logged().find((entry) => entry.event === "started")?.pid
      const childPid: number = logged().find((entry) => entry.event === "child")?.childPid
      expect(isAlive(agentPid) && isAlive(childPid)).toBe(true)

      yield* Fiber.interrupt(fiber)
      yield* eventually(() => !isAlive(agentPid) && !isAlive(childPid), 15_000)
      expect(logged().some((entry) => entry.event === "cancel")).toBe(true)
      expect(events.map((event) => event._tag)).toEqual(["Started", "Settings", "Working"])
    }), 60_000)

  it.live("reports an agent that crashes mid-run", () =>
    Effect.gen(function*() {
      const { chrome } = yield* acpChrome
      const { error } = yield* runToEnd(chrome.startAgent("run-acp-6", fakeAgentCommand("crash")))
      expect(error).toMatchObject({ _tag: "AgentExited", code: 3 })
      expect((error as { message: string }).message).toMatch(/^The agent stopped unexpectedly \(exit code 3\)/)
    }), 60_000)

  it.live("reports an agent that isn't logged in", () =>
    Effect.gen(function*() {
      const { chrome } = yield* acpChrome
      const { error } = yield* runToEnd(chrome.startAgent("run-acp-7", fakeAgentCommand("login")))
      expect(error).toMatchObject({ _tag: "AgentNotLoggedIn" })
    }), 60_000)

  it.live("tells Claude Code users to run claude once when the login is missing", () =>
    Effect.gen(function*() {
      // The default command's message, through the same classification.
      const { classifyFailure } = yield* Effect.promise(() => import("../src/acp/policy.ts"))
      const error = classifyFailure({ command: DEFAULT_AGENT_COMMAND, phase: "starting", request: { code: -32000, message: "Authentication required" }, stderr: "" })
      expect(error._tag).toBe("AgentNotLoggedIn")
      expect(error.message).toContain("Run `claude` once")
      expect(CLAUDE_CODE_AGENT).toBe("claude-code")
    }))

  it.live("reports a command that doesn't exist, and one that exits before starting", () =>
    Effect.gen(function*() {
      const { chrome } = yield* acpChrome
      const missing = yield* runToEnd(chrome.startAgent("run-acp-8", "wherefore-no-such-agent-xyz --acp"))
      expect(missing.error).toMatchObject({ _tag: "AgentNotFound", command: "wherefore-no-such-agent-xyz --acp" })
      expect((missing.error as { message: string }).message).toContain('"wherefore-no-such-agent-xyz" wasn\'t found')

      const early = yield* runToEnd(chrome.startAgent("run-acp-9", `"${process.execPath}" -e "console.error('no such package'); process.exit(2)"`))
      expect(early.error).toMatchObject({ _tag: "AgentFailed" })
      expect((early.error as { message: string }).message).toBe("The agent couldn't start the tidy-up: it exited with code 2: no such package")
    }), 60_000)

  it.live("an agent that ends its turn without submitting just finishes (the worker says so)", () =>
    Effect.gen(function*() {
      const { chrome } = yield* acpChrome
      const { events, error } = yield* runToEnd(chrome.startAgent("run-acp-10", fakeAgentCommand("nosubmit")))
      expect(error).toBeUndefined()
      expect(events.at(-1)).toEqual({ _tag: "Finished", stopReason: "end_turn" })
      expect(chrome.runs.get("run-acp-10")?.status).not.toBe("succeeded")
    }), 60_000)

  it.live("wherefore mcp --run attaches only to a run the panel started, and needs --profile", () =>
    Effect.gen(function*() {
      const { chrome, home } = yield* acpChrome
      const mcp = yield* startMcp(home, ["--profile", PROFILE, "--run", "not-the-panels"])
      const listed = yield* Effect.promise(() => mcp.callTool("list_tabs"))
      expect(listed.isError).toBe(true)
      expect(listed.text).toContain("The side panel didn't start this tidy-up.")
      expect(chrome.runs.size).toBe(0)

      const unscoped = yield* runCli(home, ["mcp", "--run", "r1"])
      expect(unscoped.code).toBe(1)
      expect(unscoped.stderr).toContain("--run needs --profile")
      const bad = yield* runCli(home, ["mcp", "--profile", PROFILE, "--run", "bad id; rm"])
      expect(bad.code).toBe(1)
    }), 60_000)
})

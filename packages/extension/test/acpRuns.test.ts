/**
 * ACP runs from the worker's side (M2 PR C): the panel's Tidy up through the companion. The real
 * worker over a fake native host whose broker serves `AgentRpcs` from a script (the agent), and
 * plays the agent's MCP session with a real RPC client of `CompanionWorkerRpcs`; pages talk to the
 * worker over fake Ports.
 */
import { assert, describe, expect, it } from "@effect/vitest"
import {
  AGENT_GONE_MESSAGE,
  type AgentEvent,
  AgentExited,
  AgentNotFound,
  AgentNotLoggedIn,
  type AgentRunError,
  agentNotLoggedInMessage,
  COMPANION_NOT_CONNECTED_MESSAGE,
  DEFAULT_AGENT_COMMAND,
  type Run,
  Run as RunSchema,
  type RunSignal
} from "@wherefore/core"
import { type Cause, Effect, Exit, Fiber, Queue, Schema, Scope, Stream } from "effect"
import { NOT_PANEL_RUN_MESSAGE, STOPPED_MESSAGE, startingNote, workingNote } from "../src/companion/CompanionRuns.ts"
import { WorkerClient } from "../src/messaging/WorkerClient.ts"
import { agentOptionsKey, runKey } from "../src/store/keys.ts"
import { FakeChrome } from "./fakes/chrome.ts"
import { Harness, waitUntil } from "./fakes/harness.ts"
import { brokerClient, fakeAgentBroker, FakeNativeHost } from "./fakes/native.ts"

const browser = () =>
  new FakeChrome({
    tabs: [
      { id: 1, windowId: 1, url: "https://github.com/acme/api/pull/412", title: "Auth PR" },
      { id: 2, windowId: 1, url: "https://example.com/" }
    ]
  })

const stored = (harness: Harness, id: string): Run | undefined => {
  const raw = (harness.chrome.local.get(runKey(id as never).name) as { data: unknown } | undefined)?.data
  return raw === undefined ? undefined : Schema.decodeUnknownSync(RunSchema)(raw)
}

/** The run as the agent's MCP session stores it (its own start time, agent name and no usage). */
const sessionRun = (id: string, overrides: Record<string, unknown> = {}): Run =>
  Schema.decodeUnknownSync(RunSchema)({
    id,
    mode: "acp",
    model: "unknown",
    agent: "claude-code-mcp-client",
    startedAt: "2026-10-07T09:00:09.000Z",
    status: "running",
    tabs: [],
    steps: [{ kind: "tool", at: "2026-10-07T09:00:10.000Z", callId: "list_tabs:1", tool: "list_tabs", status: "running", summary: "Listing tabs" }],
    intentions: [],
    usage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ...overrides
  })

const settings = [
  {
    id: "model",
    name: "Model",
    category: "model",
    value: "sonnet",
    choices: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }]
  }
] as const

/** An agent the test drives: what it reports, then how it ends. */
const scripted = Effect.gen(function*() {
  const events = yield* Queue.unbounded<AgentEvent, AgentRunError | Cause.Done>()
  return {
    script: () => Stream.fromQueue(events),
    emit: (event: AgentEvent) => Queue.offer(events, event),
    fail: (error: AgentRunError) => Queue.fail(events, error),
    end: Queue.end(events)
  }
})

/** The worker connected to the companion, its fake broker running `agent`, and a page client. */
const withAgent = <A, E>(
  harness: Harness,
  body: (ctx: {
    readonly page: WorkerClient["Service"]
    readonly session: Effect.Success<ReturnType<typeof brokerClient>>
    readonly broker: Effect.Success<ReturnType<typeof fakeAgentBroker>>
    readonly agent: Effect.Success<typeof scripted>
  }) => Effect.Effect<A, E, Scope.Scope>
) =>
  Effect.gen(function*() {
    yield* harness.startWorker
    yield* waitUntil(() => (harness.chrome.session.get("companion") as { _tag?: string } | undefined)?._tag === "Connected")
    const host = harness.native.last
    assert(host !== undefined)
    const agent = yield* scripted
    const broker = yield* fakeAgentBroker(host, agent.script)
    const session = yield* brokerClient(host)
    const page = yield* WorkerClient
    return yield* body({ page, session, broker, agent })
  }).pipe(Effect.ensuring(harness.killWorker), Effect.provide(harness.clientLayer), Effect.scoped)

/** The agent's MCP session attaches (`open_run`, acp) in its own scope; resolves once answered. */
const attach = (session: Effect.Success<ReturnType<typeof brokerClient>>, id: string) =>
  Effect.gen(function*() {
    const signals: Array<RunSignal> = []
    const scope = yield* Scope.make()
    const fiber = yield* session("open_run", { id: id as never, mode: "acp" }).pipe(
      Stream.runForEach((signal) => Effect.sync(() => signals.push(signal))),
      Effect.forkIn(scope)
    )
    yield* waitUntil(() => signals.length > 0 || fiber.pollUnsafe() !== undefined)
    return { signals, fiber, close: Scope.close(scope, Exit.void) }
  })

const setup = () => new Harness(browser(), new FakeNativeHost("answer"))

describe("ACP runs", () => {
  it.effect("Tidy up creates the run at once; the agent's MCP session attaches to it; the result shows", () => {
    const harness = setup()
    return withAgent(harness, ({ page, session, broker, agent }) =>
      Effect.gen(function*() {
        const id = yield* page.call("start_agent_run", undefined)
        // Stored before the agent did anything, so the panel shows it.
        const first = stored(harness, id)
        expect(first).toMatchObject({ id, mode: "acp", agent: "claude-code", status: "running", model: "unknown" })
        expect(first?.steps).toMatchObject([{ kind: "note", message: startingNote(DEFAULT_AGENT_COMMAND) }])
        expect(harness.locks.heldNames()).toEqual(["wherefore/active-run", `wherefore/run/${id}`])
        yield* waitUntil(() => broker.requests.length === 1)
        expect(broker.requests[0]).toEqual({ runId: id, command: DEFAULT_AGENT_COMMAND, prefs: {} })

        yield* agent.emit({ _tag: "Started", agent: "claude-agent-acp" })
        yield* agent.emit({ _tag: "Settings", settings })
        yield* agent.emit({ _tag: "Working" })
        yield* waitUntil(() => stored(harness, id)?.steps[0]?.kind === "note" && (stored(harness, id)?.steps[0] as { message: string }).message === workingNote(DEFAULT_AGENT_COMMAND))
        expect(stored(harness, id)?.model).toBe("sonnet")
        expect((harness.chrome.local.get(agentOptionsKey.name) as { data: { command: string; settings: unknown } }).data)
          .toMatchObject({ command: DEFAULT_AGENT_COMMAND, settings })

        // The MCP session attaches to the panel's run, and its steps replace the worker's note.
        const lease = yield* attach(session, id)
        expect(lease.signals).toEqual([{ _tag: "Opened" }])
        yield* session("update_run", { run: sessionRun(id) })
        const merged = stored(harness, id)
        expect(merged?.steps).toMatchObject([{ kind: "tool", tool: "list_tabs" }])
        // The worker's own fields stay: start time, agent, model.
        expect(merged).toMatchObject({ agent: "claude-code", model: "sonnet", startedAt: first?.startedAt })

        yield* session("update_run", { run: sessionRun(id, { status: "succeeded", finishedAt: "2026-10-07T09:01:00.000Z" }) })
        yield* agent.emit({ _tag: "Usage", usage: { inputTokens: 900, outputTokens: 300, cacheReadTokens: 50, cacheWriteTokens: 0, costUsd: 0.03 } })
        yield* agent.emit({ _tag: "Finished", stopReason: "end_turn" })
        yield* agent.end
        yield* waitUntil(() => harness.locks.heldNames().length === 0)
        const done = stored(harness, id)
        expect(done).toMatchObject({ status: "succeeded", usage: { inputTokens: 900, outputTokens: 300, costUsd: 0.03 } })
        expect(broker.ended).toEqual(["finished"])
        yield* lease.close
      }))
  })

  it.effect("sends the agent command and preferences from Settings", () => {
    const harness = setup()
    return withAgent(harness, ({ page, broker }) =>
      Effect.gen(function*() {
        yield* page.call("update_settings", { settings: { mode: "companion", agentCommand: "my-agent --acp", agentPrefs: { model: "opus" } } })
        const id = yield* page.call("start_agent_run", undefined)
        yield* waitUntil(() => broker.requests.length === 1)
        expect(broker.requests[0]).toEqual({ runId: id, command: "my-agent --acp", prefs: { model: "opus" } })
        // Another agent isn't Claude Code: it's named by what it says it is.
        expect(stored(harness, id)?.agent).toBeUndefined()
        expect(stored(harness, id)?.steps).toMatchObject([{ message: "Starting the agent…" }])
      }))
  })

  it.effect("refuses to start without the companion", () => {
    const harness = new Harness(browser(), new FakeNativeHost("missing"))
    return Effect.gen(function*() {
      yield* harness.startWorker
      const page = yield* WorkerClient
      yield* waitUntil(() => (harness.chrome.session.get("companion") as { _tag?: string } | undefined)?._tag === "NotInstalled")
      const error = yield* Effect.flip(page.call("start_agent_run", undefined))
      expect(error).toMatchObject({ _tag: "CompanionNotConnected", message: COMPANION_NOT_CONNECTED_MESSAGE })
    }).pipe(Effect.ensuring(harness.killWorker), Effect.provide(harness.clientLayer), Effect.scoped)
  })

  it.effect("keeps one run per profile: a second Tidy up, or an MCP lease, is refused while it runs", () => {
    const harness = setup()
    return withAgent(harness, ({ page, session }) =>
      Effect.gen(function*() {
        const id = yield* page.call("start_agent_run", undefined)
        const again = yield* Effect.flip(page.call("start_agent_run", undefined))
        expect(again).toMatchObject({ _tag: "RunAlreadyActive", runId: id, source: "acp" })
        const mcp = yield* Effect.exit(session("open_run", { id: "mcp-1" as never, mode: "mcp" }).pipe(Stream.runHead))
        expect(Exit.findErrorOption(mcp)).toMatchObject({ _tag: "Some", value: { _tag: "RunAlreadyActive", runId: id, source: "acp" } })
        // Only that one ACP run is stored.
        expect(stored(harness, "mcp-1")).toBeUndefined()
      }))
  })

  it.effect("an MCP session can attach only to the run the panel started, once", () => {
    const harness = setup()
    return withAgent(harness, ({ page, session }) =>
      Effect.gen(function*() {
        const stranger = yield* attach(session, "not-the-panels")
        expect(Exit.findErrorOption(yield* Fiber.await(stranger.fiber))).toMatchObject({
          _tag: "Some",
          value: { _tag: "RunNotActive", message: NOT_PANEL_RUN_MESSAGE }
        })
        const id = yield* page.call("start_agent_run", undefined)
        const first = yield* attach(session, id)
        expect(first.signals).toEqual([{ _tag: "Opened" }])
        const second = yield* attach(session, id)
        expect(Exit.findErrorOption(yield* Fiber.await(second.fiber))).toMatchObject({ _tag: "Some", value: { _tag: "RunNotActive" } })
        // The session leaving doesn't end the run: the agent's turn decides.
        yield* first.close
        expect(stored(harness, id)?.status).toBe("running")
      }))
  })

  it.effect("Stop stores the run cancelled, tells the session, and stops following the agent (which stops it)", () => {
    const harness = setup()
    return withAgent(harness, ({ page, session, broker }) =>
      Effect.gen(function*() {
        const id = yield* page.call("start_agent_run", undefined)
        yield* waitUntil(() => broker.requests.length === 1)
        const lease = yield* attach(session, id)
        yield* session("update_run", { run: sessionRun(id) })
        yield* page.call("stop_run", { id })
        const run = stored(harness, id)
        expect(run).toMatchObject({ status: "cancelled" })
        expect(run?.steps[0]).toMatchObject({ status: "error", summary: "Stopped" })
        yield* waitUntil(() => lease.signals.length === 2)
        expect(lease.signals[1]).toEqual({ _tag: "Stopped", message: STOPPED_MESSAGE })
        // The broker's call was interrupted: in the companion, that cancels the turn and ends the process tree.
        yield* waitUntil(() => broker.ended.length === 1)
        expect(broker.ended).toEqual(["interrupted"])
        yield* waitUntil(() => harness.locks.heldNames().length === 0)
        expect(stored(harness, id)?.status).toBe("cancelled")
      }))
  })

  const failures: ReadonlyArray<readonly [string, AgentRunError, string]> = [
    ["agent_not_found", new AgentNotFound({ command: DEFAULT_AGENT_COMMAND, message: "npx wasn't found" }), "npx wasn't found"],
    ["agent_login", new AgentNotLoggedIn({ message: agentNotLoggedInMessage(DEFAULT_AGENT_COMMAND) }), agentNotLoggedInMessage(DEFAULT_AGENT_COMMAND)],
    ["agent_crashed", new AgentExited({ code: 1, message: "Claude Code stopped unexpectedly (exit code 1)." }), "Claude Code stopped unexpectedly (exit code 1)."]
  ]
  for (const [reason, error, message] of failures) {
    it.effect(`stores the run failed when the agent fails (${reason})`, () => {
      const harness = setup()
      return withAgent(harness, ({ page, agent }) =>
        Effect.gen(function*() {
          const id = yield* page.call("start_agent_run", undefined)
          yield* agent.fail(error)
          yield* waitUntil(() => stored(harness, id)?.status === "failed")
          expect(stored(harness, id)?.error).toEqual({ reason, message })
          yield* waitUntil(() => harness.locks.heldNames().length === 0)
        }))
    })
  }

  it.effect("stores the run failed when the agent ends its turn without a result", () => {
    const harness = setup()
    return withAgent(harness, ({ page, session, agent }) =>
      Effect.gen(function*() {
        const id = yield* page.call("start_agent_run", undefined)
        yield* attach(session, id)
        yield* session("update_run", { run: sessionRun(id) })
        yield* agent.emit({ _tag: "Finished", stopReason: "end_turn" })
        yield* agent.end
        yield* waitUntil(() => stored(harness, id)?.status === "failed")
        expect(stored(harness, id)?.error).toEqual({ reason: "no_submission", message: "Claude Code finished without saving the results. Try again." })
        expect(stored(harness, id)?.steps[0]).toMatchObject({ status: "error", summary: "Stopped" })
      }))
  })

  it.effect("marks the run interrupted when the companion goes away mid-run (as an MCP run's lease would)", () => {
    const harness = setup()
    return withAgent(harness, ({ page, broker }) =>
      Effect.gen(function*() {
        const id = yield* page.call("start_agent_run", undefined)
        yield* waitUntil(() => broker.requests.length === 1)
        harness.native.last?.exit()
        yield* waitUntil(() => stored(harness, id)?.status !== "running")
        expect(stored(harness, id)).toMatchObject({ status: "interrupted", error: { reason: "interrupted", message: AGENT_GONE_MESSAGE } })
        yield* waitUntil(() => harness.locks.heldNames().length === 0)
      }))
  })
})

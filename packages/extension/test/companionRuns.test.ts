/**
 * Runs the companion drives (MCP), from the worker's side: the real worker over a fake native host,
 * with the broker played by a real RPC client of `CompanionWorkerRpcs` on that connection, pages
 * talking to the worker over fake Ports, and Web Locks shared by all of them.
 */
import { assert, describe, expect, it } from "@effect/vitest"
import { AGENT_GONE_MESSAGE, type Run, Run as RunSchema, type RunSignal, STOPPED_STEP } from "@wherefore/core"
import { Effect, Exit, Fiber, Schema, Scope, Stream } from "effect"
import { TestClock } from "effect/testing"
import { NO_PANEL_MESSAGE, PANEL_CLOSED_MESSAGE, STOPPED_MESSAGE, VIEWS_CHECK_INTERVAL } from "../src/companion/CompanionRuns.ts"
import { WorkerClient } from "../src/messaging/WorkerClient.ts"
import { makeWebLocks } from "../src/runs/RunLocks.ts"
import { runIndexKey, runKey } from "../src/store/keys.ts"
import { FakeChrome } from "./fakes/chrome.ts"
import { Harness, waitUntil } from "./fakes/harness.ts"
import { brokerClient, FakeNativeHost } from "./fakes/native.ts"

const browser = () =>
  new FakeChrome({
    tabs: [
      { id: 1, windowId: 1, url: "https://github.com/acme/api/pull/412", title: "Auth PR" },
      { id: 2, windowId: 1, url: "https://example.com/" }
    ]
  })

const wireRun = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  mode: "mcp",
  model: "unknown",
  agent: "claude-code",
  startedAt: "2026-10-06T09:00:00.000Z",
  status: "running",
  tabs: [],
  steps: [],
  intentions: [],
  usage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  ...overrides
})
const runOf = (id: string, overrides: Record<string, unknown> = {}): Run => Schema.decodeUnknownSync(RunSchema)(wireRun(id, overrides))

const readingStep = {
  kind: "tool",
  at: "2026-10-06T09:00:01.000Z",
  callId: "read:1",
  tool: "read_pages",
  status: "running",
  summary: "Reading 2 pages"
}

const question = { id: "q1", tabIds: [1], question: "Still reviewing this PR?", options: ["Yes", "No"] }

/** A stored run, straight from storage. */
const stored = (harness: Harness, id: string): Run | undefined => {
  const raw = (harness.chrome.local.get(runKey(id as never).name) as { data: unknown } | undefined)?.data
  return raw === undefined ? undefined : Schema.decodeUnknownSync(RunSchema)(raw)
}
const indexed = (harness: Harness): unknown => (harness.chrome.local.get(runIndexKey.name) as { data: unknown } | undefined)?.data

/** The worker, connected to the companion, and the broker's client of it; then a page client. */
const withBroker = <A, E>(
  harness: Harness,
  body: (broker: Effect.Success<ReturnType<typeof brokerClient>>, page: WorkerClient["Service"]) => Effect.Effect<A, E, Scope.Scope>
) =>
  Effect.gen(function*() {
    yield* harness.startWorker
    yield* waitUntil(() => (harness.chrome.session.get("companion") as { _tag?: string } | undefined)?._tag === "Connected")
    const host = harness.native.last
    assert(host !== undefined)
    const broker = yield* brokerClient(host)
    const page = yield* WorkerClient
    return yield* body(broker, page)
  }).pipe(Effect.ensuring(harness.killWorker), Effect.provide(harness.clientLayer), Effect.scoped)

/** Opens a lease in its own scope (closing it is the agent going away); resolves once it is `Opened`. */
const openLease = (broker: Effect.Success<ReturnType<typeof brokerClient>>, id: string) =>
  Effect.gen(function*() {
    const signals: Array<RunSignal> = []
    const scope = yield* Scope.make()
    const fiber = yield* broker("open_run", { id: id as never, mode: "mcp" }).pipe(
      Stream.runForEach((signal) => Effect.sync(() => signals.push(signal))),
      Effect.forkIn(scope)
    )
    yield* waitUntil(() => signals.length > 0 || fiber.pollUnsafe() !== undefined)
    return { signals, fiber, close: Scope.close(scope, Exit.void) }
  })

const setup = () => new Harness(browser(), new FakeNativeHost("answer"))

describe("companion runs", () => {
  it.effect("stores a leased run step by step, and keeps it alive while the lease is open", () => {
    const harness = setup()
    return withBroker(harness, (broker, page) =>
      Effect.gen(function*() {
        const lease = yield* openLease(broker, "mcp-1")
        expect(lease.signals).toEqual([{ _tag: "Opened" }])
        // Nothing is stored before the first update.
        expect(stored(harness, "mcp-1")).toBeUndefined()

        yield* broker("update_run", { run: runOf("mcp-1", { steps: [readingStep] }) })
        expect(stored(harness, "mcp-1")).toMatchObject({ mode: "mcp", agent: "claude-code", status: "running" })
        expect(indexed(harness)).toEqual([{ id: "mcp-1", status: "running" }])
        expect(harness.locks.heldNames()).toEqual(["wherefore/active-run", "wherefore/run/mcp-1"])

        // A view's sweep leaves it alone: the worker holds its lock.
        yield* page.call("check_runs", undefined)
        expect(stored(harness, "mcp-1")?.status).toBe("running")

        // Finished: the agent stores the result, then lets go of the lease.
        yield* broker("update_run", { run: runOf("mcp-1", { status: "succeeded", finishedAt: "2026-10-06T09:05:00.000Z" }) })
        yield* lease.close
        yield* waitUntil(() => harness.locks.heldNames().length === 0)
        expect(stored(harness, "mcp-1")?.status).toBe("succeeded")
      }))
  })

  it.effect("marks the run interrupted when its agent goes away, then frees the profile", () => {
    const harness = setup()
    return withBroker(harness, (broker) =>
      Effect.gen(function*() {
        const lease = yield* openLease(broker, "mcp-2")
        yield* broker("update_run", { run: runOf("mcp-2", { steps: [readingStep] }) })
        yield* lease.close
        yield* waitUntil(() => stored(harness, "mcp-2")?.status === "interrupted")
        const run = stored(harness, "mcp-2")
        expect(run?.error).toEqual({ reason: "interrupted", message: AGENT_GONE_MESSAGE })
        expect(run?.steps[0]).toMatchObject({ status: "error", summary: STOPPED_STEP })
        yield* waitUntil(() => harness.locks.heldNames().length === 0)
        // Updates after the lease ended are refused.
        const late = yield* Effect.flip(broker("update_run", { run: runOf("mcp-2") }))
        expect(late._tag).toBe("RunNotActive")
        // The profile is free for the next run.
        const next = yield* openLease(broker, "mcp-3")
        expect(next.signals).toEqual([{ _tag: "Opened" }])
      }))
  })

  it.effect("marks the run interrupted when Chrome's port to the companion closes", () => {
    const harness = setup()
    return withBroker(harness, (broker) =>
      Effect.gen(function*() {
        yield* openLease(broker, "mcp-4")
        yield* broker("update_run", { run: runOf("mcp-4") })
        harness.native.last?.exit()
        yield* waitUntil(() => stored(harness, "mcp-4")?.status === "interrupted")
        yield* waitUntil(() => harness.locks.heldNames().length === 0)
      }))
  })

  it.effect("a worker that stopped mid-run marks the run interrupted at its next start", () => {
    const harness = setup()
    return Effect.gen(function*() {
      yield* withBroker(harness, (broker) =>
        Effect.gen(function*() {
          yield* openLease(broker, "mcp-5")
          yield* broker("update_run", { run: runOf("mcp-5") })
          yield* harness.crashWorker
          expect(stored(harness, "mcp-5")?.status).toBe("running")
          yield* harness.startWorker
          expect(stored(harness, "mcp-5")?.status).toBe("interrupted")
        }))
    })
  })

  it.effect("keeps one run per profile, whatever started it, and names the other run's source", () => {
    const harness = setup()
    return withBroker(harness, (broker, page) =>
      Effect.gen(function*() {
        // A companion run is going: a second lease, and an API-mode run in a page, are refused.
        const first = yield* openLease(broker, "mcp-6")
        yield* broker("update_run", { run: runOf("mcp-6") })
        const second = yield* openLease(broker, "mcp-7")
        expect(Exit.findErrorOption(yield* Fiber.await(second.fiber))).toMatchObject({
          _tag: "Some",
          value: { _tag: "RunAlreadyActive", runId: "mcp-6", source: "mcp" }
        })
        const pageLocks = makeWebLocks(harness.locks.client())
        const busy = yield* Effect.flip(Effect.scoped(pageLocks.hold("api-1" as never)))
        expect(busy._tag).toBe("RunAlreadyActive")
        yield* broker("update_run", { run: runOf("mcp-6", { status: "cancelled", finishedAt: "2026-10-06T09:01:00.000Z" }) })
        yield* first.close
        yield* waitUntil(() => harness.locks.heldNames().length === 0)

        // An API-mode run is going in a page: the companion's lease is refused, naming it.
        const pageScope = yield* Scope.make()
        yield* pageLocks.hold("api-1" as never).pipe(Scope.provide(pageScope))
        const { agent: _, ...apiRun } = runOf("api-1", { mode: "api", model: "claude-opus-5-5" })
        yield* page.call("save_run", { run: apiRun })
        const refused = yield* openLease(broker, "mcp-8")
        expect(Exit.findErrorOption(yield* Fiber.await(refused.fiber))).toMatchObject({
          _tag: "Some",
          value: { _tag: "RunAlreadyActive", runId: "api-1", source: "api" }
        })
        yield* Scope.close(pageScope, Exit.void)
      }))
  })

  it.effect("asks the profile's panels; the first answer wins, and the agent gets it", () => {
    const harness = setup()
    harness.chrome.openViews = 2
    return withBroker(harness, (broker, page) =>
      Effect.gen(function*() {
        yield* openLease(broker, "mcp-9")
        yield* broker("update_run", { run: runOf("mcp-9") })
        const asking = yield* Effect.forkChild(broker("ask_panel", { runId: "mcp-9" as never, askId: "ask-1", questions: [question as never] }))
        // Once the worker holds the ask, two panels answer.
        yield* waitUntil(() => harness.chrome.viewChecks > 0)
        let first = false
        for (let i = 0; i < 50 && !first; i++) {
          first = yield* page.call("answer_ask", { runId: "mcp-9" as never, askId: "ask-1", answers: [{ id: "q1" as never, answer: "Yes" }] })
          if (!first) yield* Effect.yieldNow
        }
        expect(first).toBe(true)
        const late = yield* page.call("answer_ask", { runId: "mcp-9" as never, askId: "ask-1", answers: [{ id: "q1" as never, answer: "No" }] })
        expect(late).toBe(false)
        expect(yield* Fiber.join(asking)).toEqual({ answers: [{ id: "q1", answer: "Yes" }] })
        // An answer naming another run, or an unknown ask, is refused.
        expect(yield* page.call("answer_ask", { runId: "mcp-9" as never, askId: "nope", answers: [] })).toBe(false)
      }))
  })

  it.effect("says so when no panel is open, or when every panel closes before an answer", () => {
    const harness = setup()
    harness.chrome.openViews = 0
    return withBroker(harness, (broker) =>
      Effect.gen(function*() {
        yield* openLease(broker, "mcp-10")
        const none = yield* Effect.flip(broker("ask_panel", { runId: "mcp-10" as never, askId: "ask-1", questions: [question as never] }))
        expect(none).toMatchObject({ _tag: "QuestionsUnavailable", message: NO_PANEL_MESSAGE })

        harness.chrome.openViews = 1
        const checks = harness.chrome.viewChecks
        const asking = yield* Effect.forkChild(broker("ask_panel", { runId: "mcp-10" as never, askId: "ask-2", questions: [question as never] }))
        const tick = (n: number) =>
          Effect.andThen(TestClock.adjust(VIEWS_CHECK_INTERVAL), waitUntil(() => harness.chrome.viewChecks >= checks + n))
        yield* waitUntil(() => harness.chrome.viewChecks === checks + 1)
        yield* tick(2)
        harness.chrome.openViews = 0
        yield* tick(3)
        expect(asking.pollUnsafe()).toBeUndefined() // one missed check could be a panel reloading
        yield* TestClock.adjust(VIEWS_CHECK_INTERVAL)
        const closed = yield* Effect.flip(Fiber.join(asking))
        expect(closed).toMatchObject({ _tag: "QuestionsUnavailable", message: PANEL_CLOSED_MESSAGE })
      }))
  })

  it.effect("Stop in the panel stores the run cancelled, withdraws its question and tells the agent", () => {
    const harness = setup()
    return withBroker(harness, (broker, page) =>
      Effect.gen(function*() {
        const lease = yield* openLease(broker, "mcp-11")
        yield* broker("update_run", { run: runOf("mcp-11", { steps: [readingStep] }) })
        const asking = yield* Effect.forkChild(broker("ask_panel", { runId: "mcp-11" as never, askId: "ask-1", questions: [question as never] }))
        yield* Effect.yieldNow
        yield* page.call("stop_run", { id: "mcp-11" as never })
        const run = stored(harness, "mcp-11")
        expect(run).toMatchObject({ status: "cancelled" })
        expect(run?.steps[0]).toMatchObject({ status: "error", summary: STOPPED_STEP })
        expect(indexed(harness)).toEqual([{ id: "mcp-11", status: "cancelled" }])
        yield* waitUntil(() => lease.signals.length === 2)
        expect(lease.signals[1]).toEqual({ _tag: "Stopped", message: STOPPED_MESSAGE })
        expect(Exit.isSuccess(yield* Fiber.await(lease.fiber))).toBe(true)
        expect(yield* Effect.flip(Fiber.join(asking))).toMatchObject({ _tag: "RunNotActive" })
        expect((yield* Effect.flip(broker("update_run", { run: runOf("mcp-11") })))._tag).toBe("RunNotActive")
        yield* waitUntil(() => harness.locks.heldNames().length === 0)
        expect(stored(harness, "mcp-11")?.status).toBe("cancelled")
        // Stopping a run that isn't the companion's does nothing.
        yield* page.call("stop_run", { id: "mcp-11" as never })
      }))
  })
})

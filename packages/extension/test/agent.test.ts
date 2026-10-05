/**
 * The API agent end to end: the real worker (TabTools, Store, RPC over fake Ports), the real
 * `ModelClient` over a scripted `LanguageModel`, the in-page Questions inbox and shared Web Locks.
 */
import { assert, describe, expect, it } from "@effect/vitest"
import { type Run, SYSTEM_PROMPT } from "@wherefore/core"
import { Duration, Effect, Fiber, Layer, Schema, Stream, SubscriptionRef } from "effect"
import { TestClock } from "effect/testing"
import { type Inbox, QuestionsInbox } from "../src/agent/Questions.ts"
import { type RunHandle, SKIPPED_ANSWER, TriageAgent } from "../src/agent/TriageAgent.ts"
import { WorkerClient } from "../src/messaging/WorkerClient.ts"
import { runsKey } from "../src/store/keys.ts"
import { StoreReader } from "../src/store/StoreReader.ts"
import { AiError } from "../src/unstable.ts"
import { FakeChrome } from "./fakes/chrome.ts"
import { Harness, waitUntil } from "./fakes/harness.ts"
import { callTools, failWith, finish, lastUserText, ScriptedModel, text, toolCall, toolResults } from "./fakes/model.ts"

const page = (url: string, body = "Hello world") => ({
  title: "A page",
  url,
  headings: ["Heading"],
  description: "Description",
  text: body,
  scrollPct: 40,
  media: null,
  selection: ""
})

const settings = { version: 1, data: { apiKey: "sk-test-secret" } }

const browser = (overrides: { readonly local?: Record<string, unknown>; readonly reloadCompletes?: boolean } = {}) =>
  new FakeChrome({
    tabs: [
      { id: 1, windowId: 1, url: "https://github.com/acme/api/pull/412", title: "Auth PR #412" },
      { id: 2, windowId: 1, url: "https://shop.example/desk-a", title: "Desk A" },
      { id: 3, windowId: 1, url: "https://shop.example/desk-b", title: "Desk B", discarded: true }
    ],
    pages: { 1: page("https://github.com/acme/api/pull/412", "Merged"), 3: page("https://shop.example/desk-b") },
    local: { settings, ...overrides.local },
    reloadCompletes: overrides.reloadCompletes ?? true
  })

const intention = (title: string, tabIds: ReadonlyArray<number>, kind = "decide") => ({
  title,
  why: "Comparing desks",
  kind,
  tab_ids: tabIds,
  confidence: "high",
  evidence: "titles"
})

const allThree = [intention("Finish the auth PR", [1], "done"), intention("Decide between two desks", [2, 3])]

const storedRuns = (harness: Harness): ReadonlyArray<Run> =>
  Schema.decodeUnknownSync(runsKey.schema)((harness.chrome.local.get("runs") as { data: unknown } | undefined)?.data ?? [])

/** A page: the agent, its Questions inbox, and a client of the shared lock manager. */
const inPage = <A, E>(
  harness: Harness,
  model: ScriptedModel,
  body: (
    agent: TriageAgent["Service"],
    inbox: Inbox,
    pageLocks: { readonly id: number }
  ) => Effect.Effect<A, E, WorkerClient | StoreReader>
) =>
  Effect.gen(function*() {
    yield* harness.startWorker
    const locks = harness.locks.runLocks()
    const deps = Layer.mergeAll(
      harness.clientLayer,
      StoreReader.layer.pipe(Layer.provide(harness.chrome.layer)),
      QuestionsInbox.layer,
      model.layer,
      locks.layer
    )
    return yield* Effect.gen(function*() {
      return yield* body(yield* TriageAgent, yield* QuestionsInbox, locks.client)
    }).pipe(Effect.provide(TriageAgent.layer.pipe(Layer.provideMerge(deps))))
  }).pipe(Effect.scoped)

const runToEnd = (agent: TriageAgent["Service"], options?: { readonly maxTurns?: number }) =>
  Effect.flatMap(agent.start(options), (handle) => handle.await)

describe("TriageAgent", () => {
  it.effect("reads a page, submits, and stores every step of a succeeded run", () => {
    const harness = new Harness(browser())
    const model = new ScriptedModel([
      callTools(toolCall("call_read", "read_pages", { tab_ids: [1] })),
      (prompt) => {
        const read = toolResults(prompt).get("call_read")
        expect(read?.isFailure).toBe(false)
        expect(JSON.stringify(read?.result)).toContain("Merged")
        return callTools(toolCall("call_submit", "submit_intentions", { intentions: allThree }))(prompt)
      }
    ])
    return inPage(harness, model, (agent) =>
      Effect.gen(function*() {
        const run = yield* runToEnd(agent)
        expect(run.status).toBe("succeeded")
        expect(run.model).toBe("claude-opus-5-5")
        expect(model.built).toEqual([{ apiKey: "sk-test-secret", model: "claude-opus-5-5" }])
        expect(model.calls).toBe(2) // no extra request after a successful submit

        // The first request: the system prompt (a cache breakpoint) and the tabs as data.
        const first = model.prompts[0]
        assert(first !== undefined)
        const system = first.content[0]
        assert(system?.role === "system")
        expect(system.content).toBe(SYSTEM_PROMPT)
        expect(system.options).toMatchObject({ anthropic: { cacheControl: { type: "ephemeral" } } })
        const kickoff = lastUserText(first)
        expect(kickoff).toContain("Here are my 3 open tabs")
        expect(kickoff).toContain('"title":"Desk B"')
        expect(kickoff).toContain('"asleep":true')

        expect(run.intentions.map((i) => [i.id, i.title, i.tabIds])).toEqual([
          [`${run.id}:0`, "Finish the auth PR", [1]],
          [`${run.id}:1`, "Decide between two desks", [2, 3]]
        ])
        expect(run.tabs.map((tab) => tab.id)).toEqual([1, 2, 3])
        expect(run.steps.map((step) => step.kind === "tool" ? `${step.tool}:${step.status}:${step.summary}` : step.kind))
          .toEqual([
            "list_tabs:ok:Listed 3 tabs",
            "model",
            "read_pages:ok:Read 1 page",
            "model",
            "submit_intentions:ok:Submitted 2 groups"
          ])
        const turn = run.steps[1]
        expect(turn?.kind === "model" && turn.toolCalls).toEqual(["read_pages"])
        expect(run.usage).toMatchObject({ requests: 2, inputTokens: 2000, outputTokens: 400 })
        expect(run.usage.costUsd).toBeCloseTo((2000 * 4 + 400 * 20) / 1_000_000, 9)
        expect(run.finishedAt).toBeDefined()

        // Stored as it ended, and its lock is free again.
        expect(storedRuns(harness)).toEqual([run])
        yield* waitUntil(() => harness.locks.heldNames().length === 0)
      }))
  })

  it.effect("sends a coverage error back to the model, which fixes its submission", () => {
    const harness = new Harness(browser())
    const model = new ScriptedModel([
      callTools(toolCall("call_1", "submit_intentions", { intentions: [intention("Desks", [2, 9])] })),
      (prompt) => {
        const rejected = toolResults(prompt).get("call_1")
        expect(rejected?.isFailure).toBe(true)
        expect(rejected?.result).toMatchObject({ _tag: "CoverageError", missing: [1, 3], unknown: [9] })
        return callTools(toolCall("call_2", "submit_intentions", { intentions: allThree }))(prompt)
      }
    ])
    return inPage(harness, model, (agent) =>
      Effect.gen(function*() {
        const run = yield* runToEnd(agent)
        expect(run.status).toBe("succeeded")
        expect(run.intentions).toHaveLength(2)
        const submits = run.steps.filter((step) => step.kind === "tool" && step.tool === "submit_intentions")
        expect(submits.map((step) => step.kind === "tool" && [step.status, step.summary])).toEqual([
          ["error", "Rejected: 2 tabs missing, 1 unknown tab"],
          ["ok", "Submitted 2 groups"]
        ])
      }))
  })

  it.effect("fails with turn_limit when the model never submits", () => {
    const harness = new Harness(browser())
    const listForever = callTools(toolCall("again", "list_tabs", {}))
    const model = new ScriptedModel([listForever, listForever, listForever])
    return inPage(harness, model, (agent) =>
      Effect.gen(function*() {
        const run = yield* runToEnd(agent, { maxTurns: 2 })
        expect(run.status).toBe("failed")
        expect(run.error?.reason).toBe("turn_limit")
        expect(model.calls).toBe(2)
        expect(storedRuns(harness)[0]?.status).toBe("failed")
      }))
  })

  it.effect("reminds a model that stops without submitting, then gives up", () => {
    const harness = new Harness(browser())
    const chat = () => Effect.succeed([text("Here is what I think."), finish("stop")])
    const model = new ScriptedModel([
      chat,
      (prompt) => {
        expect(lastUserText(prompt)).toContain("You haven't submitted yet")
        return chat()
      },
      chat
    ])
    return inPage(harness, model, (agent) =>
      Effect.gen(function*() {
        const run = yield* runToEnd(agent)
        expect(run.status).toBe("failed")
        expect(run.error?.reason).toBe("no_submission")
        expect(model.calls).toBe(3)
        expect(run.steps.filter((step) => step.kind === "note")).toHaveLength(2)
        const turn = run.steps.find((step) => step.kind === "model")
        expect(turn?.kind === "model" && turn.text).toBe("Here is what I think.")
      }))
  })

  it.effect("asks the user, takes the first answer, fills in skipped ones, and shows the questions to mirrors", () => {
    const harness = new Harness(browser())
    const questions = [
      { id: "q1", tab_ids: [2, 3], question: "Still choosing a desk?", options: ["Yes", "No, bought one"] },
      { id: "q2", tab_ids: [1], question: "Do you own this PR?", options: ["Yes", "No"] }
    ]
    const model = new ScriptedModel([
      callTools(toolCall("ask_1", "ask_user", { questions })),
      (prompt) => {
        expect(toolResults(prompt).get("ask_1")?.result).toEqual({
          answers: [{ id: "q1", answer: "Yes" }, { id: "q2", answer: SKIPPED_ANSWER }]
        })
        return callTools(toolCall("submit", "submit_intentions", { intentions: allThree }))(prompt)
      }
    ])
    return inPage(harness, model, (agent, inbox) =>
      Effect.gen(function*() {
        const handle = yield* agent.start()
        yield* waitUntil(() => SubscriptionRef.getUnsafe(inbox.pending).length === 1)
        const [ask] = SubscriptionRef.getUnsafe(inbox.pending)
        assert(ask !== undefined)
        expect(ask.runId).toBe(handle.id)
        expect(ask.questions.map((q) => q.tabIds)).toEqual([[2, 3], [1]])

        // Another view, reading only the Store, sees the run waiting on the questions.
        const mirrored = storedRuns(harness)[0]
        expect(mirrored?.status).toBe("running")
        const asked = mirrored?.steps.at(-1)
        expect(asked?.kind === "question" && asked.answers).toBeUndefined()

        expect(yield* inbox.answer(ask.id, [{ id: ask.questions[0]!.id, answer: " Yes " }])).toBe(true)
        // A second view answering the same ask is too late.
        expect(yield* inbox.answer(ask.id, [{ id: ask.questions[0]!.id, answer: "No" }])).toBe(false)

        const run = yield* handle.await
        expect(run.status).toBe("succeeded")
        const answered = run.steps.find((step) => step.kind === "question")
        expect(answered?.kind === "question" && answered.answers).toEqual([
          { id: "q1", answer: "Yes" },
          { id: "q2", answer: SKIPPED_ANSWER }
        ])
        expect(SubscriptionRef.getUnsafe(inbox.pending)).toEqual([])
      }))
  })

  it.effect("cancels mid tool call: the call is interrupted and the run is stored as cancelled", () => {
    const harness = new Harness(browser({ reloadCompletes: false }))
    const model = new ScriptedModel([callTools(toolCall("wake", "wake_and_read_pages", { tab_ids: [3] }))])
    return inPage(harness, model, (agent) =>
      Effect.gen(function*() {
        const handle = yield* agent.start()
        yield* waitUntil(() => harness.chrome.calls.includes("tabs.reload 3"))
        yield* handle.cancel
        const run = yield* handle.current
        expect(run.status).toBe("cancelled")
        expect(run.error).toBeUndefined()
        const woke = run.steps.find((step) => step.kind === "tool" && step.tool === "wake_and_read_pages")
        expect(woke?.kind === "tool" && [woke.status, woke.summary]).toEqual(["error", "Stopped"])
        expect(model.calls).toBe(1)
        expect(storedRuns(harness)).toEqual([run])
        yield* waitUntil(() => harness.locks.heldNames().length === 0)
      }))
  })

  it.effect("cancels while waiting for answers, and withdraws the questions", () => {
    const harness = new Harness(browser())
    const model = new ScriptedModel([
      callTools(toolCall("ask", "ask_user", { questions: [{ id: "q", tab_ids: [1], question: "Why?", options: [] }] }))
    ])
    return inPage(harness, model, (agent, inbox) =>
      Effect.gen(function*() {
        const handle = yield* agent.start()
        yield* waitUntil(() => SubscriptionRef.getUnsafe(inbox.pending).length === 1)
        yield* handle.cancel
        expect(SubscriptionRef.getUnsafe(inbox.pending)).toEqual([])
        expect((yield* handle.current).status).toBe("cancelled")
      }))
  })

  it.effect("fails with a typed refusal when the model declines", () => {
    const harness = new Harness(browser())
    const model = new ScriptedModel([() => Effect.succeed([finish("content-filter")])])
    return inPage(harness, model, (agent) =>
      Effect.gen(function*() {
        const run = yield* runToEnd(agent)
        expect(run.status).toBe("failed")
        expect(run.error).toEqual({ reason: "refusal", message: "The model declined to look at these tabs." })
      }))
  })

  it.effect("fails with a typed max_tokens error when the reply is cut off", () => {
    const harness = new Harness(browser())
    const model = new ScriptedModel([() => Effect.succeed([text("Let me th"), finish("length")])])
    return inPage(harness, model, (agent) =>
      Effect.gen(function*() {
        const run = yield* runToEnd(agent)
        expect(run.error?.reason).toBe("max_tokens")
      }))
  })

  it.effect("maps a rejected API key to a typed error without retrying", () => {
    const harness = new Harness(browser())
    const model = new ScriptedModel([failWith(new AiError.AuthenticationError({ kind: "InvalidKey" }))])
    return inPage(harness, model, (agent) =>
      Effect.gen(function*() {
        const run = yield* runToEnd(agent)
        expect(run.status).toBe("failed")
        expect(run.error).toEqual({
          reason: "invalid_key",
          message: "Anthropic didn't accept the API key. Check it in Settings."
        })
        expect(model.calls).toBe(1)
        expect(JSON.stringify(storedRuns(harness))).not.toContain("sk-test-secret")
      }))
  })

  it.effect("retries a rate-limited request after the time the provider asked for", () => {
    const harness = new Harness(browser())
    const model = new ScriptedModel([
      failWith(new AiError.RateLimitError({ retryAfter: Duration.seconds(7) })),
      callTools(toolCall("submit", "submit_intentions", { intentions: allThree }))
    ])
    return inPage(harness, model, (agent) =>
      Effect.gen(function*() {
        const handle = yield* agent.start()
        yield* waitUntil(() => model.calls === 1)
        yield* waitUntil(() => storedRuns(harness)[0]?.steps.some((step) => step.kind === "note") === true)
        const retrying = storedRuns(harness)[0]?.steps.find((step) => step.kind === "note")
        expect(retrying?.kind === "note" && retrying.message).toMatch(/^Retrying in 7s: Anthropic is rate limiting/)
        yield* TestClock.adjust("6 seconds")
        expect(model.calls).toBe(1)
        yield* TestClock.adjust("1 second")
        const run = yield* handle.await
        expect(run.status).toBe("succeeded")
        expect(model.calls).toBe(2)
      }))
  })

  it.effect("refuses to start without an API key", () => {
    const harness = new Harness(browser({ local: { settings: { version: 1, data: {} } } }))
    const model = new ScriptedModel([])
    return inPage(harness, model, (agent) =>
      Effect.gen(function*() {
        const missing = yield* Effect.flip(agent.start())
        expect(missing).toMatchObject({ _tag: "ModelError", reason: "missing_key" })
        expect(storedRuns(harness)).toEqual([])
      }))
  })

  it.effect("refuses to start while another page runs a run", () => {
    const harness = new Harness(browser())
    const model = new ScriptedModel([
      callTools(toolCall("ask", "ask_user", { questions: [{ id: "q", tab_ids: [1], question: "Why?", options: [] }] }))
    ])
    return Effect.gen(function*() {
      // Another page holds a run's locks.
      const other = harness.locks.client()
      let release: () => void = () => {}
      yield* Effect.promise(() =>
        new Promise<void>((started) => {
          void other.request("wherefore/api-run", {}, () =>
            new Promise<void>((resolve) => {
              release = resolve
              started()
            }))
        })
      )
      yield* inPage(harness, model, (agent) =>
        Effect.gen(function*() {
          const busy = yield* Effect.flip(agent.start())
          expect(busy._tag).toBe("RunAlreadyActive")
          release()
          yield* waitUntil(() => harness.locks.heldNames().length === 0)
          const handle: RunHandle = yield* agent.start()
          yield* handle.cancel
        }))
    })
  })
})

describe("interrupted runs", () => {
  const leftRunning = {
    id: "run-old",
    mode: "api",
    model: "claude-opus-5-5",
    startedAt: "2026-10-05T08:00:00.000Z",
    status: "running",
    tabs: [],
    steps: [],
    intentions: [],
    usage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  }

  it.effect("a run left running by a closed page is marked interrupted when the worker starts", () => {
    const harness = new Harness(browser({ local: { runs: { version: 1, data: [leftRunning] } } }))
    return Effect.gen(function*() {
      yield* harness.startWorker
      const [run] = storedRuns(harness)
      expect(run?.status).toBe("interrupted")
      expect(run?.error?.reason).toBe("interrupted")
      expect(run?.finishedAt).toBeDefined()
    }).pipe(Effect.scoped)
  })

  it.effect("a page that closes mid-run loses its lock, and the next check marks its run interrupted", () => {
    const harness = new Harness(browser())
    const model = new ScriptedModel([
      callTools(toolCall("ask", "ask_user", { questions: [{ id: "q", tab_ids: [1], question: "Why?", options: [] }] }))
    ])
    return inPage(harness, model, (agent, inbox, pageLocks) =>
      Effect.gen(function*() {
        const handle = yield* agent.start()
        yield* waitUntil(() => SubscriptionRef.getUnsafe(inbox.pending).length === 1)
        // The worker's sweep leaves a live run alone.
        const client = yield* WorkerClient
        yield* client.call("check_runs", undefined)
        expect(storedRuns(harness)[0]?.status).toBe("running")

        // The page closes: the browser drops its locks, and none of its code runs again.
        harness.locks.close(pageLocks)
        yield* client.call("check_runs", undefined)
        const [run] = storedRuns(harness)
        expect(run?.id).toBe(handle.id)
        expect(run?.status).toBe("interrupted")
      }))
  })

  it.effect("starting a new run marks the one a closed page left behind", () => {
    const harness = new Harness(browser())
    const model = new ScriptedModel([callTools(toolCall("submit", "submit_intentions", { intentions: allThree }))])
    return inPage(harness, model, (agent) =>
      Effect.gen(function*() {
        // Written after the worker started, as if a page had closed while the worker ran.
        harness.chrome.local.set("runs", { version: 1, data: [leftRunning] })
        const run = yield* runToEnd(agent)
        expect(storedRuns(harness).map((stored) => [stored.id, stored.status])).toEqual([
          ["run-old", "interrupted"],
          [run.id, "succeeded"]
        ])
      }))
  })

  it.effect("a final save that misses the worker twice is retried, so a finished run is never marked interrupted", () => {
    const harness = new Harness(browser())
    const model = new ScriptedModel([callTools(toolCall("submit", "submit_intentions", { intentions: allThree }))])
    let failures = 0
    harness.failSaveRun = (run) => run.status !== "running" && failures++ < 2
    return inPage(harness, model, (agent) =>
      Effect.gen(function*() {
        const run = yield* runToEnd(agent)
        expect(run.status).toBe("succeeded")
        // The lock is released after the final save, and a sweep then leaves the run alone.
        yield* waitUntil(() => harness.locks.heldNames().length === 0)
        yield* (yield* WorkerClient).call("check_runs", undefined)
        expect(storedRuns(harness).map((stored) => [stored.id, stored.status])).toEqual([[run.id, "succeeded"]])
        expect(failures).toBe(3) // two failed attempts, then the one that went through
      }))
  })

  it.effect("a mirror following the Store sees the run step by step until it ends", () => {
    const harness = new Harness(browser())
    const model = new ScriptedModel([callTools(toolCall("submit", "submit_intentions", { intentions: allThree }))])
    return inPage(harness, model, (agent) =>
      Effect.gen(function*() {
        const reader = yield* StoreReader
        const seen = yield* reader.watch(runsKey).pipe(
          Stream.map((runs) => runs.at(-1)),
          Stream.filter((run) => run !== undefined),
          Stream.takeUntil((run) => run.status !== "running"),
          Stream.map((run) => `${run.status}:${run.steps.length}`),
          Stream.runCollect,
          Effect.forkChild
        )
        const handle = yield* agent.start()
        const steps = (yield* handle.await).steps.length
        const values = [...(yield* Fiber.join(seen))]
        expect(values[0]).toBe("running:0")
        expect(values.at(-1)).toBe(`succeeded:${steps}`)
        expect(values.length).toBeGreaterThan(3)
      }))
  })
})

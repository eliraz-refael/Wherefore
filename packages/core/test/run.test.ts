import { describe, expect, it } from "@effect/vitest"
import { DateTime } from "effect"
import {
  addUsage,
  emptyUsage,
  estimateCostUsd,
  interruptRun,
  MAX_RUNS,
  Run,
  RunId,
  type RunIndexEntry,
  upsertRunIndex
} from "../src/index.ts"
import { decodeOk, encodeOk, rejects } from "./helpers.ts"

const wireRun = {
  id: "run-1",
  mode: "api",
  model: "claude-opus-5-5",
  startedAt: "2026-10-05T09:00:00.000Z",
  status: "running",
  tabs: [{ id: 11, window: 1, index: 0, title: "Auth PR", url: "https://github.com/acme/api/pull/412" }],
  steps: [
    { kind: "tool", at: "2026-10-05T09:00:01.000Z", callId: "start", tool: "list_tabs", status: "ok", summary: "Listed 1 tab" },
    {
      kind: "model",
      at: "2026-10-05T09:00:05.000Z",
      text: "",
      toolCalls: ["ask_user"],
      stop: "tool_calls",
      usage: { requests: 1, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 2000 }
    },
    {
      kind: "question",
      at: "2026-10-05T09:00:06.000Z",
      callId: "toolu_1",
      questions: [{ id: "q1", tab_ids: [11], question: "Still reviewing this?", options: ["Yes", "No"] }],
      answers: [{ id: "q1", answer: "Yes" }]
    },
    { kind: "note", at: "2026-10-05T09:00:07.000Z", message: "Retrying: rate limited" }
  ],
  intentions: [],
  usage: { requests: 1, inputTokens: 1200, outputTokens: 300, cacheReadTokens: 0, cacheWriteTokens: 2000, costUsd: 0.0208 }
}

const at = (iso: string) => DateTime.makeUnsafe(iso)

describe("Run", () => {
  it("round-trips its stored (JSON) form", () => {
    const run = decodeOk(Run, wireRun)
    expect(run.id).toBe("run-1")
    expect(DateTime.isDateTime(run.startedAt)).toBe(true)
    const question = run.steps[2]
    expect(question?.kind === "question" && question.questions[0]?.tabIds).toEqual([11])
    expect(encodeOk(Run, run)).toEqual(wireRun)
  })

  it("has finishedAt exactly when it is no longer running", () => {
    expect(rejects(Run, { ...wireRun, finishedAt: "2026-10-05T09:01:00.000Z" })).toBe(true)
    expect(rejects(Run, { ...wireRun, status: "succeeded" })).toBe(true)
    expect(decodeOk(Run, { ...wireRun, status: "succeeded", finishedAt: "2026-10-05T09:01:00.000Z" }).status).toBe(
      "succeeded"
    )
  })

  it("has an error exactly when it failed or was interrupted", () => {
    const finished = { ...wireRun, finishedAt: "2026-10-05T09:01:00.000Z" }
    expect(rejects(Run, { ...finished, status: "failed" })).toBe(true)
    expect(rejects(Run, { ...finished, status: "cancelled", error: { reason: "unexpected", message: "x" } })).toBe(true)
    expect(decodeOk(Run, { ...finished, status: "failed", error: { reason: "invalid_key", message: "Bad key" } }).error)
      .toEqual({ reason: "invalid_key", message: "Bad key" })
  })
})

describe("upsertRunIndex", () => {
  const entry = (id: string, status: RunIndexEntry["status"] = "running"): RunIndexEntry => ({ id: RunId.make(id), status })

  it("updates an entry with the same id in place, or appends a new one", () => {
    const index = [entry("a"), entry("b")]
    expect(upsertRunIndex(index, entry("a", "succeeded"))).toEqual({
      index: [entry("a", "succeeded"), entry("b")],
      dropped: []
    })
    expect(upsertRunIndex(index, entry("c")).index.map((e) => e.id)).toEqual(["a", "b", "c"])
  })

  it("returns the same index when nothing changed", () => {
    const index = [entry("a"), entry("b")]
    expect(upsertRunIndex(index, entry("b")).index).toBe(index)
  })

  it(`keeps only the newest ${MAX_RUNS} and says which ids it dropped`, () => {
    let index: ReadonlyArray<RunIndexEntry> = []
    const dropped: Array<string> = []
    for (let i = 0; i < MAX_RUNS + 3; i++) {
      const next = upsertRunIndex(index, entry(`r${i}`))
      index = next.index
      dropped.push(...next.dropped)
    }
    expect(index).toHaveLength(MAX_RUNS)
    expect(index[0]?.id).toBe("r3")
    expect(index.at(-1)?.id).toBe(`r${MAX_RUNS + 2}`)
    expect(dropped).toEqual(["r0", "r1", "r2"])
  })
})

describe("interruptRun", () => {
  it("marks a running run interrupted, with a message for the user, and leaves finished runs alone", () => {
    const run = decodeOk(Run, wireRun)
    const interrupted = interruptRun(run, at("2026-10-05T10:00:00.000Z"))
    expect(interrupted.status).toBe("interrupted")
    expect(interrupted.error?.reason).toBe("interrupted")
    expect(rejects(Run, encodeOk(Run, interrupted))).toBe(false)

    const done: Run = { ...run, status: "succeeded", finishedAt: at("2026-10-05T09:01:00.000Z") }
    expect(interruptRun(done, at("2026-10-05T10:00:00.000Z"))).toBe(done)
  })
})

describe("usage and cost", () => {
  it("adds usage field by field", () => {
    const one = { requests: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 50 }
    expect(addUsage(addUsage(emptyUsage, one), one)).toEqual({
      requests: 2,
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 200,
      cacheWriteTokens: 100
    })
  })

  it("estimates cost at list prices, and gives none for unknown models", () => {
    const usage = { requests: 3, inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 2_000_000, cacheWriteTokens: 400_000 }
    // Opus 5.5: $4 in, $20 out, $5 cache write, $0.20 cache read per MTok.
    expect(estimateCostUsd("claude-opus-5-5", usage)).toBeCloseTo(4 + 2 + 2 + 0.4, 6)
    // Sonnet 5.5: $2 in, $10 out, $2.50 cache write, $0.20 cache read per MTok.
    expect(estimateCostUsd("claude-sonnet-5-5", usage)).toBeCloseTo(2 + 1 + 1 + 0.4, 6)
    expect(estimateCostUsd("some-future-model", usage)).toBeUndefined()
    expect(estimateCostUsd("toString", usage)).toBeUndefined()
  })
})

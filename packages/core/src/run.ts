/**
 * A triage run, as stored and mirrored (architecture A4/A5): every step is persisted while the run
 * goes, so any open view can follow it and a closed view can come back to it.
 *
 * A run records what happened, not what the model read: steps carry short summaries, never page
 * text. The tab snapshot is what the model saw (redacted URLs).
 */
import { DateTime, Schema } from "effect"
import { RunId } from "./ids.ts"
import { Answer, Intention, Question } from "./intention.ts"
import type { ApiModel } from "./settings.ts"
import { TabSnapshot } from "./tab.ts"

const DateTimeUtc = Schema.DateTimeUtcFromString
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

export const RunStatus = Schema.Literals([
  "running",
  "succeeded",
  "failed",
  "cancelled", // the user stopped it
  "interrupted" // the page running it closed before it finished
])
export type RunStatus = typeof RunStatus.Type

/** Tokens used by one or more model requests. */
export const TokenUsage = Schema.Struct({
  requests: Count,
  inputTokens: Count,
  outputTokens: Count,
  cacheReadTokens: Count,
  cacheWriteTokens: Count
})
export type TokenUsage = typeof TokenUsage.Type

export const emptyUsage: TokenUsage = {
  requests: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0
}

export const addUsage = (a: TokenUsage, b: TokenUsage): TokenUsage => ({
  requests: a.requests + b.requests,
  inputTokens: a.inputTokens + b.inputTokens,
  outputTokens: a.outputTokens + b.outputTokens,
  cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens
})

/** Why a model turn ended, provider-neutral. */
export const TurnStop = Schema.Literals(["tool_calls", "end", "max_tokens", "refusal", "pause", "other"])
export type TurnStop = typeof TurnStop.Type

/** One model request and what it answered. `text` is its visible text, shortened. */
export const ModelStep = Schema.Struct({
  kind: Schema.Literal("model"),
  at: DateTimeUtc,
  text: Schema.String,
  /** Names of the tools it called, in order. */
  toolCalls: Schema.Array(Schema.String),
  stop: TurnStop,
  usage: TokenUsage
})
export type ModelStep = typeof ModelStep.Type

/** One tool call. `summary` is a short, human line ("Read 3 pages"), never page content. */
export const ToolStep = Schema.Struct({
  kind: Schema.Literal("tool"),
  at: DateTimeUtc,
  callId: Schema.String,
  tool: Schema.String,
  status: Schema.Literals(["running", "ok", "error"]),
  summary: Schema.String
})
export type ToolStep = typeof ToolStep.Type

/** An `ask_user` call: the questions, then the answers once given. */
export const QuestionStep = Schema.Struct({
  kind: Schema.Literal("question"),
  at: DateTimeUtc,
  callId: Schema.String,
  questions: Schema.Array(Question),
  answers: Schema.optionalKey(Schema.Array(Answer))
})
export type QuestionStep = typeof QuestionStep.Type

/** Something the agent did on its own, e.g. reminding the model to submit, or retrying a request. */
export const NoteStep = Schema.Struct({
  kind: Schema.Literal("note"),
  at: DateTimeUtc,
  message: Schema.String
})
export type NoteStep = typeof NoteStep.Type

export const RunStep = Schema.Union([ModelStep, ToolStep, QuestionStep, NoteStep])
export type RunStep = typeof RunStep.Type

export const RunErrorReason = Schema.Literals([
  "missing_key", // no API key in Settings
  "invalid_key", // the provider rejected the key
  "permission", // the key can't use this model
  "rate_limited",
  "overloaded",
  "server", // the provider failed
  "network", // the provider couldn't be reached
  "bad_request", // the provider rejected the request (e.g. an unknown model)
  "refusal", // the model declined
  "max_tokens", // the model's reply was cut off
  "invalid_response", // the provider's reply couldn't be read
  "turn_limit",
  "no_submission", // the model kept stopping without submitting
  "worker", // the extension's background worker failed
  "storage", // stored data couldn't be read
  "interrupted", // the page running it closed
  "unexpected"
])
export type RunErrorReason = typeof RunErrorReason.Type

/** Why a run failed or was interrupted. `message` is written for the user. */
export const RunError = Schema.Struct({
  reason: RunErrorReason,
  message: Schema.String
})
export type RunError = typeof RunError.Type

export const RunUsage = Schema.Struct({
  ...TokenUsage.fields,
  /** Approximate cost in US dollars at list prices; absent for models we have no price for. */
  costUsd: Schema.optionalKey(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)))
})
export type RunUsage = typeof RunUsage.Type

export const Run = Schema.Struct({
  id: RunId,
  mode: Schema.Literal("api"),
  /** The model id the run used. */
  model: Schema.String,
  startedAt: DateTimeUtc,
  /** Set exactly when the run is no longer running. */
  finishedAt: Schema.optionalKey(DateTimeUtc),
  status: RunStatus,
  /** The tabs as the model last saw them (redacted). Empty until they are listed. */
  tabs: Schema.Array(TabSnapshot),
  steps: Schema.Array(RunStep),
  /** The submitted result; empty until `submit_intentions` succeeds. */
  intentions: Schema.Array(Intention),
  usage: RunUsage,
  error: Schema.optionalKey(RunError)
}).check(
  Schema.makeFilter((run) =>
    (run.status === "running") === (run.finishedAt === undefined) ||
    "finishedAt must be set exactly when the run is no longer running"
  ),
  Schema.makeFilter((run) =>
    (run.status === "failed" || run.status === "interrupted") === (run.error !== undefined) ||
    "error must be set exactly when the run failed or was interrupted"
  )
)
export type Run = typeof Run.Type

/** How many runs the extension keeps. Older ones are dropped. */
export const MAX_RUNS = 10

/**
 * One stored run in the run index: the extension keeps the runs in order, and their status, so it
 * can prune old runs and find runs left "running" without reading every run.
 */
export const RunIndexEntry = Schema.Struct({
  id: RunId,
  status: RunStatus
})
export type RunIndexEntry = typeof RunIndexEntry.Type

/**
 * Records `entry` in the index, oldest first: updates the entry with the same id in place, or
 * appends it; then keeps only the newest `max`. Returns the index it was given when nothing
 * changed, and the ids it dropped.
 */
export const upsertRunIndex = (
  index: ReadonlyArray<RunIndexEntry>,
  entry: RunIndexEntry,
  max: number = MAX_RUNS
): { readonly index: ReadonlyArray<RunIndexEntry>; readonly dropped: ReadonlyArray<RunId> } => {
  const at = index.findIndex((existing) => existing.id === entry.id)
  if (at !== -1) {
    if (index[at]?.status === entry.status) return { index, dropped: [] }
    return { index: index.map((existing, i) => (i === at ? entry : existing)), dropped: [] }
  }
  const next = [...index, entry]
  const cut = Math.max(0, next.length - max)
  return { index: next.slice(cut), dropped: next.slice(0, cut).map((dropped) => dropped.id) }
}

export const INTERRUPTED_MESSAGE = "The window running this tidy-up was closed before it finished."

/** A run whose page went away while it was running. Other runs are returned unchanged. */
export const interruptRun = (run: Run, at: DateTime.Utc): Run =>
  run.status !== "running"
    ? run
    : { ...run, status: "interrupted", finishedAt: at, error: { reason: "interrupted", message: INTERRUPTED_MESSAGE } }

/** List prices in US dollars per million tokens. Cache writes are the 5-minute TTL rate (1.25x input). */
export interface ModelPrice {
  readonly input: number
  readonly output: number
  readonly cacheWrite: number
  readonly cacheRead: number
}

/** Prices of the models API mode offers (Anthropic first-party list prices, 2026-10). */
export const MODEL_PRICES: Readonly<Record<ApiModel, ModelPrice>> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheWrite: 5, cacheRead: 0.2 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheWrite: 2.5, cacheRead: 0.2 }
}

/** Approximate cost of `usage` on `model`, or `undefined` when its price isn't known. */
export const estimateCostUsd = (model: string, usage: TokenUsage): number | undefined => {
  const price = Object.hasOwn(MODEL_PRICES, model) ? MODEL_PRICES[model as ApiModel] : undefined
  if (price === undefined) return undefined
  return (
    usage.inputTokens * price.input +
    usage.outputTokens * price.output +
    usage.cacheWriteTokens * price.cacheWrite +
    usage.cacheReadTokens * price.cacheRead
  ) / 1_000_000
}

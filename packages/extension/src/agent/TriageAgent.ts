/**
 * The API-mode triage agent (architecture A2, A4). It runs in the page that starts it (side panel
 * or full page), never in the worker, and dies with that page.
 *
 * Our own short tool loop over core's `TriageToolkit`: call the model, run the tools it asked for,
 * send the results back, until `submit_intentions` succeeds, the turn limit is hit, or the run is
 * cancelled. `list_tabs`, `read_pages` and `wake_and_read_pages` go to the worker; `ask_user` goes to
 * `Questions`; `submit_intentions` is checked with core's `checkCoverage` and a `CoverageError` goes
 * back to the model, which fixes its answer.
 *
 * Every step is written to the Store through the worker (`save_run`), so any view can mirror the
 * run. The page holds the run's Web Lock (`RunLocks`) while it goes; if the page closes, the lock
 * goes with it and the worker marks the stored run interrupted.
 *
 * Cancelling is interruption: the model request or tool call in flight is interrupted, and the run
 * is stored as cancelled. Only model requests are retried (rate limits, overload, server and
 * network errors), because a failed request changes nothing. Tool calls are never retried.
 */
import {
  addUsage,
  type Answer,
  apiKickoff,
  type BrowserError,
  checkCoverage,
  type CoverageError,
  emptyUsage,
  estimateCostUsd,
  IntentionId,
  type PageRead,
  type Run,
  type RunError,
  RunId,
  type RunStep,
  type StoreUnreadable,
  type Settings,
  SUBMIT_REMINDER,
  SYSTEM_PROMPT,
  type TabSnapshot,
  ToolError,
  type TriageHandlers,
  type TriageToolName
} from "@wherefore/core"
import {
  Cause,
  Clock,
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Result,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef
} from "effect"
import { WorkerClient, WorkerUnavailable } from "../messaging/WorkerClient.ts"
import { type RunAlreadyActive, RunLocks } from "../runs/RunLocks.ts"
import { settingsKey } from "../store/keys.ts"
import { StoreReader } from "../store/StoreReader.ts"
import { type Conversation, DEFAULT_MODEL, ModelClient, type ModelTurn } from "./ModelClient.ts"
import { type ModelError, modelError, toRunError } from "./ModelError.ts"
import { Questions, QuestionsInbox } from "./Questions.ts"

/** Model requests per run, as in the POC. */
export const DEFAULT_MAX_TURNS = 15
/** How often the model may stop without submitting before the run gives up. */
export const MAX_REMINDERS = 2
/** Retries of one model request after a retryable failure. */
export const MAX_MODEL_RETRIES = 3
/** The answer the model gets for a question the user skipped. */
export const SKIPPED_ANSWER = "(skipped - use your best guess)"

export interface StartOptions {
  /** Model requests before the run fails with `turn_limit`. */
  readonly maxTurns?: number
}

/** A run in progress, for the page that started it. */
export interface RunHandle {
  readonly id: RunId
  /** The run now, then after every step; ends with its final state. */
  readonly changes: Stream.Stream<Run>
  readonly current: Effect.Effect<Run>
  /** Stops the run (interrupting whatever is in flight) and waits until it is stored as cancelled. */
  readonly cancel: Effect.Effect<void>
  /** Waits for the run to end and returns its final state. */
  readonly await: Effect.Effect<Run>
}

/** Why a run couldn't start. A run that started and then failed is a stored run with status "failed". */
export type StartError = RunAlreadyActive | ModelError | StoreUnreadable | BrowserError

export class TriageAgent extends Context.Service<TriageAgent, {
  /** Starts a run in this page. Needs an API key in Settings, and no other run going. */
  readonly start: (options?: StartOptions) => Effect.Effect<RunHandle, StartError>
}>()("@wherefore/extension/TriageAgent") {
  static readonly layer: Layer.Layer<TriageAgent, never, WorkerClient | StoreReader | Questions | ModelClient | RunLocks> =
    Layer.effect(TriageAgent)(Effect.suspend(() => make))

  /**
   * For an extension page: Anthropic, Web Locks and an in-page Questions inbox (the UI renders
   * `QuestionsInbox.pending` and calls `answer`). The page's own `WorkerClient` and `StoreReader`
   * are shared with the rest of its UI.
   */
  static readonly layerPage: Layer.Layer<TriageAgent | QuestionsInbox, never, WorkerClient | StoreReader> = TriageAgent
    .layer.pipe(Layer.provideMerge(Layer.mergeAll(QuestionsInbox.layer, ModelClient.layer, RunLocks.layer)))
}

/** Ends a run with a stored error. */
class RunFailure extends Data.TaggedError("RunFailure")<{ readonly error: RunError }> {}

const fail = (reason: RunError["reason"], message: string) => Effect.fail(new RunFailure({ error: { reason, message } }))

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

const shorten = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

const WORKER_GONE = "The extension's background worker didn't answer. Try the call again."

/** The model hears a short reason, never a stack. */
const toToolError = (error: ToolError | WorkerUnavailable): ToolError =>
  error._tag === "ToolError" ? error : new ToolError({ message: WORKER_GONE })

const readSummary = (verb: string, pages: ReadonlyArray<PageRead>) => {
  const failed = pages.filter((page) => "error" in page).length
  return failed === 0 ? `${verb} ${plural(pages.length, "page")}` : `${verb} ${plural(pages.length, "page")} (${failed} unreadable)`
}

const coverageSummary = (error: CoverageError) =>
  [
    error.missing.length > 0 ? `${plural(error.missing.length, "tab")} missing` : "",
    error.repeated.length > 0 ? `${plural(error.repeated.length, "tab")} repeated` : "",
    error.unknown.length > 0 ? `${plural(error.unknown.length, "unknown tab")}` : ""
  ].filter((part) => part !== "").join(", ")

const make = Effect.gen(function*() {
  const worker = yield* WorkerClient
  const reader = yield* StoreReader
  const questions = yield* Questions
  const models = yield* ModelClient
  const locks = yield* RunLocks
  const pageScope = yield* Effect.scope

  const start = (options: StartOptions = {}): Effect.Effect<RunHandle, StartError> =>
    Effect.gen(function*() {
      const settings = yield* reader.get(settingsKey)
      if (settings.apiKey === undefined) return yield* modelError("missing_key")
      const id = RunId.make(crypto.randomUUID())
      // From taking the lock to forking the run, nothing may interrupt: the lock must end up owned
      // by the run fiber, which releases it.
      const { fiber, state } = yield* Effect.uninterruptible(Effect.gen(function*() {
        const runScope = yield* Scope.fork(pageScope)
        yield* locks.hold(id).pipe(
          Scope.provide(runScope),
          Effect.onError(() => Scope.close(runScope, Exit.void))
        )
        const state = yield* SubscriptionRef.make<Run>({
          id,
          mode: "api",
          model: settings.model ?? DEFAULT_MODEL,
          startedAt: yield* DateTime.now,
          status: "running",
          tabs: [],
          steps: [],
          intentions: [],
          usage: emptyUsage
        })
        const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
        const fiber = yield* runRun({ id, state, maxTurns, settings }).pipe(
          Effect.interruptible,
          // The lock is released only after the final state is stored.
          Effect.ensuring(Scope.close(runScope, Exit.void)),
          Effect.forkIn(pageScope)
        )
        return { fiber, state }
      }))
      return {
        id,
        changes: SubscriptionRef.changes(state).pipe(Stream.takeUntil((run) => run.status !== "running")),
        current: SubscriptionRef.get(state),
        cancel: Effect.asVoid(Fiber.interrupt(fiber)),
        await: Effect.andThen(Fiber.await(fiber), SubscriptionRef.get(state))
      } satisfies RunHandle
    })

  const runRun = (ctx: {
    readonly id: RunId
    readonly state: SubscriptionRef.SubscriptionRef<Run>
    readonly maxTurns: number
    readonly settings: Settings
  }) => {
    const { id, state } = ctx
    const saving = Semaphore.makeUnsafe(1)

    /** Stores the run as it is now. Idempotent, so a save that didn't reach the worker is retried once. */
    const persist = Effect.flatMap(SubscriptionRef.get(state), (run) =>
      worker.call("save_run", { run }).pipe(
        Effect.retry({ times: 1, while: (error) => error._tag === "WorkerUnavailable" }),
        Effect.catch((error) => Effect.logWarning(`Run ${id}: couldn't store a step: ${error.message}`))
      )).pipe(Semaphore.withPermit(saving))

    const update = (change: (run: Run) => Run) => Effect.andThen(SubscriptionRef.update(state, change), persist)
    const addStep = (step: RunStep) => update((run) => ({ ...run, steps: [...run.steps, step] }))
    const updateSteps = (change: (step: RunStep) => RunStep) =>
      update((run) => ({ ...run, steps: run.steps.map(change) }))

    // The model step of the current turn is recorded when its first tool call starts, so steps stay
    // in order for mirrors, and completed when the turn returns.
    let inTurn = false
    let turnStep: number | undefined
    let submitted = false

    const beginTurn = Effect.gen(function*() {
      if (!inTurn || turnStep !== undefined) return
      const at = yield* DateTime.now
      yield* update((run) => {
        turnStep = run.steps.length
        return {
          ...run,
          steps: [...run.steps, { kind: "model", at, text: "", toolCalls: [], stop: "tool_calls", usage: emptyUsage }]
        }
      })
    })

    /** Runs a tool body as a recorded step: "running", then "ok" or "error" with a summary. */
    const tracked = <A, E extends { readonly message: string }>(
      callId: string | undefined,
      tool: TriageToolName,
      running: string,
      body: Effect.Effect<A, E>,
      done: (value: A) => string,
      failed: (error: E) => string = (error) => shorten(error.message, 200)
    ): Effect.Effect<A, E> =>
      Effect.gen(function*() {
        yield* beginTurn
        const stepId = callId ?? `${tool}:${yield* Clock.currentTimeMillis}`
        yield* addStep({ kind: "tool", at: yield* DateTime.now, callId: stepId, tool, status: "running", summary: running })
        const exit = yield* Effect.exit(body)
        const finish = (status: "ok" | "error", summary: string) =>
          updateSteps((step) => (step.kind === "tool" && step.callId === stepId ? { ...step, status, summary } : step))
        if (Exit.isSuccess(exit)) yield* finish("ok", done(exit.value))
        else {
          const error = Cause.findErrorOption(exit.cause)
          if (error._tag === "Some") yield* finish("error", failed(error.value))
        }
        return yield* exit
      })

    const setTabs = (tabs: ReadonlyArray<TabSnapshot>) => update((run) => ({ ...run, tabs }))

    const handlers: TriageHandlers = {
      list_tabs: (_, { toolCallId }) =>
        tracked(
          toolCallId,
          "list_tabs",
          "Listing tabs",
          worker.call("list_tabs", {}).pipe(
            Effect.mapError(toToolError),
            Effect.tap(({ tabs }) => setTabs(tabs))
          ),
          ({ tabs }) => `Listed ${plural(tabs.length, "tab")}`
        ),
      read_pages: (params, { toolCallId }) =>
        tracked(
          toolCallId,
          "read_pages",
          `Reading ${plural(params.tabIds.length, "page")}`,
          worker.call("read_pages", params).pipe(Effect.mapError(toToolError)),
          ({ pages }) => readSummary("Read", pages)
        ),
      wake_and_read_pages: (params, { toolCallId }) =>
        tracked(
          toolCallId,
          "wake_and_read_pages",
          `Waking ${plural(params.tabIds.length, "sleeping tab")}`,
          worker.call("wake_and_read_pages", params).pipe(Effect.mapError(toToolError)),
          ({ pages }) => readSummary("Woke and read", pages)
        ),
      ask_user: ({ questions: asked }, { toolCallId }) =>
        Effect.gen(function*() {
          yield* beginTurn
          const callId = toolCallId ?? `ask_user:${yield* Clock.currentTimeMillis}`
          yield* addStep({ kind: "question", at: yield* DateTime.now, callId, questions: asked })
          const given = yield* questions.ask({ id: callId, runId: id, questions: asked }).pipe(
            Effect.mapError((error) =>
              new ToolError({ message: `The user can't answer right now (${error.message}). Use your best guess.` })
            )
          )
          const answers: ReadonlyArray<Answer> = asked.map((question) => {
            const answer = given.find((a) => a.id === question.id)?.answer.trim() ?? ""
            return { id: question.id, answer: answer === "" ? SKIPPED_ANSWER : answer }
          })
          yield* updateSteps((step) =>
            step.kind === "question" && step.callId === callId ? { ...step, answers } : step
          )
          return { answers }
        }),
      submit_intentions: ({ intentions }, { toolCallId }) =>
        tracked(
          toolCallId,
          "submit_intentions",
          `Submitting ${plural(intentions.length, "group")}`,
          Effect.gen(function*() {
            const run = yield* SubscriptionRef.get(state)
            const checked = checkCoverage(run.tabs.map((tab) => tab.id), intentions)
            if (Result.isFailure(checked)) return yield* Effect.fail(checked.failure)
            yield* update((run) => ({
              ...run,
              intentions: checked.success.map((intention, i) => ({ id: IntentionId.make(`${id}:${i}`), ...intention }))
            }))
            submitted = true
            return { message: "Saved. You're done: don't call any more tools." }
          }),
          () => `Submitted ${plural(intentions.length, "group")}`,
          (error) => (error._tag === "CoverageError" ? `Rejected: ${coverageSummary(error)}` : shorten(error.message, 200))
        )
    }

    const note = (message: string) => Effect.flatMap(DateTime.now, (at) => addStep({ kind: "note", at, message }))

    /** One model request, retried after failures that changed nothing (rate limits, overload, network). */
    const ask = (conversation: Conversation, userText: string | undefined, attempt = 0): Effect.Effect<ModelTurn, ModelError> =>
      conversation.next(userText).pipe(
        Effect.catchIf(
          (error) => error.retryable && attempt < MAX_MODEL_RETRIES,
          (error) =>
            Effect.gen(function*() {
              const delay = Math.min(60_000, Math.max(error.retryAfterMs ?? 0, 2_000 * 2 ** attempt))
              yield* note(`Retrying in ${Math.round(delay / 1000)}s: ${error.message}`)
              yield* Effect.sleep(Duration.millis(delay))
              return yield* ask(conversation, userText, attempt + 1)
            })
        )
      )

    const recordTurn = (turn: ModelTurn) =>
      Effect.gen(function*() {
        const at = yield* DateTime.now
        yield* update((run) => {
          const index = turnStep
          const existing = index === undefined ? undefined : run.steps[index]
          const step: RunStep = {
            kind: "model",
            at: existing?.at ?? at,
            text: shorten(turn.text.trim(), 500),
            toolCalls: turn.toolCalls.map((call) => call.name),
            stop: turn.stop,
            usage: turn.usage
          }
          const steps = index === undefined ? [...run.steps, step] : run.steps.map((s, i) => (i === index ? step : s))
          // A call the model got wrong never reached a handler: record it too.
          const seen = new Set(steps.flatMap((s) => (s.kind === "tool" || s.kind === "question" ? [s.callId] : [])))
          const rejected: Array<RunStep> = turn.toolCalls
            .filter((call) => call.failed && !seen.has(call.id))
            .map((call) => ({ kind: "tool", at, callId: call.id, tool: call.name, status: "error", summary: "Invalid call" }))
          const usage = addUsage(run.usage, turn.usage)
          const costUsd = estimateCostUsd(run.model, usage)
          return {
            ...run,
            steps: [...steps, ...rejected],
            usage: costUsd === undefined ? usage : { ...usage, costUsd }
          }
        })
      })

    const loop = Effect.gen(function*() {
      const listed = yield* tracked(
        undefined,
        "list_tabs",
        "Listing tabs",
        worker.call("list_tabs", {}),
        ({ tabs }) => `Listed ${plural(tabs.length, "tab")}`
      ).pipe(
        Effect.catch((error) =>
          fail("worker", error._tag === "WorkerUnavailable" ? `Couldn't list your tabs: ${WORKER_GONE}` : `Couldn't list your tabs: ${error.message}`)
        )
      )
      yield* setTabs(listed.tabs)
      const conversation = yield* models.converse({ settings: ctx.settings, system: SYSTEM_PROMPT, handlers }).pipe(
        Effect.mapError((error) => new RunFailure({ error: toRunError(error) }))
      )
      const today = new Date(yield* Clock.currentTimeMillis).toDateString()
      let userText: string | undefined = apiKickoff({ today, tabs: listed.tabs })
      let reminders = 0
      for (let turns = 0;; turns++) {
        if (turns >= ctx.maxTurns) {
          return yield* fail("turn_limit", `Stopped after ${plural(ctx.maxTurns, "model request")} without a finished result. Try again.`)
        }
        inTurn = true
        turnStep = undefined
        const turn = yield* ask(conversation, userText).pipe(
          Effect.mapError((error) => new RunFailure({ error: toRunError(error) }))
        )
        userText = undefined
        yield* recordTurn(turn)
        inTurn = false
        if (submitted) return
        if (turn.stop === "refusal") return yield* Effect.fail(new RunFailure({ error: toRunError(modelError("refusal")) }))
        if (turn.stop === "max_tokens") {
          return yield* Effect.fail(new RunFailure({ error: toRunError(modelError("max_tokens")) }))
        }
        if (turn.toolCalls.length > 0 || turn.stop === "pause") continue
        if (reminders >= MAX_REMINDERS) {
          return yield* fail("no_submission", "The model stopped without a finished result. Try again.")
        }
        reminders++
        yield* note("Reminded the model to submit")
        userText = SUBMIT_REMINDER
      }
    })

    const finish = (exit: Exit.Exit<void, RunFailure>) =>
      Effect.gen(function*() {
        const finishedAt = yield* DateTime.now
        let ending: Pick<Run, "status" | "error">
        if (Exit.isSuccess(exit)) ending = { status: "succeeded" }
        else if (Cause.hasInterruptsOnly(exit.cause)) ending = { status: "cancelled" }
        else {
          const failure = Cause.findErrorOption(exit.cause)
          if (failure._tag === "None") yield* Effect.logError(`Run ${id} died`, exit.cause)
          ending = {
            status: "failed",
            error: failure._tag === "Some"
              ? failure.value.error
              : { reason: "unexpected", message: "Something went wrong. Try again." }
          }
        }
        const stopped = ending.status === "cancelled" ? "Stopped" : "Didn't finish"
        yield* update((run) => ({
          ...run,
          ...ending,
          finishedAt,
          // A tool call cut short by the end of the run is no longer running.
          steps: run.steps.map((step) =>
            step.kind === "tool" && step.status === "running" ? { ...step, status: "error", summary: stopped } : step
          )
        }))
      }).pipe(Effect.uninterruptible)

    return Effect.andThen(persist, loop).pipe(Effect.onExit(finish))
  }

  return TriageAgent.of({ start })
})

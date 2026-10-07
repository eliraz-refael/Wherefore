/**
 * Runs the companion drives (MCP now, ACP in M2 PR C), as the worker keeps them (architecture A4).
 *
 * The run itself lives in the companion (its MCP server records the steps), but it is stored, shown
 * and answered here, in the profile whose tabs it triages:
 *
 * - **Lease.** `open` is a long-lived RPC stream (`open_run`). While it is open, the worker holds
 *   the run's Web Locks (`RunLocks`), exactly as a page holds an API-mode run's: the run is the
 *   profile's one active run (an API-mode run can't start, and another lease fails with
 *   `RunAlreadyActive` naming this run's source), and views and the interrupted-run sweep see it as
 *   alive. When the lease ends without the run having finished (its MCP client exited, the broker
 *   died, Chrome closed the native port, or the worker itself stopped), the stored run is marked
 *   interrupted before the locks are released. A worker that stopped has lost its locks, so its
 *   next start marks the run like any other.
 * - **Steps.** The owner stores the whole run after every step (`update`), like the page's
 *   `save_run`; only a run leased here can be updated.
 * - **Questions.** `ask` shows a question step in this profile's panels (they render it from the
 *   stored run) and waits in an in-worker inbox: the first answer to arrive (`answer`, from any
 *   panel) wins. It fails at once when no panel is open (Chrome doesn't let the worker open the side
 *   panel without a user gesture), and later if every panel closes before an answer.
 * - **Stop.** `stop` (the panel's Stop) stores the run as cancelled at once, withdraws its
 *   questions, and ends the lease with `Stopped`, so the owner tells its agent.
 */
import {
  type Answer,
  type AskPanelError,
  type CompanionRunMode,
  type OpenRunError,
  type Question,
  QuestionsUnavailable,
  type Run,
  RunAlreadyActive,
  type RunId,
  RunNotActive,
  type RunSignal,
  type UpdateRunError
} from "@wherefore/core"
import { type Cause, Context, Deferred, Duration, Effect, Layer, Queue, Stream, SubscriptionRef } from "effect"
import { makeInbox } from "../agent/Questions.ts"
import { Store, type StoreError } from "../background/Store.ts"
import { ChromeApi } from "../chrome/ChromeApi.ts"
import { RunLocks } from "../runs/RunLocks.ts"
import { runIndexKey, runKey } from "../store/keys.ts"

export const NO_PANEL_MESSAGE =
  "The Wherefore side panel isn't open in this Chrome profile, so the user can't see the questions."
export const PANEL_CLOSED_MESSAGE = "The Wherefore side panel was closed before the user answered."
export const STOPPED_MESSAGE = "The user stopped this tidy-up in the Wherefore side panel."
const NOT_LEASED_MESSAGE = "This tidy-up isn't running in the extension any more."

/** How often a waiting question checks that some panel is still open. */
export const VIEWS_CHECK_INTERVAL = Duration.seconds(5)

interface Lease {
  readonly id: RunId
  readonly mode: CompanionRunMode
  readonly signals: Queue.Queue<RunSignal, Cause.Done>
  /** Completes (with the reason) when the run stops being this lease's: stopped, or the lease ended. */
  readonly ended: Deferred.Deferred<string>
}

export class CompanionRuns extends Context.Service<CompanionRuns, {
  /** `open_run`: leases run `id` for the companion until the stream is interrupted (or stopped). */
  readonly open: (id: RunId, mode: CompanionRunMode) => Stream.Stream<RunSignal, OpenRunError>
  /** `update_run`: stores a leased run as it is now. */
  readonly update: (run: Run) => Effect.Effect<void, UpdateRunError>
  /** `ask_panel`: shows a leased run's questions in this profile's panels and waits for an answer. */
  readonly ask: (
    runId: RunId,
    askId: string,
    questions: ReadonlyArray<Question>
  ) => Effect.Effect<{ readonly answers: ReadonlyArray<Answer> }, AskPanelError>
  /** `answer_ask`: the first answer to an open ask wins; false otherwise. */
  readonly answer: (runId: RunId, askId: string, answers: ReadonlyArray<Answer>) => Effect.Effect<boolean>
  /** `stop_run`: the user stopped a companion run. Other runs are left alone. */
  readonly stop: (id: RunId) => Effect.Effect<void, StoreError>
  /** True while run `id` is leased by the companion. */
  readonly isLeased: (id: RunId) => boolean
}>()("@wherefore/extension/CompanionRuns") {
  static readonly layer: Layer.Layer<CompanionRuns, never, Store | RunLocks | ChromeApi> = Layer.effect(CompanionRuns)(
    Effect.suspend(() => make)
  )
}

const make = Effect.gen(function*() {
  const store = yield* Store
  const locks = yield* RunLocks
  const chrome = yield* ChromeApi
  const inbox = yield* makeInbox
  const leases = new Map<RunId, Lease>()

  /** Which run holds the profile's run lock, and what started it, for `RunAlreadyActive`. */
  const activeRun = Effect.gen(function*() {
    for (const lease of leases.values()) return new RunAlreadyActive({ runId: lease.id, source: lease.mode })
    const index = yield* store.read(runIndexKey)
    for (const entry of [...index].reverse()) {
      if (entry.status !== "running" || !(yield* locks.isLive(entry.id))) continue
      const run = yield* store.read(runKey(entry.id))
      if (run !== undefined) return new RunAlreadyActive({ runId: run.id, source: run.mode })
    }
    return new RunAlreadyActive({})
  }).pipe(Effect.catch(() => Effect.succeed(new RunAlreadyActive({}))))

  const open = (id: RunId, mode: CompanionRunMode): Stream.Stream<RunSignal, OpenRunError> =>
    Stream.unwrap(Effect.gen(function*() {
      // Released last: the run is marked interrupted (below) before anyone sees its lock free.
      yield* locks.hold(id).pipe(Effect.catchTag("RunAlreadyActive", () => Effect.flatMap(activeRun, Effect.fail)))
      const signals = yield* Queue.unbounded<RunSignal, Cause.Done>()
      const ended = yield* Deferred.make<string>()
      const lease: Lease = { id, mode, signals, ended }
      yield* Effect.acquireRelease(
        Effect.sync(() => leases.set(id, lease)),
        () =>
          Effect.gen(function*() {
            leases.delete(id)
            yield* Deferred.succeed(ended, NOT_LEASED_MESSAGE)
            // A run that is still "running" lost its agent. Only this run: the lock is still held.
            yield* store.interruptRuns((candidate) => Effect.succeed(candidate !== id)).pipe(
              Effect.catch((error) => Effect.logWarning(`CompanionRuns: couldn't mark run ${id} interrupted: ${error.message}`))
            )
          })
      )
      yield* Effect.logInfo(`CompanionRuns: ${mode} run ${id} opened`)
      yield* Queue.offer(signals, { _tag: "Opened" })
      return Stream.fromQueue(signals)
    }))

  const leased = (id: RunId) =>
    Effect.suspend(() => {
      const lease = leases.get(id)
      return lease === undefined || Deferred.isDoneUnsafe(lease.ended)
        ? Effect.fail(new RunNotActive({ runId: id, message: NOT_LEASED_MESSAGE }))
        : Effect.succeed(lease)
    })

  const update = (run: Run): Effect.Effect<void, UpdateRunError> =>
    Effect.gen(function*() {
      const lease = yield* leased(run.id)
      if (run.mode !== lease.mode) {
        return yield* new RunNotActive({ runId: run.id, message: `This run was opened as ${lease.mode}, not ${run.mode}.` })
      }
      yield* store.saveRun(run)
      // Like the page's save_run: a run whose page or agent is gone gets marked now.
      yield* store.interruptRuns(locks.isLive, run.id)
    })

  /** Fails once no view has been open for two checks in a row (a panel reloading isn't a close). */
  const whilePanelsClose = Effect.gen(function*() {
    let missed = 0
    while (true) {
      yield* Effect.sleep(VIEWS_CHECK_INTERVAL)
      const open = yield* chrome.runtime.openViews.pipe(Effect.orElseSucceed(() => 1))
      missed = open === 0 ? missed + 1 : 0
      if (missed >= 2) return yield* new QuestionsUnavailable({ message: PANEL_CLOSED_MESSAGE })
    }
  })

  const ask = (runId: RunId, askId: string, questions: ReadonlyArray<Question>) =>
    Effect.gen(function*() {
      const lease = yield* leased(runId)
      const views = yield* chrome.runtime.openViews.pipe(Effect.orElseSucceed(() => 0))
      if (views === 0) return yield* new QuestionsUnavailable({ message: NO_PANEL_MESSAGE })
      const answers = yield* inbox.questions.ask({ id: askId, runId, questions }).pipe(
        Effect.raceFirst(whilePanelsClose),
        Effect.raceFirst(Effect.flatMap(Deferred.await(lease.ended), (message) => Effect.fail(new RunNotActive({ runId, message }))))
      )
      return { answers }
    })

  const answer = (runId: RunId, askId: string, answers: ReadonlyArray<Answer>) =>
    Effect.gen(function*() {
      const pending = yield* SubscriptionRef.get(inbox.pending)
      if (!pending.some((ask) => ask.id === askId && ask.runId === runId)) return false
      return yield* inbox.answer(askId, answers)
    })

  const stop = (id: RunId) =>
    Effect.gen(function*() {
      const lease = leases.get(id)
      if (lease === undefined || Deferred.isDoneUnsafe(lease.ended)) return
      // Stored as cancelled first: the lease ending then finds nothing to interrupt.
      yield* store.cancelRun(id)
      yield* Deferred.succeed(lease.ended, STOPPED_MESSAGE)
      yield* Queue.offer(lease.signals, { _tag: "Stopped", message: STOPPED_MESSAGE })
      yield* Queue.end(lease.signals)
      yield* Effect.logInfo(`CompanionRuns: run ${id} stopped by the user`)
    })

  return CompanionRuns.of({
    open,
    update,
    ask,
    answer,
    stop,
    isLeased: (id) => leases.has(id)
  })
})

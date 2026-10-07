/**
 * Runs the companion drives (MCP, and ACP since M2 PR C), as the worker keeps them (architecture A4).
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
 * - **ACP runs** (`startAgent`, the panel's Tidy up through the companion) are the worker's own:
 *   it creates the run (`mode: "acp"`), stores it at once (so the panel shows it), holds its locks,
 *   and asks the broker to start the agent (`CompanionLink.startAgent`), following it for as long as
 *   it runs. The agent's MCP session (`wherefore mcp --run <id>`) then attaches to that run with
 *   `open_run` (`mode: "acp"`) instead of leasing a new one, and its updates are merged into it: the
 *   steps, tabs, status and result are the session's, while the start time, agent, model and usage
 *   are the worker's. The run ends when the session stores its result, when the user stops it, or
 *   when the agent fails or ends its turn without a result (stored failed, with a message that says
 *   what to do).
 * - **Steps.** The owner stores the whole run after every step (`update`), like the page's
 *   `save_run`; only a run leased (or attached) here can be updated.
 * - **Questions.** `ask` shows a question step in this profile's panels (they render it from the
 *   stored run) and waits in an in-worker inbox: the first answer to arrive (`answer`, from any
 *   panel) wins. It fails at once when no panel is open (Chrome doesn't let the worker open the side
 *   panel without a user gesture), and later if every panel closes before an answer.
 * - **Stop.** `stop` (the panel's Stop) stores the run as cancelled at once, withdraws its
 *   questions, and ends the lease with `Stopped`, so the owner tells its agent. For an ACP run it
 *   also stops following the agent, which makes the broker cancel its turn and end its process tree.
 */
import {
  type AgentEvent,
  type AgentRunError,
  type Answer,
  type AskPanelError,
  agentCommandOf,
  agentLabel,
  CLAUDE_CODE_AGENT,
  type CompanionNotConnected,
  type CompanionRunMode,
  DEFAULT_AGENT_COMMAND,
  emptyUsage,
  noSubmissionMessage,
  type OpenRunError,
  type Question,
  QuestionsUnavailable,
  type Run,
  RunAlreadyActive,
  type RunErrorReason,
  RunId,
  RunNotActive,
  type RunSignal,
  UNKNOWN_MODEL,
  type UpdateRunError
} from "@wherefore/core"
import { type Cause, Context, DateTime, Deferred, Duration, Effect, Exit, Layer, Queue, Semaphore, Stream, SubscriptionRef } from "effect"
import { makeInbox } from "../agent/Questions.ts"
import { Store, type StoreError } from "../background/Store.ts"
import { ChromeApi } from "../chrome/ChromeApi.ts"
import { RunLocks } from "../runs/RunLocks.ts"
import { runIndexKey, runKey, settingsKey } from "../store/keys.ts"
import type { StartAgent } from "./CompanionLink.ts"

export const NO_PANEL_MESSAGE =
  "The Wherefore side panel isn't open in this Chrome profile, so the user can't see the questions."
export const PANEL_CLOSED_MESSAGE = "The Wherefore side panel was closed before the user answered."
export const STOPPED_MESSAGE = "The user stopped this tidy-up in the Wherefore side panel."
const NOT_LEASED_MESSAGE = "This tidy-up isn't running in the extension any more."
export const NOT_PANEL_RUN_MESSAGE = "The side panel didn't start this tidy-up."

/** How often a waiting question checks that some panel is still open. */
export const VIEWS_CHECK_INTERVAL = Duration.seconds(5)

/** How long an ACP agent may keep going after its result is stored, before it is stopped. */
export const AFTER_RESULT_GRACE = Duration.seconds(30)

/** The first words an ACP run shows, before its agent has done anything. */
export const startingNote = (command: string) => `Starting ${agentLabel(command) === "Claude Code" ? "Claude Code" : "the agent"}…`
/** Once the agent has its prompt. */
export const workingNote = (command: string) => `${agentLabel(command)} is starting on your tabs…`

/** An ACP run the worker follows. */
interface AgentRun {
  readonly command: string
  /** The run as stored now. */
  run: Run
  readonly saving: Semaphore.Semaphore
  /** Completes to stop following the agent (Stop, or the grace after a result). */
  readonly halt: Deferred.Deferred<void>
  /** The agent's last stop reason, once it ended its turn. */
  stopReason: string | undefined
  /** Whether the MCP session has stored the run yet. */
  attachedOnce: boolean
}

interface Lease {
  readonly id: RunId
  readonly mode: CompanionRunMode
  /**
   * The owner's signals (`open_run`'s stream): an MCP lease's own, or, for an ACP run, the attached
   * MCP session's while one is attached.
   */
  signals: Queue.Queue<RunSignal, Cause.Done> | undefined
  /** Completes (with the reason) when the run stops being this lease's: stopped, or the lease ended. */
  readonly ended: Deferred.Deferred<string>
  /** Set for ACP runs. */
  readonly agent?: AgentRun
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
  /**
   * `start_agent_run`: creates and stores an ACP run with the command and preferences in Settings,
   * then has `startAgent` (the companion) run the agent for it. Returns once the run is stored.
   */
  readonly startAgent: (
    startAgent: (request: StartAgent) => Stream.Stream<AgentEvent, AgentRunError | CompanionNotConnected>
  ) => Effect.Effect<RunId, RunAlreadyActive | StoreError>
  /** True while run `id` is leased by the companion. */
  readonly isLeased: (id: RunId) => boolean
}>()("@wherefore/extension/CompanionRuns") {
  static readonly layer: Layer.Layer<CompanionRuns, never, Store | RunLocks | ChromeApi> = Layer.effect(CompanionRuns)(
    Effect.suspend(() => make)
  )
}

/** The run's reason and the user's message for a failed ACP run. */
const failureOf = (error: AgentRunError | CompanionNotConnected): { readonly reason: RunErrorReason; readonly message: string } => {
  switch (error._tag) {
    case "AgentNotFound":
      return { reason: "agent_not_found", message: error.message }
    case "AgentNotLoggedIn":
      return { reason: "agent_login", message: error.message }
    case "AgentExited":
      return { reason: "agent_crashed", message: error.message }
    case "AgentFailed":
      return { reason: "agent_failed", message: error.message }
    case "CompanionNotConnected":
      return { reason: "companion", message: error.message }
  }
}

/** An ACP run as the MCP session stores it, with the worker's own fields kept. */
const mergeAgentRun = (base: Run, incoming: Run): Run => {
  const { agent: _, ...rest } = incoming
  return {
    ...rest,
    startedAt: base.startedAt,
    model: base.model,
    ...(base.agent === undefined ? {} : { agent: base.agent }),
    usage: base.usage
  }
}

const make = Effect.gen(function*() {
  const store = yield* Store
  const locks = yield* RunLocks
  const chrome = yield* ChromeApi
  const inbox = yield* makeInbox
  const layerScope = yield* Effect.scope
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

  /**
   * Holds run `id`'s locks and registers its lease until the scope closes. When it closes with the
   * run still running, the run is marked interrupted (before the locks go).
   */
  const holdLease = (lease: Lease) =>
    Effect.gen(function*() {
      // Released last: the run is marked interrupted (below) before anyone sees its lock free.
      yield* locks.hold(lease.id).pipe(Effect.catchTag("RunAlreadyActive", () => Effect.flatMap(activeRun, Effect.fail)))
      yield* Effect.acquireRelease(
        Effect.sync(() => leases.set(lease.id, lease)),
        () =>
          Effect.gen(function*() {
            leases.delete(lease.id)
            yield* Deferred.succeed(lease.ended, NOT_LEASED_MESSAGE)
            if (lease.signals !== undefined) yield* Queue.end(lease.signals)
            // A run that is still "running" lost its agent. Only this run: the lock is still held.
            yield* store.interruptRuns((candidate) => Effect.succeed(candidate !== lease.id)).pipe(
              Effect.catch((error) => Effect.logWarning(`CompanionRuns: couldn't mark run ${lease.id} interrupted: ${error.message}`))
            )
          })
      )
    })

  /** An ACP session attaches to the run the panel started: no new locks, the worker holds them. */
  const attach = (id: RunId): Stream.Stream<RunSignal, OpenRunError> =>
    Stream.unwrap(Effect.gen(function*() {
      const lease = leases.get(id)
      if (lease?.agent === undefined) return yield* new RunNotActive({ runId: id, message: NOT_PANEL_RUN_MESSAGE })
      if (Deferred.isDoneUnsafe(lease.ended) || lease.signals !== undefined) {
        return yield* new RunNotActive({ runId: id, message: NOT_LEASED_MESSAGE })
      }
      const signals = yield* Queue.unbounded<RunSignal, Cause.Done>()
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          lease.signals = signals
        }),
        () =>
          Effect.sync(() => {
            if (lease.signals === signals) lease.signals = undefined
          })
      )
      yield* Effect.logInfo(`CompanionRuns: the agent's MCP session attached to acp run ${id}`)
      yield* Queue.offer(signals, { _tag: "Opened" })
      return Stream.fromQueue(signals)
    }))

  const open = (id: RunId, mode: CompanionRunMode): Stream.Stream<RunSignal, OpenRunError> =>
    mode === "acp" ? attach(id) : Stream.unwrap(Effect.gen(function*() {
      const signals = yield* Queue.unbounded<RunSignal, Cause.Done>()
      const lease: Lease = { id, mode, signals, ended: yield* Deferred.make<string>() }
      yield* holdLease(lease)
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

  // ---------- ACP runs ----------

  /** Changes an ACP run and stores it, one change at a time. */
  const saveAgentRun = (agent: AgentRun, change: (run: Run) => Run) =>
    Effect.gen(function*() {
      const next = change(agent.run)
      if (next === agent.run) return
      agent.run = next
      yield* store.saveRun(next)
    }).pipe(Semaphore.withPermit(agent.saving))

  /** Ends a still-running ACP run: failed (with why), or cancelled. A finished run is left alone. */
  const endAgentRun = (agent: AgentRun, ending: { readonly reason: RunErrorReason; readonly message: string } | "cancelled") =>
    Effect.flatMap(DateTime.now, (at) =>
      saveAgentRun(agent, (run) => {
        if (run.status !== "running") return run
        const steps = run.steps.map((step) =>
          step.kind === "tool" && step.status === "running" ? { ...step, status: "error" as const, summary: "Stopped" } : step
        )
        return ending === "cancelled"
          ? { ...run, status: "cancelled", finishedAt: at, steps }
          : { ...run, status: "failed", finishedAt: at, steps, error: ending }
      }))

  /** What the agent reports, into the run (and its offered settings, into Settings' store). */
  const onAgentEvent = (agent: AgentRun) => (event: AgentEvent): Effect.Effect<void, StoreError> => {
    switch (event._tag) {
      case "Started": {
        // A custom command's agent is named by what it says it is; the default one is Claude Code.
        const name = event.agent
        return agent.command === DEFAULT_AGENT_COMMAND || name === undefined
          ? Effect.void
          : saveAgentRun(agent, (run) => (run.agent === name ? run : { ...run, agent: name }))
      }
      case "Settings": {
        const model = event.settings.find((setting) => setting.category === "model")
        return Effect.andThen(
          Effect.flatMap(Effect.clockWith((clock) => clock.currentTimeMillis), (at) =>
            store.saveAgentOptions({ command: agent.command, settings: event.settings, at })),
          model === undefined || typeof model.value !== "string"
            ? Effect.void
            : saveAgentRun(agent, (run) => (run.model === model.value ? run : { ...run, model: model.value as string }))
        )
      }
      case "Working":
        return Effect.flatMap(DateTime.now, (at) =>
          saveAgentRun(agent, (run) =>
            agent.attachedOnce || run.status !== "running"
              ? run
              : { ...run, steps: [{ kind: "note", at, message: workingNote(agent.command) }] }))
      case "Usage":
        return saveAgentRun(agent, (run) => ({
          ...run,
          usage: {
            requests: run.usage.requests,
            inputTokens: event.usage.inputTokens,
            outputTokens: event.usage.outputTokens,
            cacheReadTokens: event.usage.cacheReadTokens,
            cacheWriteTokens: event.usage.cacheWriteTokens,
            ...(event.usage.costUsd === undefined ? {} : { costUsd: event.usage.costUsd })
          }
        }))
      case "Finished":
        return Effect.sync(() => {
          agent.stopReason = event.stopReason
        })
    }
  }

  const startAgent = (
    start: (request: StartAgent) => Stream.Stream<AgentEvent, AgentRunError | CompanionNotConnected>
  ): Effect.Effect<RunId, RunAlreadyActive | StoreError> =>
    Effect.gen(function*() {
      const settings = yield* store.read(settingsKey)
      const command = agentCommandOf(settings)
      const prefs = settings.agentPrefs ?? {}
      const id = RunId.make(crypto.randomUUID())
      const now = yield* DateTime.now
      const agent: AgentRun = {
        command,
        run: {
          id,
          mode: "acp",
          model: UNKNOWN_MODEL,
          ...(command === DEFAULT_AGENT_COMMAND ? { agent: CLAUDE_CODE_AGENT } : {}),
          startedAt: now,
          status: "running",
          tabs: [],
          steps: [{ kind: "note", at: now, message: startingNote(command) }],
          intentions: [],
          usage: emptyUsage
        },
        saving: Semaphore.makeUnsafe(1),
        halt: yield* Deferred.make<void>(),
        stopReason: undefined,
        attachedOnce: false
      }
      const lease: Lease = { id, mode: "acp", signals: undefined, ended: yield* Deferred.make<string>(), agent }
      const ready = yield* Deferred.make<void, RunAlreadyActive | StoreError>()

      const follow = Effect.gen(function*() {
        const started = yield* Effect.exit(Effect.andThen(holdLease(lease), store.saveRun(agent.run)))
        if (Exit.isFailure(started)) return yield* Deferred.failCause(ready, started.cause)
        // Like save_run: a run whose page or agent is gone gets marked now.
        yield* store.interruptRuns(locks.isLive, id).pipe(Effect.ignore)
        yield* Deferred.succeed(ready, undefined)
        yield* Effect.logInfo(`CompanionRuns: acp run ${id} started`)

        const outcome = yield* start({ runId: id, command, prefs }).pipe(
          Stream.runForEach(onAgentEvent(agent)),
          Effect.as("finished" as const),
          Effect.raceFirst(Effect.as(Deferred.await(agent.halt), "halted" as const)),
          Effect.exit
        )
        if (Exit.isSuccess(outcome)) {
          // Stopped by the user (already stored cancelled), or stopped after its result: nothing to add.
          if (outcome.value === "halted") return
          const stopReason = agent.stopReason ?? "end_turn"
          return yield* endAgentRun(
            agent,
            stopReason === "cancelled" ? "cancelled" : { reason: "no_submission", message: noSubmissionMessage(command, stopReason) }
          )
        }
        const error = outcome.cause.reasons.find((reason) => reason._tag === "Fail")?.error
        if (error === undefined) return yield* Effect.failCause(outcome.cause)
        yield* Effect.logWarning(`CompanionRuns: acp run ${id} failed (${error._tag})`)
        if (error._tag === "StoreUnreadable" || error._tag === "BrowserError") {
          return yield* endAgentRun(agent, { reason: "storage", message: "The tidy-up couldn't be saved in this browser." })
        }
        yield* endAgentRun(agent, failureOf(error))
      }).pipe(
        Effect.scoped,
        // The worker is stopping (or a defect): the lease's end marks the run interrupted.
        Effect.catchCause((cause) =>
          Effect.andThen(
            Deferred.isDoneUnsafe(ready) ? Effect.void : Deferred.interrupt(ready),
            Effect.logWarning(`CompanionRuns: stopped following acp run ${id}${cause.reasons.some((reason) => reason._tag === "Die") ? " (defect)" : ""}`)
          )
        )
      )
      yield* Effect.forkIn(follow, layerScope)
      yield* Deferred.await(ready)
      return id
    })

  // ---------- updates, questions, stop ----------

  const update = (run: Run): Effect.Effect<void, UpdateRunError> =>
    Effect.gen(function*() {
      const lease = yield* leased(run.id)
      if (run.mode !== lease.mode) {
        return yield* new RunNotActive({ runId: run.id, message: `This run was opened as ${lease.mode}, not ${run.mode}.` })
      }
      const agent = lease.agent
      if (agent === undefined) {
        yield* store.saveRun(run)
      } else {
        agent.attachedOnce = true
        let ended = false
        // A late update can't reopen a run that already ended (failed, stopped, or done).
        yield* saveAgentRun(agent, (current) => {
          if (current.status !== "running") return current
          const next = mergeAgentRun(current, run)
          ended = next.status !== "running"
          return next
        })
        // The result is in (this update ended the run): the agent gets a moment to end its turn, then it is stopped.
        if (ended) {
          yield* Effect.forkIn(
            Effect.andThen(Effect.sleep(AFTER_RESULT_GRACE), Deferred.succeed(agent.halt, undefined)),
            layerScope
          )
        }
      }
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
      if (lease.agent === undefined) yield* store.cancelRun(id)
      else yield* endAgentRun(lease.agent, "cancelled")
      yield* Deferred.succeed(lease.ended, STOPPED_MESSAGE)
      if (lease.signals !== undefined) {
        yield* Queue.offer(lease.signals, { _tag: "Stopped", message: STOPPED_MESSAGE })
        yield* Queue.end(lease.signals)
      }
      // An ACP run: stop following the agent, which stops it (the broker ends its process tree).
      if (lease.agent !== undefined) yield* Deferred.succeed(lease.agent.halt, undefined)
      yield* Effect.logInfo(`CompanionRuns: run ${id} stopped by the user`)
    })

  return CompanionRuns.of({
    open,
    update,
    ask,
    answer,
    stop,
    startAgent,
    isLeased: (id) => leases.has(id)
  })
})

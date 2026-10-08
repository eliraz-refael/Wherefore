/**
 * One MCP session's triage (architecture A2, A4): the five tools as an MCP client calls them, over
 * the brokers of the connected Chrome profiles, recorded as runs in those profiles.
 *
 * - **Ids.** The model sees session ids (ids.ts); everything sent to a profile uses its real ids.
 * - **ACP mode** (`--run`, M2 PR C): the session's runs are `acp`, and the first triage's run is
 *   the one the side panel created; `open_run` attaches to it in the worker instead of opening a
 *   new one. A later triage in the same session is refused by the worker (`RunNotActive`): an ACP
 *   agent gets one tidy-up.
 * - **A triage** starts with the first tool call and ends when `submit_intentions` passes the
 *   coverage check, when the user stops it in a panel, or when the session ends. It records one run
 *   per profile it touches (`mode: "mcp"`), stored in that profile's Store by its worker: the run is
 *   leased (`open_run`) when the profile first takes part, and stored whole after every step
 *   (`update_run`), like an API-mode run. A profile listed for the first time mid-triage joins it.
 * - **Profiles are each on their own.** A profile that can't take part (another tidy-up runs there,
 *   or its broker doesn't open the run within `OPEN_RUN_TIMEOUT`) is left out of the call, and the
 *   model is told which and why; a call fails only when no profile it needs could take part.
 * - **Coverage** is checked against every tab the triage's runs listed. A profile that disconnects
 *   leaves the triage; its tabs drop out of the check, and its run is marked interrupted by its
 *   worker (or that worker's next start).
 * - **Questions** go to the panels of the profile that owns the question's first tab.
 * - **Stop** in any profile's panel stops the whole triage: a call in flight tells the model, or, if
 *   none does (none was in flight, or each ended another way), the next call does.
 */
import {
  type Answer,
  type CompanionRunMode,
  checkCoverage,
  type CoverageError,
  cancelRun,
  emptyUsage,
  type Intention,
  IntentionId,
  localDay,
  type PageRead,
  type ProfileId,
  type Question,
  type QuestionId,
  type Run,
  RunId,
  type RunMode,
  type RunStep,
  STOPPED_STEP,
  type SubmittedIntention,
  type TabId,
  type TabSnapshot,
  ToolError,
  UNKNOWN_MODEL
} from "@wherefore/core"
import { randomUUID } from "node:crypto"
import { Cause, Clock, DateTime, Deferred, Duration, Effect, Exit, type Option, Result, Scope, Semaphore, Stream } from "effect"
import type { Broker, Brokers } from "./Brokers.ts"
import { SessionIds } from "./ids.ts"

/** How long a profile's broker has to open a run (`open_run`'s `Opened`) before the profile is skipped. */
export const OPEN_RUN_TIMEOUT = Duration.seconds(10)

// ---------- what the model hears ----------

export const NO_BROKERS =
  "Open Chrome with Wherefore: no Chrome profile with the Wherefore extension is connected to the companion right now. If Chrome is open, the side panel's Settings → Companion says why."
export const NO_SCOPED_BROKER =
  "Open Chrome with Wherefore: the Chrome profile this session is for isn't connected to the companion right now."
export const PROFILE_GONE = "This tab's Chrome profile disconnected (Chrome closed, or the extension reloaded)."
export const NOT_ANSWERING = `This Chrome profile's Wherefore extension didn't answer within ${
  Duration.toSeconds(OPEN_RUN_TIMEOUT)
} seconds, so it couldn't start a tidy-up there.`
export const UNKNOWN_TAB = "Unknown tab id: call list_tabs first."
export const NEED_LIST = "Call list_tabs first: this tidy-up has no tab list to check the intentions against."
export const ASK_ELSEWHERE =
  "Ask the user in this conversation instead, or ask them to open the Wherefore side panel (the toolbar icon) and call ask_user again."
export const SKIPPED_ANSWER = "(skipped - use your best guess)"
export const STOP_GUIDANCE = "Stop working on the tabs; don't call Wherefore's tools again unless the user asks."

const SOURCES: Readonly<Record<RunMode, string>> = {
  api: "from the Wherefore side panel",
  mcp: "by another agent",
  acp: "by an agent the side panel started"
}

export const runActiveMessage = (source: RunMode | undefined) =>
  `Another tidy-up is already running in this Chrome profile${source === undefined ? "" : ` (started ${SOURCES[source]})`}. Wait for it to finish, or stop it in the Wherefore side panel, then try again.`

/** list_tabs' `notice`: the profiles left out, and why. */
export const skippedNotice = (skipped: ReadonlyMap<ProfileId, string>) =>
  [...skipped].map(([profile, why]) => `The tabs of Chrome profile ${profile} aren't listed: ${why}`).join(" ")

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`
const shorten = (text: string, max: number) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`)

/** Who is calling, from the MCP request. */
export interface CallContext {
  readonly agent: string | undefined
}

export interface SessionOptions {
  readonly brokers: Brokers
  /** `mcp` (an MCP client), or `acp` (an agent the side panel started, M2 PR C). */
  readonly mode?: CompanionRunMode
  /** The first triage's run id (PR C: the run the panel started). Later triages get new ids. */
  readonly firstRunId?: RunId
}

export interface Session {
  readonly listTabs: (
    ctx: CallContext
  ) => Effect.Effect<{ readonly tabs: ReadonlyArray<TabSnapshot>; readonly today: string; readonly notice?: string }, ToolError>
  readonly readPages: (
    params: { readonly tabIds: ReadonlyArray<TabId>; readonly maxChars?: number },
    wake: boolean,
    ctx: CallContext
  ) => Effect.Effect<{ readonly pages: ReadonlyArray<PageRead> }, ToolError>
  readonly askUser: (
    params: { readonly questions: ReadonlyArray<Question> },
    ctx: CallContext
  ) => Effect.Effect<{ readonly answers: ReadonlyArray<Answer> }, ToolError>
  readonly submitIntentions: (
    params: { readonly intentions: ReadonlyArray<SubmittedIntention> },
    ctx: CallContext
  ) => Effect.Effect<{ readonly message: string }, CoverageError | ToolError>
}

/** One profile's part of a triage: its run (with real ids) and the lease that keeps it. */
interface ProfileRun {
  readonly profile: ProfileId
  readonly broker: Broker
  run: Run
  readonly saving: Semaphore.Semaphore
  readonly lease: Scope.Closeable
}

interface Triage {
  readonly runs: Map<ProfileId, ProfileRun>
  /** Runs being opened: a second call for the same profile waits for the same `open_run`. */
  readonly opening: Map<ProfileId, Deferred.Deferred<ProfileRun, string>>
  /** Profiles that disconnected mid-triage: their tabs drop out of the coverage check. */
  readonly gone: Set<ProfileId>
  /** Completes with the model's message when the user stops the triage. */
  readonly stopped: Deferred.Deferred<string>
  /** The stop's message, once stopped. */
  stopMessage: string | undefined
  /** Tool calls counted in this triage that haven't ended yet. */
  inFlight: number
  /** A call has told the model about the stop. */
  heard: boolean
}

const newTriage = (): Triage => ({
  runs: new Map(),
  opening: new Map(),
  gone: new Set(),
  stopped: Deferred.makeUnsafe(),
  stopMessage: undefined,
  inFlight: 0,
  heard: false
})

/** A broker call failed because the profile is gone (as opposed to a failure to report). */
const isGone = (error: { readonly _tag: string }) => error._tag === "ExtensionUnavailable" || error._tag === "BrokerUnreachable"

export const makeSession = (options: SessionOptions): Effect.Effect<Session, never, Scope.Scope> =>
  Effect.gen(function*() {
    const sessionScope = yield* Effect.scope
    const brokers = options.brokers
    const mode: CompanionRunMode = options.mode ?? "mcp"
    const ids = new SessionIds()
    const lock = Semaphore.makeUnsafe(1)
    let triage: Triage | undefined
    /** The last stopped triage, until a call has told the model about its stop. */
    let unheard: Triage | undefined
    let firstRunId = options.firstRunId
    let nextAsk = 1
    let nextStep = 1

    const newRunId = () => {
      const id = firstRunId ?? RunId.make(randomUUID())
      firstRunId = undefined
      return id
    }

    // ---------- storing a profile's run ----------

    /** Changes the run and stores it. Failures are logged: a gone profile is noticed by its lease. */
    const save = (part: ProfileRun, change: (run: Run) => Run) =>
      Effect.gen(function*() {
        part.run = change(part.run)
        return yield* part.broker.client.call("update_run", { run: part.run }).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            (error._tag === "RunNotActive"
              ? Effect.void
              : Effect.logWarning(`mcp: couldn't store run ${part.run.id}: ${error._tag}`)).pipe(Effect.as(false))
          )
        )
      }).pipe(Semaphore.withPermit(part.saving), Effect.uninterruptible)

    const addStep = (part: ProfileRun, step: RunStep) => save(part, (run) => ({ ...run, steps: [...run.steps, step] }))

    /** Runs `body` as a tool step of `part`'s run: "running", then "ok" or "error" with a summary. */
    const tracked = <A, E extends { readonly _tag: string }>(
      part: ProfileRun,
      tool: string,
      running: string,
      body: Effect.Effect<A, E>,
      done: (value: A) => string,
      failed: (error: E) => string
    ): Effect.Effect<A, E> =>
      Effect.gen(function*() {
        const callId = `${tool}:${nextStep++}`
        yield* addStep(part, { kind: "tool", at: yield* DateTime.now, callId, tool, status: "running", summary: running })
        const finish = (status: "ok" | "error", summary: string) =>
          save(part, (run) => ({
            ...run,
            steps: run.steps.map((step) => (step.kind === "tool" && step.callId === callId ? { ...step, status, summary } : step))
          }))
        // Also when the call is cancelled (the client's notifications/cancelled): the step reads "Stopped".
        return yield* body.pipe(Effect.onExit((exit) => {
          if (Exit.isSuccess(exit)) return finish("ok", done(exit.value))
          const error = Cause.findErrorOption(exit.cause)
          return finish("error", error._tag === "Some" ? failed(error.value) : STOPPED_STEP)
        }))
      })

    // ---------- the triage ----------

    /** Ends the triage the user stopped: the others' runs are stored cancelled, every lease closes. */
    const stopTriage = (stopped: Triage, message: string) =>
      Effect.gen(function*() {
        if (triage !== stopped) return
        triage = undefined
        const said = `${message} ${STOP_GUIDANCE}`
        // Told by a call in flight, or else by the next call (inTriage).
        stopped.stopMessage = said
        unheard = stopped
        yield* Deferred.succeed(stopped.stopped, said)
        const now = yield* DateTime.now
        for (const part of stopped.runs.values()) {
          if (part.run.status === "running") yield* save(part, (run) => cancelRun(run, now))
          yield* Scope.close(part.lease, Exit.void)
        }
        yield* Effect.logInfo("mcp: the user stopped the tidy-up")
      }).pipe(Semaphore.withPermit(lock))

    /** A profile disconnected: it leaves the triage (its worker marks its run interrupted). */
    const leave = (current: Triage, part: ProfileRun) =>
      Effect.gen(function*() {
        if (current.runs.get(part.profile) !== part) return
        current.runs.delete(part.profile)
        current.gone.add(part.profile)
        yield* brokers.forget(part.broker)
        yield* Scope.close(part.lease, Exit.void)
        if (triage === current && current.runs.size === 0) triage = undefined
        yield* Effect.logWarning(`mcp: profile ${part.profile} disconnected during a tidy-up`)
      }).pipe(Semaphore.withPermit(lock))

    /** Leases a run in `broker`'s profile. Fails with the model's message when it can't. */
    const openRun = (current: Triage, broker: Broker, ctx: CallContext) =>
      Effect.gen(function*() {
        const id = newRunId()
        const lease = yield* Scope.fork(sessionScope)
        const opened = yield* Deferred.make<void, string>()
        const part: ProfileRun = {
          profile: broker.profileId,
          broker,
          saving: Semaphore.makeUnsafe(1),
          lease,
          run: {
            id,
            mode,
            model: UNKNOWN_MODEL,
            ...(ctx.agent === undefined ? {} : { agent: ctx.agent }),
            startedAt: yield* DateTime.now,
            status: "running",
            tabs: [],
            steps: [],
            intentions: [],
            usage: emptyUsage
          }
        }
        yield* broker.client.openRun({ id, mode }).pipe(
          Stream.runForEach((signal): Effect.Effect<void> =>
            signal._tag === "Opened"
              ? Effect.asVoid(Deferred.succeed(opened, undefined))
              : Effect.asVoid(Effect.forkDetach(stopTriage(current, signal.message)))
          ),
          Effect.onExit((exit): Effect.Effect<void> => {
            if (!Deferred.isDoneUnsafe(opened)) {
              const error: Option.Option<{ readonly _tag: string; readonly source?: RunMode; readonly message?: string }> | undefined =
                Exit.isFailure(exit)
                  ? Cause.findErrorOption(exit.cause)
                  : undefined
              const message = error?._tag === "Some"
                ? error.value._tag === "RunAlreadyActive"
                  ? runActiveMessage(error.value.source)
                  : error.value._tag === "RunNotActive"
                  // ACP mode: the run the panel started is over (stopped, failed) or isn't this profile's.
                  ? `${error.value.message ?? "This tidy-up isn't running in the extension any more."} ${STOP_GUIDANCE}`
                  : isGone(error.value)
                  ? PROFILE_GONE
                  : `Wherefore couldn't start a tidy-up in this Chrome profile (${error.value._tag}).`
                : PROFILE_GONE
              return Effect.asVoid(Deferred.fail(opened, message))
            }
            // Ended by us (interrupted), or by a stop (completed): nothing to do. Failed: the profile is gone.
            return Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
              ? Effect.asVoid(Effect.forkDetach(leave(current, part)))
              : Effect.void
          }),
          Effect.forkIn(lease)
        )
        // A broker that takes the lease and never answers costs the call OPEN_RUN_TIMEOUT, no more.
        yield* Deferred.await(opened).pipe(
          Effect.timeoutOrElse({ duration: OPEN_RUN_TIMEOUT, orElse: () => Effect.fail(NOT_ANSWERING) }),
          Effect.mapError((message) => new ToolError({ message })),
          Effect.onError(() => Scope.close(lease, Exit.void))
        )
        yield* Effect.logInfo(`mcp: run ${id} opened in profile ${broker.profileId}`)
        return part
      })

    /**
     * The stop of a stopped triage no call has told the model about, once no call of that triage is
     * still in flight (one of those may still tell it). Taking it marks it told.
     */
    const takeUnheardStop = (): string | undefined => {
      if (unheard === undefined) return undefined
      if (unheard.heard || unheard.stopMessage === undefined) {
        unheard = undefined
        return undefined
      }
      if (unheard.inFlight > 0) return undefined
      const said = unheard.stopMessage
      unheard.heard = true
      unheard = undefined
      return said
    }

    /** A call counted in `current` ended; `heard` when it ended with the stop's message. */
    const endCall = (current: Triage, heard: boolean) => {
      current.inFlight--
      if (heard) current.heard = true
      if (triage === current && current.inFlight === 0 && current.runs.size === 0 && current.opening.size === 0) {
        triage = undefined
      }
    }

    /** A run `enter` opened takes part in `current`, unless the triage ended meanwhile. */
    const adopt = (current: Triage, part: ProfileRun) =>
      Effect.gen(function*() {
        if (triage !== current) {
          yield* Scope.close(part.lease, Exit.void)
          return yield* Effect.fail(current.stopMessage ?? PROFILE_GONE)
        }
        current.runs.set(part.profile, part)
        return part
      }).pipe(Semaphore.withPermit(lock))

    /**
     * A call starts: counted in the current triage (started now if there is none), and a run is
     * being opened in each of `involved` that has none. A stop nobody heard yet fails it instead.
     */
    const enter = (involved: ReadonlyArray<Broker>, ctx: CallContext) =>
      Effect.gen(function*() {
        const said = takeUnheardStop()
        if (said !== undefined) return yield* new ToolError({ message: said })
        const current = triage ?? newTriage()
        triage = current
        current.inFlight++
        const waits: Array<{ readonly profile: ProfileId; readonly run: Deferred.Deferred<ProfileRun, string> }> = []
        for (const broker of involved) {
          if (current.runs.has(broker.profileId)) continue
          let run = current.opening.get(broker.profileId)
          if (run === undefined) {
            const pending = Deferred.makeUnsafe<ProfileRun, string>()
            run = pending
            current.opening.set(broker.profileId, pending)
            // In the session's scope, so it settles for every waiter even if this call is cancelled.
            yield* openRun(current, broker, ctx).pipe(
              Effect.mapError((error) => error.message),
              Effect.flatMap((part) => adopt(current, part)),
              Effect.exit,
              Effect.flatMap((exit) =>
                Effect.andThen(Effect.sync(() => current.opening.delete(broker.profileId)), Deferred.done(pending, exit))
              ),
              Effect.forkIn(sessionScope)
            )
          }
          waits.push({ profile: broker.profileId, run })
        }
        return { current, waits }
      }).pipe(Semaphore.withPermit(lock))

    /**
     * Runs a tool call in the triage, with a run in each of `involved`. Profiles are each on their
     * own: one that can't take part is left out (`skipped`, with the model's message), and the call
     * fails only when none of `involved` takes part. A stop meanwhile ends the call with the stop's
     * message.
     *
     * The session lock is held only to change state, never while a broker answers. A call is
     * counted from `enter` until it ends, and it ends in one step with its outcome, so a stop it
     * didn't tell the model (it ended first, or was cancelled) is left for the next call, never lost.
     */
    const inTriage = <A, E>(
      involved: ReadonlyArray<Broker>,
      ctx: CallContext,
      body: (current: Triage, skipped: ReadonlyMap<ProfileId, string>) => Effect.Effect<A, E>
    ): Effect.Effect<A, E | ToolError> =>
      Effect.uninterruptibleMask((restore) =>
        Effect.flatMap(enter(involved, ctx), ({ current, waits }) => {
          let stop: ToolError | undefined
          const call = Effect.gen(function*() {
            const skipped = new Map<ProfileId, string>()
            for (const { profile, run } of waits) {
              const result = yield* Effect.result(Deferred.await(run))
              if (Result.isFailure(result)) skipped.set(profile, result.failure)
            }
            if (involved.length > 0 && involved.every((broker) => !current.runs.has(broker.profileId))) {
              return yield* new ToolError({ message: skipped.values().next().value ?? PROFILE_GONE })
            }
            return yield* body(current, skipped)
          })
          return restore(
            call.pipe(
              Effect.raceFirst(Effect.flatMap(Deferred.await(current.stopped), (message) => Effect.fail(stop = new ToolError({ message }))))
            )
          ).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                const error = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined
                endCall(current, stop !== undefined && error?._tag === "Some" && error.value === stop)
              })
            )
          )
        })
      )

    const liveBrokers = Effect.gen(function*() {
      const found = yield* brokers.current
      if (found.length === 0) return yield* new ToolError({ message: brokers.profile === undefined ? NO_BROKERS : NO_SCOPED_BROKER })
      return found
    })

    // ---------- list_tabs ----------

    const listTabs = (ctx: CallContext) =>
      Effect.gen(function*() {
        const found = yield* liveBrokers
        return yield* inTriage(found, ctx, (current, skipped) =>
          Effect.gen(function*() {
            const parts = found.flatMap((broker) => {
              const part = current.runs.get(broker.profileId)
              return part === undefined ? [] : [part]
            })
            const listed = yield* Effect.forEach(parts, (part) =>
              tracked(
                part,
                "list_tabs",
                "Listing tabs",
                part.broker.client.call("list_tabs", {}),
                ({ tabs }) => `Listed ${plural(tabs.length, "tab")}`,
                (error) => (isGone(error) ? "Chrome profile disconnected" : shorten(error.message, 200))
              ).pipe(Effect.result, Effect.map((result) => ({ part, result }))), { concurrency: "unbounded" })
            const tabs: Array<TabSnapshot> = []
            // Each profile's worker reports the user's local day; they share one machine and one day.
            let today: string | undefined
            for (const { part, result } of listed) {
              if (Result.isFailure(result)) {
                if (isGone(result.failure)) {
                  yield* leave(current, part)
                  continue
                }
                return yield* new ToolError({ message: result.failure.message })
              }
              yield* save(part, (run) => ({ ...run, tabs: result.success.tabs }))
              // A profile that disconnected and came back takes part again once its tabs are listed
              // (until then its new run knows no tabs, so its old tab ids stay out of the check).
              current.gone.delete(part.profile)
              for (const tab of result.success.tabs) tabs.push(ids.snapshot(part.profile, tab))
              today ??= result.success.today
            }
            if (current.runs.size === 0) return yield* new ToolError({ message: NO_BROKERS })
            // No profile listed (every one left meanwhile): this machine's day is the user's too.
            const day = today ?? localDay(yield* Clock.currentTimeMillis)
            return skipped.size === 0 ? { tabs, today: day } : { tabs, today: day, notice: skippedNotice(skipped) }
          })
        )
      })

    // ---------- read_pages, wake_and_read_pages ----------

    /** Session tab ids grouped by the profile behind them; ids that name no known tab answer on their own. */
    const resolveTabs = (tabIds: ReadonlyArray<TabId>, found: ReadonlyArray<Broker>) => {
      const byProfile = new Map<ProfileId, { readonly broker: Broker; readonly tabs: Array<{ readonly session: TabId; readonly real: TabId }> }>()
      const answered = new Map<number, PageRead>()
      for (const session of tabIds) {
        const real = ids.realTab(session)
        if (real === undefined) {
          answered.set(session, { id: session, error: UNKNOWN_TAB })
          continue
        }
        const broker = found.find((candidate) => candidate.profileId === real.profile)
        if (broker === undefined) {
          answered.set(session, { id: session, error: PROFILE_GONE })
          continue
        }
        const group = byProfile.get(real.profile) ?? { broker, tabs: [] }
        group.tabs.push({ session, real: real.id })
        byProfile.set(real.profile, group)
      }
      return { byProfile, answered }
    }

    const readPages = (
      params: { readonly tabIds: ReadonlyArray<TabId>; readonly maxChars?: number },
      wake: boolean,
      ctx: CallContext
    ) =>
      Effect.gen(function*() {
        const found = yield* liveBrokers
        const { byProfile, answered } = resolveTabs(params.tabIds, found)
        return yield* inTriage([...byProfile.values()].map((group) => group.broker), ctx, (current, skipped) =>
          Effect.gen(function*() {
            const tool = wake ? "wake_and_read_pages" : "read_pages"
            yield* Effect.forEach([...byProfile], ([profile, group]) =>
              Effect.gen(function*() {
                const part = current.runs.get(profile)
                const fail = (error: string) => {
                  for (const { session } of group.tabs) answered.set(session, { id: session, error })
                }
                if (part === undefined) return fail(skipped.get(profile) ?? PROFILE_GONE)
                const n = group.tabs.length
                const result = yield* tracked(
                  part,
                  tool,
                  wake ? `Waking ${plural(n, "sleeping tab")}` : `Reading ${plural(n, "page")}`,
                  (() => {
                    const payload = {
                      tabIds: group.tabs.map((tab) => tab.real),
                      ...(params.maxChars === undefined ? {} : { maxChars: params.maxChars })
                    }
                    return wake
                      ? part.broker.client.call("wake_and_read_pages", payload)
                      : part.broker.client.call("read_pages", payload)
                  })(),
                  ({ pages }) => {
                    const unreadable = pages.filter((page) => "error" in page).length
                    const verb = wake ? "Woke and read" : "Read"
                    return `${verb} ${plural(pages.length, "page")}${unreadable === 0 ? "" : ` (${unreadable} unreadable)`}`
                  },
                  (error) => (isGone(error) ? "Chrome profile disconnected" : shorten(error.message, 200))
                ).pipe(Effect.result)
                if (Result.isFailure(result)) {
                  if (isGone(result.failure)) yield* leave(current, part)
                  return fail(isGone(result.failure) ? PROFILE_GONE : result.failure.message)
                }
                for (const page of result.success.pages) {
                  const session = ids.tab(profile, page.id)
                  answered.set(session, { ...page, id: session })
                }
              }), { concurrency: "unbounded", discard: true })
            const pages = params.tabIds.flatMap((id) => {
              const page = answered.get(id)
              return page === undefined ? [] : [page]
            })
            return { pages }
          })
        )
      })

    // ---------- ask_user ----------

    const askUser = (params: { readonly questions: ReadonlyArray<Question> }, ctx: CallContext) =>
      Effect.gen(function*() {
        const found = yield* liveBrokers
        // A question goes to the profile of its first known tab, naming that profile's tabs only.
        const groups = new Map<ProfileId, { readonly broker: Broker; readonly questions: Array<Question> }>()
        const answers = new Map<QuestionId, string>()
        for (const question of params.questions) {
          const reals = question.tabIds.flatMap((id) => {
            const real = ids.realTab(id)
            return real === undefined ? [] : [real]
          })
          const profile = reals[0]?.profile
          const broker = found.find((candidate) => candidate.profileId === profile)
          if (profile === undefined || broker === undefined) {
            answers.set(question.id, profile === undefined ? `(not asked: ${UNKNOWN_TAB})` : `(not asked: ${PROFILE_GONE})`)
            continue
          }
          const own = reals.filter((real) => real.profile === profile).map((real) => real.id)
          const group = groups.get(profile) ?? { broker, questions: [] }
          group.questions.push({ ...question, tabIds: own as [TabId, ...Array<TabId>] })
          groups.set(profile, group)
        }
        if (groups.size === 0) return yield* new ToolError({ message: `None of these questions names a tab from list_tabs. ${UNKNOWN_TAB}` })
        return yield* inTriage([...groups.values()].map((group) => group.broker), ctx, (current, skipped) =>
          Effect.gen(function*() {
            const unavailable: Array<string> = []
            yield* Effect.forEach([...groups], ([profile, group]) =>
              Effect.gen(function*() {
                const part = current.runs.get(profile)
                const notAsked = (message: string) => {
                  unavailable.push(message)
                  for (const question of group.questions) answers.set(question.id, `(not answered: ${message})`)
                }
                if (part === undefined) return notAsked(skipped.get(profile) ?? PROFILE_GONE)
                const askId = `ask-${nextAsk++}`
                const withdraw = (message: string) =>
                  Effect.flatMap(DateTime.now, (at) =>
                    save(part, (run) => ({
                      ...run,
                      steps: run.steps.map((step): RunStep =>
                        step.kind === "question" && step.callId === askId ? { kind: "note", at, message } : step
                      )
                    })))
                yield* addStep(part, { kind: "question", at: yield* DateTime.now, callId: askId, questions: group.questions })
                const result = yield* part.broker.client.call("ask_panel", { runId: part.run.id, askId, questions: group.questions }).pipe(
                  Effect.onInterrupt(() => withdraw("The agent withdrew its questions.")),
                  Effect.result
                )
                if (Result.isFailure(result)) {
                  const error = result.failure
                  if (error._tag === "RunNotActive") return yield* new ToolError({ message: `${error.message} ${STOP_GUIDANCE}` })
                  const message = error._tag === "QuestionsUnavailable" ? error.message : isGone(error) ? PROFILE_GONE : error._tag
                  yield* withdraw(`Couldn't show the questions: ${message}`)
                  if (isGone(error)) yield* leave(current, part)
                  return notAsked(message)
                }
                const given: ReadonlyArray<Answer> = group.questions.map((question) => {
                  const answer = result.success.answers.find((a) => a.id === question.id)?.answer.trim() ?? ""
                  return { id: question.id, answer: answer === "" ? SKIPPED_ANSWER : answer }
                })
                for (const answer of given) answers.set(answer.id, answer.answer)
                yield* save(part, (run) => ({
                  ...run,
                  steps: run.steps.map((step) => (step.kind === "question" && step.callId === askId ? { ...step, answers: given } : step))
                }))
              }), { concurrency: "unbounded", discard: true })
            if (unavailable.length === groups.size) {
              return yield* new ToolError({ message: `${unavailable[0]} ${ASK_ELSEWHERE}` })
            }
            return { answers: params.questions.map((question) => ({ id: question.id, answer: answers.get(question.id) ?? SKIPPED_ANSWER })) }
          })
        )
      })

    // ---------- submit_intentions ----------

    const submitIntentions = (params: { readonly intentions: ReadonlyArray<SubmittedIntention> }, ctx: CallContext) =>
      Effect.gen(function*() {
        if (unheard === undefined && (triage === undefined || triage.runs.size === 0)) return yield* new ToolError({ message: NEED_LIST })
        return yield* inTriage([], ctx, (current) =>
          Effect.gen(function*() {
            const parts = [...current.runs.values()]
            const known = parts.flatMap((part) => part.run.tabs.map((tab) => ids.tab(part.profile, tab.id)))
            if (known.length === 0) return yield* new ToolError({ message: NEED_LIST })
            // Tabs of a profile that disconnected can't be saved: they drop out on both sides.
            const kept = params.intentions
              .map((intention) => ({
                ...intention,
                tabIds: intention.tabIds.filter((id) => {
                  const real = ids.realTab(id)
                  return real === undefined || !current.gone.has(real.profile)
                })
              }))
              .filter((intention) => intention.tabIds.length > 0)
            const checked = checkCoverage(known, kept)
            const count = plural(params.intentions.length, "group")
            if (Result.isFailure(checked)) {
              const error = checked.failure
              yield* Effect.forEach(parts, (part) =>
                tracked(part, "submit_intentions", `Submitting ${count}`, Effect.fail(error), () => "", () => {
                  const problems = [
                    error.missing.length > 0 ? `${plural(error.missing.length, "tab")} missing` : "",
                    error.repeated.length > 0 ? `${plural(error.repeated.length, "tab")} repeated` : "",
                    error.unknown.length > 0 ? plural(error.unknown.length, "unknown tab") : ""
                  ].filter((part) => part !== "")
                  return `Rejected: ${problems.join(", ")}`
                }).pipe(Effect.ignore), { discard: true })
              return yield* Effect.fail(error)
            }
            const finishedAt = yield* DateTime.now
            const saved = yield* Effect.forEach(parts, (part) =>
              Effect.gen(function*() {
                const own = checked.success.flatMap((intention) => {
                  const tabIds = intention.tabIds.flatMap((id) => {
                    const real = ids.realTab(id)
                    return real !== undefined && real.profile === part.profile ? [real.id] : []
                  })
                  return tabIds.length === 0 ? [] : [{ ...intention, tabIds: tabIds as [TabId, ...Array<TabId>] }]
                })
                const intentions = own.map((intention, i): Intention => ({ id: IntentionId.make(`${part.run.id}:${i}`), ...intention }))
                const at = yield* DateTime.now
                const ok = yield* save(part, (run) => ({
                  ...run,
                  status: "succeeded",
                  finishedAt,
                  intentions,
                  steps: [...run.steps, {
                    kind: "tool",
                    at,
                    callId: `submit_intentions:${nextStep++}`,
                    tool: "submit_intentions",
                    status: "ok",
                    summary: `Submitted ${plural(intentions.length, "group")}`
                  }]
                }))
                yield* Scope.close(part.lease, Exit.void)
                return ok
              }), { concurrency: "unbounded" })
            yield* Effect.sync(() => {
              if (triage === current) triage = undefined
            }).pipe(Semaphore.withPermit(lock))
            const partly = [
              current.gone.size === 0
                ? ""
                : " Some of the tabs were in a Chrome profile that disconnected before the end; their groups weren't saved.",
              saved.every((ok) => ok) ? "" : " Some groups couldn't be stored in the extension, so they may not show in the side panel."
            ].join("")
            yield* Effect.logInfo(`mcp: tidy-up submitted (${count})`)
            return {
              message: `Saved ${count}.${partly} The user reviews them in the Wherefore side panel, where they save what matters and close the tabs. You're done: don't call any more tools.`
            }
          })
        )
      })

    return { listTabs, readPages, askUser, submitIntentions } satisfies Session
  })

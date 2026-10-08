/**
 * The MCP session (src/mcp/Session.ts) against in-memory brokers: each fake profile answers the
 * broker's calls itself, holds its runs' leases and stores its runs like the extension's worker, so
 * the order of events (a stop, a reply, a disconnect) is the test's to choose.
 */
import { describe, expect, it } from "@effect/vitest"
import {
  ExtensionUnavailable,
  localDay,
  MessageTooLarge,
  type ProfileId,
  type Question,
  type Run,
  RunAlreadyActive,
  RunNotActive,
  type RunSignal,
  STOPPED_STEP,
  type SubmittedIntention,
  type TabId,
  type TabSnapshot
} from "@wherefore/core"
import { type Cause, Deferred, Effect, Exit, Fiber, Queue, Stream } from "effect"
import { TestClock } from "effect/testing"
import type { BrokerClient } from "../src/broker/BrokerClient.ts"
import type { Broker, Brokers } from "../src/mcp/Brokers.ts"
import { makeSession, OPEN_RUN_TIMEOUT, runActiveMessage, UNKNOWN_TAB } from "../src/mcp/Session.ts"

const WORK = "workworkworkworkworkworkwo" as ProfileId
const HOME = "homehomehomehomehomehomeho" as ProfileId
const STOP_MESSAGE = "The user stopped this tidy-up in the Wherefore side panel."
const ctx = { agent: "test-client" }

const tabsOf = (prefix: string): ReadonlyArray<TabSnapshot> => [
  { id: 1 as TabId, window: 1, index: 0, title: `${prefix} PR`, url: `https://github.com/${prefix}/api/pull/1` },
  { id: 2 as TabId, window: 1, index: 1, title: `${prefix} docs`, url: `https://docs.example/${prefix}` }
] as never

const page = (id: number) => ({ id, title: "t", url: "https://example.com/", headings: [], description: "", text: "x", scrollPct: null, media: null, selection: "" })

const intention = (title: string, tabIds: ReadonlyArray<number>): SubmittedIntention =>
  ({ title, why: "w", kind: "read", tabIds, confidence: "high", evidence: "e" }) as never

interface FakeOptions {
  /** `open_run`'s stream; by default the run opens at once and stays open until the lease ends. */
  readonly openRun?: (profile: FakeProfile, id: string) => Stream.Stream<RunSignal, unknown>
  /** Runs before every `update_run` is stored: may fail it, or hold it. */
  readonly beforeUpdate?: (run: Run) => Effect.Effect<void, unknown>
  readonly readPages?: (tabIds: ReadonlyArray<number>) => Effect.Effect<unknown, unknown>
  readonly askPanel?: (questions: ReadonlyArray<Question>) => Effect.Effect<unknown, unknown>
  /** `list_tabs`'s answer; `undefined` (the default) lists the profile's two tabs. */
  readonly listTabs?: () => Effect.Effect<unknown, unknown> | undefined
}

class FakeProfile {
  readonly runs = new Map<string, Run>()
  readonly leases = new Map<string, Queue.Queue<RunSignal, Cause.Done>>()
  readonly log: Array<string> = []
  readonly broker: Broker

  constructor(readonly profileId: ProfileId, readonly options: FakeOptions = {}) {
    const self = this
    const handlers: Record<string, (payload: any) => Effect.Effect<unknown, unknown>> = {
      list_tabs: () =>
        options.listTabs?.() ?? Effect.succeed({ tabs: tabsOf(profileId === WORK ? "work" : "home"), today: "2026-10-08 (Thu)" }),
      read_pages: ({ tabIds }) => options.readPages?.(tabIds) ?? Effect.succeed({ pages: tabIds.map(page) }),
      ask_panel: ({ questions }) => options.askPanel?.(questions) ?? Effect.never,
      update_run: ({ run }: { run: Run }) =>
        Effect.gen(function*() {
          if (options.beforeUpdate !== undefined) yield* options.beforeUpdate(run)
          if (!self.leases.has(run.id)) return yield* new RunNotActive({ runId: run.id, message: "not leased" })
          self.runs.set(run.id, run)
        })
    }
    const client = {
      socket: `fake-${profileId}`,
      call: (tag: string, payload: unknown) =>
        Effect.suspend(() => {
          this.log.push(tag)
          return handlers[tag]!(payload)
        }),
      openRun: ({ id }: { id: string }) => {
        this.log.push("open_run")
        return options.openRun?.(this, id) ?? this.lease(id)
      }
    }
    this.broker = { profileId, client: client as unknown as BrokerClient }
  }

  /** A lease that opens at once, like the worker's. */
  readonly lease = (id: string): Stream.Stream<RunSignal> =>
    Stream.unwrap(Effect.gen({ self: this }, function*() {
      const signals = yield* Queue.unbounded<RunSignal, Cause.Done>()
      this.leases.set(id, signals)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          if (this.leases.get(id) === signals) this.leases.delete(id)
        })
      )
      yield* Queue.offer(signals, { _tag: "Opened" })
      return Stream.fromQueue(signals)
    }))

  /** The user presses Stop in this profile's panel. */
  readonly stop = (runId: string) =>
    Effect.suspend(() => {
      const lease = this.leases.get(runId)
      if (lease === undefined) return Effect.die(new Error(`no lease for ${runId}`))
      this.leases.delete(runId)
      return Effect.andThen(Queue.offer(lease, { _tag: "Stopped", message: STOP_MESSAGE }), Queue.end(lease))
    })

  get onlyRun(): Run {
    const runs = [...this.runs.values()]
    expect(runs).toHaveLength(1)
    return runs[0]!
  }
}

const brokersOf = (profiles: ReadonlyArray<FakeProfile>): Brokers => ({
  current: Effect.sync(() => profiles.map((profile) => profile.broker)),
  forget: () => Effect.void,
  profile: undefined
})

/** The session ids the model sees for each profile's tabs, from a list_tabs result. */
const idsOf = (tabs: ReadonlyArray<TabSnapshot>, prefix: string) => tabs.filter((tab) => tab.title.startsWith(prefix)).map((tab) => tab.id)

const failure = <A, E>(exit: Exit.Exit<A, E>) => {
  if (Exit.isSuccess(exit)) throw new Error(`expected a failure, got ${JSON.stringify(exit.value)}`)
  const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
  if (error === undefined || error._tag !== "Fail") throw new Error("expected a typed failure")
  return error.error as E
}

describe("MCP session", () => {
  it.effect("a profile that reconnects mid-triage stays out of the coverage check until its tabs are listed again", () =>
    Effect.gen(function*() {
      let homeReads = 0
      const work = new FakeProfile(WORK)
      // Home's Chrome goes away during the first read, then comes back.
      const home = new FakeProfile(HOME, {
        readPages: (tabIds) =>
          homeReads++ === 0 ? Effect.fail(new ExtensionUnavailable({ message: "port closed" })) : Effect.succeed({ pages: tabIds.map(page) })
      })
      const session = yield* makeSession({ brokers: brokersOf([work, home]) })
      const { tabs } = yield* session.listTabs(ctx)
      const homeIds = idsOf(tabs, "home")
      const workIds = idsOf(tabs, "work")

      yield* session.readPages({ tabIds: homeIds }, false, ctx)
      // Home is back: this read opens a new run there, which hasn't listed any tabs.
      const read = yield* session.readPages({ tabIds: homeIds }, false, ctx)
      expect(read.pages.every((p) => !("error" in p))).toBe(true)
      expect(home.runs.size).toBe(2)

      const done = yield* session.submitIntentions({ intentions: [intention("Work", workIds), intention("Home", homeIds)] }, ctx)
      expect(done.message).toContain("disconnected")
      expect(work.onlyRun.status).toBe("succeeded")
    }))

  it.effect("a run the extension can't store is reported as such, not as a disconnected profile", () =>
    Effect.gen(function*() {
      const work = new FakeProfile(WORK, {
        beforeUpdate: (run) => run.status === "succeeded" ? Effect.fail(new MessageTooLarge({ bytes: 2_000_000, limit: 1_000_000 })) : Effect.void
      })
      const session = yield* makeSession({ brokers: brokersOf([work]) })
      const { tabs } = yield* session.listTabs(ctx)
      const done = yield* session.submitIntentions({ intentions: [intention("Work", tabs.map((tab) => tab.id))] }, ctx)
      expect(done.message).toContain("couldn't be stored")
      expect(done.message).not.toContain("disconnected")
    }))

  it.effect("ask_user naming no known tab fails at once and leaves a pending stop for the next call", () =>
    Effect.gen(function*() {
      const cancelled = yield* Deferred.make<void>()
      const work = new FakeProfile(WORK, {
        beforeUpdate: (run) => run.status === "cancelled" ? Deferred.succeed(cancelled, undefined) : Effect.void
      })
      const session = yield* makeSession({ brokers: brokersOf([work]) })
      const { tabs } = yield* session.listTabs(ctx)
      // Stopped with nothing in flight: the next call that can hear it reports it.
      yield* work.stop(work.onlyRun.id)
      yield* Deferred.await(cancelled)
      const asked = yield* session.askUser({ questions: [{ id: "q1", tabIds: [999], question: "Why?", options: [] }] as never }, ctx).pipe(Effect.exit)
      expect(failure(asked).message).toContain("None of these questions names a tab from list_tabs")
      const told = yield* session.readPages({ tabIds: [tabs[0]!.id] }, false, ctx).pipe(Effect.exit)
      expect(failure(told).message).toContain(STOP_MESSAGE)
    }))

  it.effect("list_tabs skips a profile busy with another tidy-up, says so, and lists the others", () =>
    Effect.gen(function*() {
      const work = new FakeProfile(WORK)
      const home = new FakeProfile(HOME, { openRun: () => Stream.fail(new RunAlreadyActive({ source: "api" })) })
      const session = yield* makeSession({ brokers: brokersOf([work, home]) })
      const listed = yield* session.listTabs(ctx)
      expect(listed.tabs.map((tab) => tab.title)).toEqual(["work PR", "work docs"])
      expect(listed.notice).toContain(HOME)
      expect(listed.notice).toContain(runActiveMessage("api"))
      expect(home.runs.size).toBe(0)
      // The triage goes on with the profiles that joined.
      const done = yield* session.submitIntentions({ intentions: [intention("Work", listed.tabs.map((tab) => tab.id))] }, ctx)
      expect(done.message).toContain("Saved 1 group")
      expect(work.onlyRun.status).toBe("succeeded")

      // Only when no profile can join does list_tabs fail.
      const alone = yield* makeSession({ brokers: brokersOf([home]) })
      const refused = yield* alone.listTabs(ctx).pipe(Effect.exit)
      expect(failure(refused).message).toBe(runActiveMessage("api"))
    }))

  it.effect("list_tabs lists no tabs, with this machine's day, when the profiles it asked left but others still take part", () =>
    Effect.gen(function*() {
      const now = Date.parse("2026-10-08T12:00:00.000Z")
      yield* TestClock.setTime(now)
      let workLists = 0
      // Work's Chrome closes during the second list.
      const work = new FakeProfile(WORK, {
        listTabs: () => workLists++ === 0 ? undefined : Effect.fail(new ExtensionUnavailable({ message: "port closed" }))
      })
      const home = new FakeProfile(HOME)
      const live = [work, home]
      const session = yield* makeSession({ brokers: brokersOf(live) })
      yield* session.listTabs(ctx)
      // Home's broker is gone from the registry, but its run still takes part in the triage.
      live.splice(1, 1)
      const listed = yield* session.listTabs(ctx)
      expect(listed).toEqual({ tabs: [], today: localDay(now) })
    }))

  it.effect("a stop that lands while a call is ending (here: cancelled) is told to the next call", () =>
    Effect.gen(function*() {
      const reading = yield* Deferred.make<void>()
      const stoppedStepSaving = yield* Deferred.make<void>()
      const releaseStoppedStep = yield* Deferred.make<void>()
      const workCancelled = yield* Deferred.make<void>()
      // Work's run is the first the stop cancels: seeing it stored means the stop was handled.
      const work = new FakeProfile(WORK, {
        beforeUpdate: (run) => run.status === "cancelled" ? Deferred.succeed(workCancelled, undefined) : Effect.void
      })
      // Home's read never finishes; storing its "Stopped" step waits for the test.
      const home = new FakeProfile(HOME, {
        readPages: () => Effect.andThen(Deferred.succeed(reading, undefined), Effect.never),
        beforeUpdate: (run) =>
          run.steps.some((step) => step.kind === "tool" && step.summary === STOPPED_STEP)
            ? Effect.andThen(Deferred.succeed(stoppedStepSaving, undefined), Deferred.await(releaseStoppedStep))
            : Effect.void
      })
      const session = yield* makeSession({ brokers: brokersOf([work, home]) })
      const { tabs } = yield* session.listTabs(ctx)

      // The client cancels a read; while the call is still ending, the user presses Stop.
      const call = yield* Effect.forkChild(session.readPages({ tabIds: idsOf(tabs, "home") }, false, ctx))
      yield* Deferred.await(reading)
      const cancelling = yield* Effect.forkChild(Fiber.interrupt(call))
      yield* Deferred.await(stoppedStepSaving)
      yield* work.stop(work.onlyRun.id)
      yield* Deferred.await(workCancelled)
      yield* Deferred.succeed(releaseStoppedStep, undefined)
      yield* Fiber.join(cancelling)

      // The cancelled call couldn't tell the model: the next call does.
      const next = yield* session.listTabs(ctx).pipe(Effect.exit)
      expect(failure(next).message).toContain(STOP_MESSAGE)
      // Once.
      expect(Exit.isSuccess(yield* session.listTabs(ctx).pipe(Effect.exit))).toBe(true)
    }))

  it.effect("a profile that never answers open_run is skipped after a timeout, and blocks nothing meanwhile", () =>
    Effect.gen(function*() {
      const opening = yield* Deferred.make<void>()
      const leaseEnded = yield* Deferred.make<void>()
      const work = new FakeProfile(WORK)
      // Home's broker takes the lease and never answers.
      const home = new FakeProfile(HOME, {
        openRun: () =>
          Stream.fromEffect(Deferred.succeed(opening, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(leaseEnded, undefined))
          )) as never
      })
      const session = yield* makeSession({ brokers: brokersOf([work, home]) })
      const listing = yield* Effect.forkChild(session.listTabs(ctx))
      yield* Deferred.await(opening)

      // Meanwhile other calls go ahead.
      const read = yield* session.readPages({ tabIds: [999 as TabId] }, false, ctx)
      expect(read.pages).toEqual([{ id: 999, error: UNKNOWN_TAB }])

      yield* TestClock.adjust(OPEN_RUN_TIMEOUT)
      const listed = yield* Fiber.join(listing)
      expect(listed.tabs.map((tab) => tab.title)).toEqual(["work PR", "work docs"])
      expect(listed.notice).toContain(HOME)
      expect(listed.notice).toContain("didn't answer")
      yield* Deferred.await(leaseEnded)
    }))
})

/**
 * Which API-mode runs are actually running (architecture A4).
 *
 * An API-mode run lives in the page that started it and dies with it, without a chance to record
 * that it stopped. So the page holds a Web Lock (`navigator.locks`) for as long as the run goes:
 * the browser releases it the moment the page closes or crashes, even mid-await. A stored run that
 * says "running" while its lock is free was interrupted. Extension pages and the service worker
 * share one origin, so they all see the same locks.
 *
 * Two locks per run: `wherefore/api-run` makes runs exclusive (tabs are global, so two triage runs
 * at once make no sense), and `wherefore/run/<id>` names the run, so anyone can ask whether that
 * particular run is still alive.
 */
import { type RunId, RunId as RunIdSchema } from "@wherefore/core"
import { Context, Effect, Layer, Schema, type Scope } from "effect"

/** Another page is running a triage run right now. */
export class RunAlreadyActive extends Schema.TaggedError<RunAlreadyActive>()("RunAlreadyActive", {
  /** The live run, when known. */
  runId: Schema.optionalKey(RunIdSchema)
}) {}

export const EXCLUSIVE_LOCK = "wherefore/api-run"
const RUN_LOCK_PREFIX = "wherefore/run/"
export const runLockName = (id: RunId): string => `${RUN_LOCK_PREFIX}${id}`

export class RunLocks extends Context.Service<RunLocks, {
  /**
   * Holds the locks of run `id` until the scope closes (or the page dies). Fails with
   * `RunAlreadyActive`, without waiting, when another run holds them.
   */
  readonly hold: (id: RunId) => Effect.Effect<void, RunAlreadyActive, Scope.Scope>
  /** True while some page holds run `id`'s lock. */
  readonly isLive: (id: RunId) => Effect.Effect<boolean>
  /** Completes when run `id`'s lock is free: right away if nobody holds it. */
  readonly whenReleased: (id: RunId) => Effect.Effect<void>
}>()("@wherefore/extension/RunLocks") {
  /** `navigator.locks`: extension pages and the service worker. */
  static readonly layer: Layer.Layer<RunLocks> = Layer.sync(RunLocks)(() => makeWebLocks(navigator.locks))
}

/** The subset of `LockManager` used here, so tests can pass a fake. */
export interface LockManagerLike {
  request(
    name: string,
    options: { readonly ifAvailable?: boolean; readonly mode?: "exclusive" | "shared"; readonly signal?: AbortSignal },
    callback: (lock: unknown) => unknown
  ): Promise<unknown>
  query(): Promise<{ readonly held?: ReadonlyArray<{ readonly name?: string; readonly mode?: string }> }>
}

/**
 * Acquires `name` without waiting and holds it until the scope closes. Fails when it is taken.
 * The lock is released by resolving the promise its callback returned.
 */
const acquire = (locks: LockManagerLike, name: string, onTaken: () => RunAlreadyActive) =>
  Effect.acquireRelease(
    Effect.callback<() => void, RunAlreadyActive>((resume) => {
      locks.request(name, { ifAvailable: true }, (lock) => {
        if (lock === null) {
          resume(Effect.fail(onTaken()))
          return undefined
        }
        return new Promise<void>((release) => resume(Effect.succeed(() => release())))
      }).catch((cause: unknown) => resume(Effect.die(cause)))
    }),
    (release) => Effect.sync(release)
  )

export const makeWebLocks = (locks: LockManagerLike): RunLocks["Service"] => ({
  hold: (id) =>
    Effect.gen(function*() {
      yield* acquire(locks, EXCLUSIVE_LOCK, () => new RunAlreadyActive({}))
      yield* acquire(locks, runLockName(id), () => new RunAlreadyActive({ runId: id }))
    }),
  isLive: (id) =>
    Effect.promise(() => locks.query()).pipe(
      // Only the run's own (exclusive) hold counts: a mirror waiting in `whenReleased` holds the lock
      // in shared mode for a moment once it is free.
      Effect.map(({ held }) => (held ?? []).some((lock) => lock.name === runLockName(id) && lock.mode !== "shared")),
      // If the lock manager can't answer, assume the run is alive: never mark a live run interrupted.
      Effect.catchCause(() => Effect.succeed(true))
    ),
  whenReleased: (id) =>
    Effect.callback<void>((resume, signal) => {
      // A shared request is granted only once the run's exclusive holder lets go.
      locks.request(runLockName(id), { mode: "shared", signal }, () => resume(Effect.void)).catch(() => {
        // Aborted because the waiting fiber was interrupted: nothing to resume.
      })
    })
})

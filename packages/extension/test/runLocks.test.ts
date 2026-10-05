import { describe, expect, it } from "@effect/vitest"
import { RunId } from "@wherefore/core"
import { Effect, Exit, Fiber, Scope } from "effect"
import { makeWebLocks, runLockName } from "../src/runs/RunLocks.ts"
import { FakeLockManager } from "./fakes/locks.ts"
import { settle } from "./fakes/harness.ts"

const a = RunId.make("run-a")
const b = RunId.make("run-b")

describe("RunLocks (Web Locks)", () => {
  it.effect("holds a run exclusively until its scope closes", () =>
    Effect.gen(function*() {
      const manager = new FakeLockManager()
      const page1 = makeWebLocks(manager.client())
      const page2 = makeWebLocks(manager.client())
      const worker = makeWebLocks(manager.client())

      const scope = yield* Scope.make()
      yield* page1.hold(a).pipe(Scope.provide(scope))
      expect(manager.heldNames()).toEqual(["wherefore/api-run", runLockName(a)])
      expect(yield* worker.isLive(a)).toBe(true)
      expect(yield* worker.isLive(b)).toBe(false)

      const busy = yield* Effect.flip(page2.hold(b).pipe(Effect.scoped))
      expect(busy._tag).toBe("RunAlreadyActive")

      yield* Scope.close(scope, Exit.void)
      yield* settle
      expect(yield* worker.isLive(a)).toBe(false)
      yield* page2.hold(b).pipe(Effect.scoped)
    }))

  it.effect("loses its locks when the page closes, and waiters are told", () =>
    Effect.gen(function*() {
      const manager = new FakeLockManager()
      const pageClient = manager.client()
      const page = makeWebLocks(pageClient)
      const mirror = makeWebLocks(manager.client())

      yield* page.hold(a) // held for the rest of the test's scope
      expect(yield* mirror.isLive(a)).toBe(true)
      const released = yield* Effect.forkChild(mirror.whenReleased(a))
      yield* settle
      expect(released.pollUnsafe()).toBeUndefined()

      manager.close(pageClient) // no finalizer runs in a closed page
      yield* Fiber.join(released)
      expect(yield* mirror.isLive(a)).toBe(false)
    }))

  it.effect("whenReleased returns at once for a run nobody holds", () =>
    makeWebLocks(new FakeLockManager().client()).whenReleased(a))
})

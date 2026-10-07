/**
 * One fake browser for end-to-end tests: a worker that can be started, killed and started again
 * over the same tabs and storage, pages that talk to it over fake Ports, the Web Locks the pages
 * and the worker share, and the companion's native host.
 */
import type { Run } from "@wherefore/core"
import { Effect, Exit, Layer, Scope } from "effect"
import { WorkerLayer } from "../../src/background/worker.ts"
import { PORT_NAME } from "../../src/messaging/protocol.ts"
import { listenForPorts, PortListener } from "../../src/messaging/server.ts"
import { PortConnector, WorkerClient, type WorkerRpcTag, WorkerUnavailable } from "../../src/messaging/WorkerClient.ts"
import type { FakeChrome } from "./chrome.ts"
import { FakeLockManager } from "./locks.ts"
import { FakeNativeHost } from "./native.ts"
import { FakeOnConnect, type FakePort, portPair } from "./ports.ts"

export const ORIGIN = "chrome-extension://test-extension/"
export const PANEL_URL = `${ORIGIN}sidepanel.html`

/** Lets queued Port messages (microtasks) and woken fibers run. */
export const settle = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

export const waitUntil = (condition: () => boolean) =>
  Effect.gen(function*() {
    for (let i = 0; i < 200 && !condition(); i++) yield* settle
    if (!condition()) return yield* Effect.die(new Error("condition never became true"))
  })

export class Harness {
  readonly chrome: FakeChrome
  readonly locks = new FakeLockManager()
  private onConnect = new FakeOnConnect()
  readonly pairs: Array<{ readonly page: FakePort; readonly worker: FakePort }> = []
  private workerScope: Scope.Closeable | undefined
  /** The running worker's client of the lock manager. */
  private workerLocks: { readonly id: number } | undefined
  /** Scopes of workers that crashed: closed (for cleanup only) with the next `killWorker`. */
  private readonly crashed: Array<Scope.Closeable> = []
  /**
   * Fault hook: a page's `save_run` call fails with `WorkerUnavailable`, without reaching the
   * worker, while this returns true for the run being saved.
   */
  failSaveRun: ((run: Run) => boolean) | undefined = undefined

  /** The companion's host, as `connectNative` finds it. Not installed unless a test says so. */
  readonly native: FakeNativeHost

  constructor(chrome: FakeChrome, native: FakeNativeHost = new FakeNativeHost("missing")) {
    this.chrome = chrome
    this.native = native
  }

  readonly startWorker = Effect.suspend(() => {
    // A new worker instance: new listeners, same storage, tabs and locks.
    this.onConnect = new FakeOnConnect()
    const ports = listenForPorts(this.onConnect, ORIGIN)
    return Effect.gen({ self: this }, function*() {
      const scope = yield* Scope.make()
      this.workerScope = scope
      const locks = this.locks.runLocks()
      this.workerLocks = locks.client
      yield* Layer.buildWithScope(
        WorkerLayer.pipe(
          Layer.provide([this.chrome.layer, locks.layer, this.native.layer, Layer.succeed(PortListener)(ports)])
        ),
        scope
      )
    })
  })

  /** Chrome stops the worker: its Ports disconnect, its memory is gone. */
  readonly killWorker = Effect.suspend(() => {
    for (const { worker } of this.pairs) worker.disconnect()
    const scopes = [...this.crashed.splice(0), ...(this.workerScope === undefined ? [] : [this.workerScope])]
    this.workerScope = undefined
    return Effect.forEach(scopes, (scope) => Scope.close(scope, Exit.void), { discard: true })
  })

  /**
   * Chrome kills the worker without running any of its code: its Ports disconnect and its Web Locks
   * are dropped. (Its fibers are cleaned up with the next `killWorker`.)
   */
  readonly crashWorker = Effect.sync(() => {
    for (const { worker } of this.pairs) worker.disconnect()
    if (this.workerLocks !== undefined) this.locks.close(this.workerLocks)
    if (this.workerScope !== undefined) this.crashed.push(this.workerScope)
    this.workerScope = undefined
    this.workerLocks = undefined
  })

  readonly connector: PortConnector["Service"] = {
    connect: Effect.sync(() => {
      const pair = portPair(PORT_NAME, PANEL_URL)
      this.pairs.push(pair)
      this.onConnect.fire(pair.worker)
      return pair.page
    })
  }

  get clientLayer(): Layer.Layer<WorkerClient> {
    const real = WorkerClient.layerWith.pipe(Layer.provide(Layer.succeed(PortConnector)(this.connector)))
    const faulty = Layer.effect(WorkerClient)(Effect.gen({ self: this }, function*() {
      const client = yield* WorkerClient
      // Decided per attempt, so a retry of the same call can go through. The generic call's
      // conditional return type doesn't resolve inside a wrapper, so it is re-typed once here.
      const call = (tag: WorkerRpcTag, payload: unknown) =>
        Effect.suspend(() =>
          tag === "save_run" && this.failSaveRun?.((payload as { readonly run: Run }).run) === true
            ? Effect.fail(new WorkerUnavailable({ message: "fault injected by the test" }))
            : client.call(tag, payload as never)
        )
      return WorkerClient.of({ call: call as WorkerClient["Service"]["call"] })
    }))
    return faulty.pipe(Layer.provide(real))
  }

  /** Fires a Port that wasn't opened by `WorkerClient`. */
  rawPort(senderUrl: string): FakePort {
    const pair = portPair(PORT_NAME, senderUrl)
    this.onConnect.fire(pair.worker)
    return pair.page
  }
}

export const withClient = <A, E>(harness: Harness, body: (client: WorkerClient["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    yield* harness.startWorker
    return yield* Effect.flatMap(WorkerClient, body)
  }).pipe(Effect.provide(harness.clientLayer), Effect.scoped)

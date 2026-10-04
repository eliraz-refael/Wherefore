import { assert, describe, expect, it } from "@effect/vitest"
import { TabId, WindowId } from "@wherefore/core"
import { Effect, Exit, Fiber, Layer, Schema, Scope } from "effect"
import { WorkerLayer } from "../src/background/worker.ts"
import { PORT_NAME } from "../src/messaging/protocol.ts"
import { listenForPorts, PortListener } from "../src/messaging/server.ts"
import { PortConnector, WorkerClient } from "../src/messaging/WorkerClient.ts"
import { itemsKey } from "../src/store/keys.ts"
import { FakeChrome } from "./fakes/chrome.ts"
import { FakeOnConnect, type FakePort, portPair } from "./fakes/ports.ts"

const ORIGIN = "chrome-extension://test-extension/"
const PANEL_URL = `${ORIGIN}sidepanel.html`

/** Lets queued Port messages (microtasks) and woken fibers run. */
const settle = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))

const waitUntil = (condition: () => boolean) =>
  Effect.gen(function*() {
    for (let i = 0; i < 200 && !condition(); i++) yield* settle
    if (!condition()) return yield* Effect.die(new Error("condition never became true"))
  })

/** A worker that can be started, killed and started again over the same browser state, and a page. */
class Harness {
  readonly chrome: FakeChrome
  private onConnect = new FakeOnConnect()
  readonly pairs: Array<{ readonly page: FakePort; readonly worker: FakePort }> = []
  private workerScope: Scope.Closeable | undefined

  constructor(chrome: FakeChrome) {
    this.chrome = chrome
  }

  readonly startWorker = Effect.suspend(() => {
    // A new worker instance: new listeners, same storage and tabs.
    this.onConnect = new FakeOnConnect()
    const ports = listenForPorts(this.onConnect, ORIGIN)
    return Effect.gen({ self: this }, function*() {
      const scope = yield* Scope.make()
      this.workerScope = scope
      yield* Layer.buildWithScope(
        WorkerLayer.pipe(Layer.provide([this.chrome.layer, Layer.succeed(PortListener)(ports)])),
        scope
      )
    })
  })

  /** Chrome stops the worker: its Ports disconnect, its memory is gone. */
  readonly killWorker = Effect.suspend(() => {
    for (const { worker } of this.pairs) worker.disconnect()
    const scope = this.workerScope
    this.workerScope = undefined
    return scope === undefined ? Effect.void : Scope.close(scope, Exit.void)
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
    return WorkerClient.layerWith.pipe(Layer.provide(Layer.succeed(PortConnector)(this.connector)))
  }

  /** Fires a Port that wasn't opened by `WorkerClient`. */
  rawPort(senderUrl: string): FakePort {
    const pair = portPair(PORT_NAME, senderUrl)
    this.onConnect.fire(pair.worker)
    return pair.page
  }
}

const withClient = <A, E>(harness: Harness, body: (client: WorkerClient["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    yield* harness.startWorker
    return yield* Effect.flatMap(WorkerClient, body)
  }).pipe(Effect.provide(harness.clientLayer), Effect.scoped)

const tabs = () =>
  new FakeChrome({
    tabs: [
      { id: 1, windowId: 1, url: "https://keep.example/" },
      { id: 2, windowId: 1, url: "https://github.com/acme/api/pull/412?token=abc" },
      { id: 3, windowId: 1, url: "https://slow.example/", discarded: true }
    ],
    reloadCompletes: false
  })

const storedItem = {
  id: "item-1",
  type: "todo",
  task: "Review the auth PR",
  intention: "Finish reviewing the auth PR",
  why: "Review requested",
  tabs: [{ title: "PR", url: "https://github.com/acme/api/pull/412", domain: "github.com" }],
  status: "open",
  savedAt: "2026-10-04T09:30:00.000Z"
}

describe("panel <-> worker RPC", () => {
  it.effect("round-trips tool calls and store writes over a Port", () => {
    const harness = new Harness(tabs())
    return withClient(harness, (client) =>
      Effect.gen(function*() {
        const { tabs: listed } = yield* client.call("list_tabs", {})
        expect(listed.map((tab) => tab.url)).toEqual([
          "https://keep.example/",
          "https://github.com/acme/api/pull/412?token=REDACTED",
          "https://slow.example/"
        ])

        const [item] = Schema.decodeUnknownSync(itemsKey.schema)([storedItem])
        assert(item !== undefined)
        yield* client.call("save_items", { items: [item] })
        expect(harness.chrome.local.get("items")).toEqual({ version: 1, data: [storedItem] })

        const missing = yield* Effect.flip(client.call("mark_done", { id: "nope" as typeof item.id }))
        expect(missing).toMatchObject({ _tag: "ItemNotFound", id: "nope" })
        expect(harness.pairs).toHaveLength(1)
      }))
  })

  it.effect("fails a call in flight with WorkerUnavailable when the worker stops, then reconnects", () => {
    const harness = new Harness(tabs())
    return withClient(harness, (client) =>
      Effect.gen(function*() {
        // Waking tab 3 waits for a reload that never completes.
        const inFlight = yield* Effect.forkChild(client.call("wake_and_read_pages", { tabIds: [TabId.make(3)] }))
        yield* waitUntil(() => harness.chrome.calls.includes("tabs.reload 3"))
        yield* harness.killWorker
        const exit = yield* Fiber.await(inFlight)
        assert(Exit.isFailure(exit))
        expect(String(exit.cause)).toContain("WorkerUnavailable")

        // The next call opens a new Port, which starts the worker again.
        yield* harness.startWorker
        const { tabs: listed } = yield* client.call("list_tabs", {})
        expect(listed).toHaveLength(3)
        expect(harness.pairs).toHaveLength(2)
      }))
  })

  it.effect("undoes a close made before the worker restarted", () => {
    const harness = new Harness(tabs())
    return withClient(harness, (client) =>
      Effect.gen(function*() {
        const closed = yield* client.call("close_tabs", {
          tabIds: [TabId.make(2), TabId.make(3)],
          keepWindowAlive: WindowId.make(1)
        })
        assert(closed.undo !== null)
        yield* harness.killWorker
        yield* harness.startWorker
        const undone = yield* client.call("undo_close", { token: closed.undo })
        expect(undone.restored.map(({ from }) => from).sort()).toEqual([2, 3])
        expect(harness.chrome.urlsIn(1)).toEqual([
          "https://keep.example/",
          "https://github.com/acme/api/pull/412?token=abc",
          "https://slow.example/"
        ])
      }))
  })

  it.effect("fails with WorkerUnavailable when the worker can't be reached", () =>
    Effect.gen(function*() {
      const client = yield* WorkerClient
      const error = yield* Effect.flip(client.call("list_tabs", {}))
      expect(error).toMatchObject({ _tag: "WorkerUnavailable" })
    }).pipe(
      Effect.provide(WorkerClient.layerWith.pipe(Layer.provide(Layer.succeed(PortConnector)({
        connect: Effect.sync(() => {
          // Nobody is listening: the Port disconnects right away.
          const { page, worker } = portPair(PORT_NAME, PANEL_URL)
          worker.disconnect()
          return page
        })
      }))))
    ))

  it.effect("disconnects Ports from outside the extension and drops malformed messages", () => {
    const harness = new Harness(tabs())
    return withClient(harness, (client) =>
      Effect.gen(function*() {
        const foreign = harness.rawPort("https://evil.example/")
        yield* settle
        expect(foreign.connected).toBe(false)

        const own = harness.rawPort(PANEL_URL)
        own.postMessage({ _tag: "Request", id: 1 })
        own.postMessage("hello")
        yield* settle
        expect(own.connected).toBe(true)

        // The worker still serves well-formed calls.
        const { tabs: listed } = yield* client.call("list_tabs", {})
        expect(listed).toHaveLength(3)
      }))
  })
})

import { assert, describe, expect, it } from "@effect/vitest"
import { NATIVE_PROTOCOL_VERSION, ProfileId } from "@wherefore/core"
import { Clock, Duration, Effect, Schema } from "effect"
import { TestClock } from "effect/testing"
import { MAX_RETRIES, retryDelay } from "../src/companion/CompanionLink.ts"
import { WorkerClient } from "../src/messaging/WorkerClient.ts"
import { FakeChrome } from "./fakes/chrome.ts"
import { Harness, settle, waitUntil } from "./fakes/harness.ts"
import { FakeNativeHost, type HostMode } from "./fakes/native.ts"

const browser = () =>
  new FakeChrome({
    tabs: [
      { id: 1, windowId: 1, url: "https://github.com/acme/api/pull/412?token=abc", title: "Auth PR" },
      { id: 2, windowId: 1, url: "https://example.com/" }
    ]
  })

const setup = (mode: HostMode) => new Harness(browser(), new FakeNativeHost(mode))

/** The status the worker stored for views. */
const statusOf = (harness: Harness): any => harness.chrome.session.get("companion")

/** Runs `body` with a started worker and a page client; stops the worker after. */
const withWorker = <A, E>(harness: Harness, body: (client: WorkerClient["Service"]) => Effect.Effect<A, E>) =>
  Effect.gen(function*() {
    yield* harness.startWorker
    return yield* Effect.flatMap(WorkerClient, body)
  }).pipe(Effect.ensuring(harness.killWorker), Effect.provide(harness.clientLayer), Effect.scoped)

const waitForStatus = (harness: Harness, tag: string) => waitUntil(() => statusOf(harness)?._tag === tag)

describe("companion link", () => {
  it.effect("records a missing companion once and doesn't retry until asked", () => {
    const harness = setup("missing")
    return withWorker(harness, (client) =>
      Effect.gen(function*() {
        yield* waitForStatus(harness, "NotInstalled")
        expect(harness.native.connections).toHaveLength(1)
        yield* TestClock.adjust("1 hour")
        yield* settle
        expect(harness.native.connections).toHaveLength(1)

        // The user installs the companion, then presses "Check again".
        harness.native.mode = "answer"
        const status = yield* client.call("check_companion", undefined)
        expect(status).toMatchObject({ _tag: "Connected", companionVersion: "0.9.0" })
        expect(harness.native.connections).toHaveLength(2)
      }))
  })

  it.effect("says Hello with a stable profile id, then serves the tab tools to the host", () => {
    const harness = setup("answer")
    return withWorker(harness, () =>
      Effect.gen(function*() {
        yield* waitForStatus(harness, "Connected")
        const host = harness.native.last
        assert(host !== undefined)
        const [hello] = host.received as Array<any>
        expect(hello).toMatchObject({ _tag: "Hello", protocol: NATIVE_PROTOCOL_VERSION, extensionVersion: "1.0.0" })
        expect(Schema.is(ProfileId)(hello.profileId)).toBe(true)
        expect(harness.chrome.local.get("profile")).toEqual({ version: 1, data: { id: hello.profileId } })
        expect(statusOf(harness)).toMatchObject({ _tag: "Connected", profileId: hello.profileId, companionVersion: "0.9.0" })

        // Junk from the host is dropped; the link keeps working.
        host.send({ _tag: "Nonsense" })
        host.send({ _tag: "ToWorker", rpc: { _tag: "Request", id: "7", tag: "list_tabs", payload: {}, headers: [] } })
        yield* waitUntil(() => host.received.some((message: any) => message.rpc?.requestId === "7"))
        const reply = host.received.find((message: any) => message.rpc?.requestId === "7") as any
        expect(reply).toMatchObject({ _tag: "FromWorker", rpc: { _tag: "Exit", exit: { _tag: "Success" } } })
        expect(reply.rpc.exit.value.tabs.map((tab: any) => tab.url)).toEqual([
          "https://github.com/acme/api/pull/412?token=REDACTED",
          "https://example.com/"
        ])

        // Only the tab tools are served on this port.
        host.send({ _tag: "ToWorker", rpc: { _tag: "Request", id: "8", tag: "close_tabs", payload: { tabIds: [1], keepWindowAlive: 1 }, headers: [] } })
        yield* waitUntil(() => host.received.some((message: any) => message.rpc?.requestId === "8"))
        expect(harness.chrome.tabs).toHaveLength(2)
      }))
  })

  it.effect("keeps the profile id across worker restarts, and closes the port when the worker stops", () => {
    const harness = setup("answer")
    return Effect.gen(function*() {
      yield* withWorker(harness, () => waitForStatus(harness, "Connected"))
      const first = harness.native.connections[0]
      assert(first !== undefined)
      expect(first.closedByExtension).toBe(true)
      harness.chrome.session.clear()
      yield* withWorker(harness, () => waitForStatus(harness, "Connected"))
      const ids = harness.native.connections.map((connection) => (connection.received[0] as any).profileId)
      expect(ids).toHaveLength(2)
      expect(ids[0]).toBe(ids[1])
    })
  })

  it.effect("reconnects after the host exits, backing off, and stops after MAX_RETRIES failures", () => {
    const harness = setup("crash")
    return withWorker(harness, (client) =>
      Effect.gen(function*() {
        for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
          yield* waitUntil(() => harness.native.connections.length === attempt && statusOf(harness)?.retryAt !== undefined)
          const status = statusOf(harness)
          expect(status).toMatchObject({ _tag: "Unavailable", reason: "failed", message: "The companion didn't start (Native host has exited.)." })
          const delay = Duration.toMillis(retryDelay(attempt))
          expect(status.retryAt - (yield* Clock.currentTimeMillis)).toBe(delay)
          yield* TestClock.adjust(delay - 1)
          yield* settle
          expect(harness.native.connections).toHaveLength(attempt)
          harness.chrome.session.delete("companion")
          yield* TestClock.adjust(1)
        }
        // The last attempt fails too; then it waits for a nudge.
        yield* waitUntil(() => statusOf(harness)?._tag === "Unavailable")
        expect(statusOf(harness).retryAt).toBeUndefined()
        expect(harness.native.connections).toHaveLength(MAX_RETRIES + 1)
        yield* TestClock.adjust("1 hour")
        yield* settle
        expect(harness.native.connections).toHaveLength(MAX_RETRIES + 1)

        harness.native.mode = "answer"
        expect(yield* client.call("check_companion", undefined)).toMatchObject({ _tag: "Connected" })
      }))
  })

  it.effect("reconnects within a second when a long-lived connection drops", () => {
    const harness = setup("answer")
    return withWorker(harness, () =>
      Effect.gen(function*() {
        yield* waitForStatus(harness, "Connected")
        yield* TestClock.adjust("5 minutes")
        harness.native.last?.exit()
        yield* waitUntil(() => statusOf(harness)?._tag === "Unavailable")
        expect(statusOf(harness).message).toBe("The companion disconnected (Native host has exited.).")
        yield* TestClock.adjust("1 second")
        yield* waitForStatus(harness, "Connected")
        expect(harness.native.connections).toHaveLength(2)
      }))
  })

  it.effect("gives up on a host that never answers, then retries", () => {
    const harness = setup("silent")
    return withWorker(harness, () =>
      Effect.gen(function*() {
        yield* waitUntil(() => harness.native.connections.length === 1)
        yield* TestClock.adjust("10 seconds")
        yield* waitUntil(() => statusOf(harness)?._tag === "Unavailable")
        expect(statusOf(harness)).toMatchObject({ message: "The companion didn't answer." })
        expect(harness.native.connections[0]?.closedByExtension).toBe(true)
      }))
  })

  it.effect("doesn't retry when Chrome forbids the host, or the versions differ", () =>
    Effect.gen(function*() {
      const forbidden = setup("forbidden")
      yield* withWorker(forbidden, () =>
        Effect.gen(function*() {
          yield* waitUntil(() => statusOf(forbidden)?._tag === "Unavailable")
          expect(statusOf(forbidden)).toMatchObject({ reason: "forbidden" })
          expect(statusOf(forbidden).retryAt).toBeUndefined()
          yield* TestClock.adjust("1 hour")
          yield* settle
          expect(forbidden.native.connections).toHaveLength(1)
        }))

      const newer = setup("answer")
      newer.native.protocol = NATIVE_PROTOCOL_VERSION + 1
      yield* withWorker(newer, () =>
        Effect.gen(function*() {
          yield* waitUntil(() => statusOf(newer)?._tag === "Unavailable")
          expect(statusOf(newer)).toMatchObject({
            reason: "incompatible",
            message: "The companion is newer than this extension. Update the extension."
          })
          expect(newer.native.connections[0]?.closedByExtension).toBe(true)
          yield* TestClock.adjust("1 hour")
          yield* settle
          expect(newer.native.connections).toHaveLength(1)
        }))
    }))
})

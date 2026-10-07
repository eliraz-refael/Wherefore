import * as Fs from "node:fs/promises"
import { assert, describe, expect, it } from "@effect/vitest"
import { NATIVE_PROTOCOL_VERSION, TabId } from "@wherefore/core"
import { Effect, Exit, Fiber } from "effect"
import { connectBroker } from "../src/broker/BrokerClient.ts"
import { CLOSED_MESSAGE } from "../src/broker/WorkerLink.ts"
import { registryDir } from "../src/paths.ts"
import { PROFILE, sampleTabs, startFakeChrome, tempLocation } from "./fakes.ts"

const waitFor = (condition: () => boolean) =>
  Effect.gen(function*() {
    for (let i = 0; i < 300 && !condition(); i++) yield* Effect.sleep("10 millis")
    if (!condition()) return yield* Effect.die(new Error("condition never became true"))
  })

const exists = (path: string) => Effect.promise(() => Fs.stat(path).then(() => true, () => false))

describe("native host: broker", () => {
  it.live("answers Hello with Welcome, then forwards a socket client's tool call to the worker", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      const chrome = yield* startFakeChrome({ location })
      expect(yield* chrome.welcome).toEqual({ _tag: "Welcome", protocol: NATIVE_PROTOCOL_VERSION, companionVersion: "9.9.9" })

      const entry = yield* chrome.entry
      expect(entry).toMatchObject({ profileId: PROFILE, extensionVersion: "1.2.3", companionVersion: "9.9.9", pid: process.pid })
      const client = yield* connectBroker(entry.socket, entry.token)

      const info = yield* client.call("broker_info", undefined)
      expect(info).toMatchObject({ profileId: PROFILE, extensionVersion: "1.2.3", protocol: NATIVE_PROTOCOL_VERSION })

      const { tabs } = yield* client.call("list_tabs", {})
      expect(tabs.map((tab) => tab.url)).toEqual(sampleTabs.map((tab) => tab.url))
      expect(chrome.workerLog).toContain("request list_tabs")

      const asleep = yield* Effect.flip(client.call("wake_and_read_pages", { tabIds: [TabId.make(1)] }))
      expect(asleep).toMatchObject({ _tag: "ToolError", message: "asleep" })

      // The tool call went to Chrome in the model's wire form (snake_case).
      const sent = chrome.fromHost.find((frame) =>
        (frame as { rpc?: { tag?: string } }).rpc?.tag === "wake_and_read_pages"
      ) as { rpc: { payload: unknown } }
      expect(sent.rpc.payload).toEqual({ tab_ids: [1] })
    }))

  it.live("refuses requests without its access token, and keeps the token in its entry only", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      const chrome = yield* startFakeChrome({ location })
      const entry = yield* chrome.entry
      expect(entry.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
      const wrong = yield* connectBroker(entry.socket, "not-the-token")
      expect(yield* Effect.flip(wrong.call("list_tabs", {}))).toMatchObject({ _tag: "BrokerUnauthorized" })
      expect(yield* Effect.flip(wrong.call("broker_info", undefined))).toMatchObject({ _tag: "BrokerUnauthorized" })
      expect(chrome.workerLog).not.toContain("request list_tabs")
      const right = yield* connectBroker(entry.socket, entry.token)
      const info = yield* right.call("broker_info", undefined)
      expect(JSON.stringify(info)).not.toContain(entry.token)
    }))

  it.live("keeps its socket and registry entry user-only", () =>
    Effect.gen(function*() {
      if (process.platform === "win32") return
      const location = yield* tempLocation
      const chrome = yield* startFakeChrome({ location })
      const entry = yield* chrome.entry
      const dir = yield* Effect.promise(() => Fs.stat(registryDir(location)))
      expect(dir.mode & 0o777).toBe(0o700)
      const file = yield* Effect.promise(() => Fs.stat(`${registryDir(location)}/${PROFILE}.json`))
      expect(file.mode & 0o777).toBe(0o600)
      const socket = yield* Effect.promise(() => Fs.stat(entry.socket))
      expect(socket.isSocket()).toBe(true)
      expect(socket.mode & 0o077).toBe(0)
    }))

  it.live("fails a call in flight with ExtensionUnavailable when Chrome closes the port, then cleans up", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      const chrome = yield* startFakeChrome({ location })
      const entry = yield* chrome.entry
      const client = yield* connectBroker(entry.socket, entry.token)

      // Reading never finishes on the fake worker.
      const inFlight = yield* Effect.forkChild(client.call("read_pages", { tabIds: [TabId.make(1)] }))
      yield* waitFor(() => chrome.workerLog.includes("request read_pages"))
      yield* chrome.closePort

      const exit = yield* Fiber.await(inFlight)
      assert(Exit.isFailure(exit))
      expect(Exit.findErrorOption(exit)).toMatchObject({
        _tag: "Some",
        value: { _tag: "ExtensionUnavailable", message: CLOSED_MESSAGE }
      })

      // The host exits by itself and leaves nothing behind.
      const hostExit = yield* Fiber.await(chrome.host)
      expect(Exit.isSuccess(hostExit)).toBe(true)
      expect(yield* exists(entry.socket)).toBe(false)
      expect(yield* exists(`${registryDir(location)}/${PROFILE}.json`)).toBe(false)
    }))

  it.live("tells the worker to stop when the socket client hangs up mid-call", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      const chrome = yield* startFakeChrome({ location })
      const entry = yield* chrome.entry
      yield* Effect.scoped(Effect.gen(function*() {
        const client = yield* connectBroker(entry.socket, entry.token)
        yield* Effect.forkChild(client.call("read_pages", { tabIds: [TabId.make(1)] }))
        yield* waitFor(() => chrome.workerLog.includes("request read_pages"))
      }))
      // The client's connection closed: the broker interrupts the call, which reaches the worker.
      yield* waitFor(() => chrome.workerLog.includes("worker interrupted read_pages"))
      expect(chrome.workerLog).toContain("interrupt")

      // The broker keeps serving other clients.
      const again = yield* connectBroker(entry.socket, entry.token)
      expect((yield* again.call("list_tabs", {})).tabs).toHaveLength(1)
    }))

  it.live("refuses a caller that isn't the Wherefore extension, without writing to stdout", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      for (const args of [["chrome-extension://abcdefghijklmnopabcdefghijklmnop/"], [], ["--parent-window=0"]]) {
        const chrome = yield* startFakeChrome({ location, args })
        const exit = yield* Fiber.await(chrome.host)
        expect(Exit.findErrorOption(exit)).toMatchObject({ _tag: "Some", value: { _tag: "CallerRejected" } })
        expect(chrome.fromHost).toEqual([])
      }
      expect(yield* exists(registryDir(location))).toBe(false)
    }))

  it.live("accepts Chrome's Windows arguments (origin plus --parent-window)", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      const chrome = yield* startFakeChrome({
        location,
        args: ["chrome-extension://anpbbaiepneaddgoldgmapilgiflochg/", "--parent-window=0"]
      })
      yield* chrome.welcome
      yield* chrome.entry
    }))

  it.live("gives up without a valid Hello", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      const bad = yield* startFakeChrome({ location, hello: { _tag: "Hello", protocol: 1, profileId: "../x", extensionVersion: "1" } })
      const exit = yield* Fiber.await(bad.host)
      expect(Exit.findErrorOption(exit)).toMatchObject({ _tag: "Some", value: { _tag: "BrokerStartFailed" } })

      const closed = yield* startFakeChrome({ location, hello: null })
      yield* closed.closePort
      const closedExit = yield* Fiber.await(closed.host)
      expect(Exit.findErrorOption(closedExit)).toMatchObject({ _tag: "Some", value: { _tag: "BrokerStartFailed" } })
    }))

  it.live("answers a different protocol version with Welcome, then exits without serving", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      const chrome = yield* startFakeChrome({
        location,
        hello: { _tag: "Hello", protocol: NATIVE_PROTOCOL_VERSION + 1, profileId: PROFILE, extensionVersion: "9" }
      })
      expect(yield* chrome.welcome).toMatchObject({ protocol: NATIVE_PROTOCOL_VERSION })
      expect(Exit.isSuccess(yield* Fiber.await(chrome.host))).toBe(true)
      expect(yield* exists(`${registryDir(location)}/${PROFILE}.json`)).toBe(false)
    }))

  it.live("drops malformed frames and keeps going; dies on a corrupt stream", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      const chrome = yield* startFakeChrome({ location })
      yield* chrome.welcome
      const entry = yield* chrome.entry
      // Valid framing, not a message we know: dropped.
      const body = new TextEncoder().encode(JSON.stringify({ _tag: "Nonsense" }))
      const frame = new Uint8Array(4 + body.length)
      new DataView(frame.buffer).setUint32(0, body.length, true)
      frame.set(body, 4)
      yield* chrome.write(frame)
      const client = yield* connectBroker(entry.socket, entry.token)
      expect((yield* client.call("list_tabs", {})).tabs).toHaveLength(1)

      // Not JSON at all: the channel is corrupt, so the broker shuts down cleanly.
      yield* chrome.write(Uint8Array.of(3, 0, 0, 0, 0x7b, 0x7b, 0x7b))
      expect(Exit.isSuccess(yield* Fiber.await(chrome.host))).toBe(true)
      expect(yield* exists(entry.socket)).toBe(false)
    }))
})

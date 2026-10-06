/**
 * A fake Chrome for the broker: the host's stdin and stdout in memory (Effect's `Stdio`), with a
 * fake service worker on the other side of the "native port". The worker is a real
 * `effect/unstable/rpc` server of core's `TabToolRpcs`, like the extension's, so the broker is
 * tested against the same protocol it meets in Chrome.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import {
  EXTENSION_ORIGIN,
  HostToExtension,
  NATIVE_PROTOCOL_VERSION,
  type ProfileId,
  type RpcFromClient,
  TabToolRpcs,
  ToolError
} from "@wherefore/core"
import { type Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Schema, Scope, Sink, Stdio, Stream } from "effect"
import { runNativeHost } from "../src/broker/nativeHost.ts"
import type { RegistryEntry } from "../src/broker/registry.ts"
import { encodeFrame, makeFrameDecoder } from "../src/native/codec.ts"
import { type Location, platformOf, registryDir } from "../src/paths.ts"
import { RpcSerialization, RpcServer } from "../src/unstable.ts"

export const PROFILE = "abcdefghijklmnopqrstuvwxyz" as ProfileId

/** A fresh state directory, short so socket paths fit (macOS's tmpdir is long). */
export const tempLocation = Effect.acquireRelease(
  Effect.promise(() => Fs.mkdtemp(NodePath.join(process.platform === "win32" ? Os.tmpdir() : "/tmp", "wf-"))),
  (dir) => Effect.promise(() => Fs.rm(dir, { recursive: true, force: true }))
).pipe(Effect.map((dir): Location => ({ platform: platformOf(process.platform), home: dir, env: { WHEREFORE_HOME: dir } })))

/** What the fake worker does with each tool call. Defaults: list two tabs; reading never finishes. */
export interface WorkerBehavior {
  readonly list_tabs?: () => Effect.Effect<{ readonly tabs: ReadonlyArray<never> } | unknown, ToolError>
  readonly read_pages?: (payload: { readonly tabIds: ReadonlyArray<number> }) => Effect.Effect<unknown, ToolError>
}

export interface FakeChromeOptions {
  readonly location: Location
  readonly args?: ReadonlyArray<string>
  /** Sent as the first message; `null` sends nothing. */
  readonly hello?: unknown
  readonly listTabs?: Effect.Effect<unknown, ToolError>
}

export const sampleTabs = [
  { id: 1, window: 1, index: 0, title: "PR", url: "https://github.com/acme/api/pull/1", active: true }
]

export class FakeChrome {
  /** Everything the host wrote, decoded. */
  readonly fromHost: Array<unknown> = []
  /** Requests and interrupts the fake worker received. */
  readonly workerLog: Array<string> = []
  readonly welcomed: Deferred.Deferred<unknown>
  readonly host: Fiber.Fiber<void, unknown>
  private readonly stdin: Queue.Queue<Uint8Array, Cause.Done>
  readonly location: Location

  constructor(fields: {
    welcomed: Deferred.Deferred<unknown>
    host: Fiber.Fiber<void, unknown>
    stdin: Queue.Queue<Uint8Array, Cause.Done>
    location: Location
    fromHost: Array<unknown>
    workerLog: Array<string>
  }) {
    this.welcomed = fields.welcomed
    this.host = fields.host
    this.stdin = fields.stdin
    this.location = fields.location
    this.fromHost = fields.fromHost
    this.workerLog = fields.workerLog
  }

  /** The host's `Welcome`, once it arrives. */
  readonly welcome = Effect.suspend(() => Deferred.await(this.welcomed))

  /** Chrome closes the port: the host's stdin ends. */
  readonly closePort = Effect.suspend(() => Effect.asVoid(Queue.end(this.stdin)))

  /** Writes raw bytes to the host's stdin. */
  readonly write = (bytes: Uint8Array) => Effect.asVoid(Queue.offer(this.stdin, bytes))

  /** The broker's registry entry, once it is registered. */
  readonly entry = Effect.gen({ self: this }, function*() {
    const file = NodePath.join(registryDir(this.location), `${PROFILE}.json`)
    for (let i = 0; i < 300; i++) {
      const text = yield* Effect.promise(() => Fs.readFile(file, "utf8").catch(() => undefined))
      if (text !== undefined) return JSON.parse(text) as RegistryEntry
      yield* Effect.sleep("10 millis")
    }
    return yield* Effect.die(new Error("the broker never registered"))
  })
}

const frameOf = (message: unknown) => {
  const frame = encodeFrame(message, Number.MAX_SAFE_INTEGER)
  if (frame._tag === "Failure") throw new Error("unexpected")
  return frame.success
}

/** Starts a native host over in-memory stdio, with a fake worker answering its tool calls. */
export const startFakeChrome = (options: FakeChromeOptions): Effect.Effect<FakeChrome, never, Scope.Scope> =>
  Effect.gen(function*() {
    const stdin = yield* Queue.unbounded<Uint8Array, Cause.Done>()
    const toWorker = yield* Queue.unbounded<RpcFromClient>()
    const welcomed = yield* Deferred.make<unknown>()
    const fromHost: Array<unknown> = []
    const workerLog: Array<string> = []
    const decoder = makeFrameDecoder()
    const decodeHostFrame = Schema.decodeUnknownOption(HostToExtension)

    const stdout = Sink.forEach((chunk: string | Uint8Array) =>
      Effect.sync(() => {
        const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk
        const pushed = decoder.push(bytes)
        if (pushed._tag === "Failure") throw new Error(`the host wrote a bad frame: ${pushed.failure.message}`)
        for (const message of pushed.success) {
          fromHost.push(message)
          const frame = decodeHostFrame(message)
          if (Option.isNone(frame)) continue
          if (frame.value._tag === "Welcome") Deferred.doneUnsafe(welcomed, Exit.succeed(message))
          else {
            const rpc = frame.value.rpc
            workerLog.push(rpc._tag === "Request" ? `request ${rpc.tag}` : rpc._tag.toLowerCase())
            Queue.offerUnsafe(toWorker, rpc)
          }
        }
      })
    )

    // The fake service worker: an RPC server of TabToolRpcs whose one client is the native port.
    const protocol = yield* RpcServer.Protocol.make((writeRequest) =>
      Effect.gen(function*() {
        yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(toWorker), (message) =>
          writeRequest(0, message as never))))
        return {
          disconnects: yield* Queue.unbounded<number>(),
          send: (_clientId, response) => Effect.asVoid(Queue.offer(stdin, frameOf({ _tag: "FromWorker", rpc: response }))),
          end: () => Effect.void,
          clientIds: Effect.succeed(new Set([0])),
          initialMessage: Effect.succeedNone,
          supportsAck: true,
          supportsTransferables: false,
          supportsSpanPropagation: false,
          supportsNotifications: false,
          codecFor: RpcSerialization.json.codecFor
        }
      })
    )
    const handlers = TabToolRpcs.toLayer(TabToolRpcs.of({
      list_tabs: () =>
        (options.listTabs ?? Effect.succeed({ tabs: sampleTabs })) as Effect.Effect<never, ToolError>,
      read_pages: () =>
        Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => workerLog.push("worker interrupted read_pages")))),
      wake_and_read_pages: () => Effect.fail(new ToolError({ message: "asleep" }))
    }))
    yield* RpcServer.make(TabToolRpcs, { disableTracing: true }).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provide(handlers),
      Effect.forkScoped
    )

    const host = yield* runNativeHost({
      args: options.args ?? [EXTENSION_ORIGIN],
      location: options.location,
      pid: process.pid,
      companionVersion: "9.9.9",
      helloTimeout: "2 seconds"
    }).pipe(
      Effect.provide(Layer.succeed(Stdio.Stdio)(Stdio.make({
        args: Effect.succeed([]),
        stdin: Stream.fromQueue(stdin),
        stdout: () => stdout,
        stderr: () => Sink.drain
      }))),
      Effect.forkScoped
    )

    const hello = options.hello === undefined
      ? { _tag: "Hello", protocol: NATIVE_PROTOCOL_VERSION, profileId: PROFILE, extensionVersion: "1.2.3" }
      : options.hello
    if (hello !== null) yield* Queue.offer(stdin, frameOf(hello))

    return new FakeChrome({ welcomed, host, stdin, location: options.location, fromHost, workerLog })
  })

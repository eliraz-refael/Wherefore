/**
 * `wherefore native-host`: what Chrome launches when the extension calls `connectNative`, and the
 * profile's broker (architecture A3). Chrome starts one host process per profile's connection.
 *
 * 1. **Caller check.** Chrome passes the caller's origin as an argument. Anything but our pinned
 *    extension is refused before a byte is read or written.
 * 2. **Handshake.** The extension sends `Hello` (its stable profile id and version); the host
 *    answers `Welcome` (its version). A different protocol version gets a `Welcome` (so the
 *    extension can say which side to update) and the host exits.
 * 3. **Broker.** A local socket, user-only (registry.ts), named for the profile (paths.ts), speaks
 *    `effect/unstable/rpc` (`BrokerRpcs`, core broker.ts). Tool calls and companion-run calls are
 *    forwarded to the service worker over the native port (`WorkerLink`). Then the broker is
 *    registered, with a random access token every request must carry (`BROKER_TOKEN_HEADER`).
 * 4. **Shutdown.** When Chrome closes the port (stdin ends) or a signal arrives (the CLI
 *    interrupts this effect): calls in flight fail with `ExtensionUnavailable` and get a moment
 *    to reach their clients, then the registry entry and the socket are removed.
 *
 * Stdout is the Chrome channel and carries nothing but frames (NativePort.ts). Logs go to
 * stderr, and never include tool payloads (page text) or results.
 */
import {
  BROKER_TOKEN_HEADER,
  BrokerRpcs,
  BrokerUnauthorized,
  EXTENSION_ORIGIN,
  ExtensionToHost,
  NATIVE_PROTOCOL_VERSION,
  type NativeHello,
  type ProfileId,
  type RpcFromServer,
  ToolError
} from "@wherefore/core"
import { randomBytes, timingSafeEqual } from "node:crypto"
import * as Fs from "node:fs/promises"
import { Deferred, Duration, Effect, Layer, Queue, Schema, type Stdio, Stream } from "effect"
import { makeNativePort } from "../native/NativePort.ts"
import { isUnixSocketPathTooLong, type Location, socketPath } from "../paths.ts"
import { NodeSocketServer, RpcSerialization, RpcServer } from "../unstable.ts"
import { liveDeps, makeRegistry, type RegistryDeps, type RegistryEntry } from "./registry.ts"
import { makeWorkerLink, PORT_CLOSED, type WorkerLink } from "./WorkerLink.ts"

/** Chrome launched us for someone else (or a person ran the command by hand). */
export class CallerRejected extends Schema.TaggedError<CallerRejected>()("CallerRejected", {
  origin: Schema.String
}) {}

/** The broker couldn't start: no handshake, or no socket. */
export class BrokerStartFailed extends Schema.TaggedError<BrokerStartFailed>()("BrokerStartFailed", {
  message: Schema.String
}) {}

export interface NativeHostOptions {
  /** The arguments Chrome passed (after `native-host`): the caller's origin, and on Windows `--parent-window=<n>`. */
  readonly args: ReadonlyArray<string>
  readonly location: Location
  readonly pid: number
  readonly companionVersion: string
  /** How long to wait for `Hello`. */
  readonly helloTimeout?: Duration.Input
  /** Registry checks; the real process table and sockets by default. */
  readonly registry?: RegistryDeps
}

/** The caller's origin, from Chrome's arguments. */
export const callerOf = (args: ReadonlyArray<string>): string | undefined =>
  args.find((arg) => arg.startsWith("chrome-extension://"))

const decodeFrame = Schema.decodeUnknownExit(ExtensionToHost)

const messageOf = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause))

/** A new broker access token: 32 random bytes, base64url. */
export const makeToken = (): string => randomBytes(32).toString("base64url")

const UNAUTHORIZED = "This broker needs its access token (from its registry entry) on every request."

/** Whether a request's headers carry `token`, compared in constant time. */
export const carriesToken = (headers: Readonly<Record<string, string | undefined>>, token: string): boolean => {
  const given = Buffer.from(headers[BROKER_TOKEN_HEADER] ?? "", "utf8")
  const expected = Buffer.from(token, "utf8")
  return given.length === expected.length && timingSafeEqual(given, expected)
}

/** A request over Chrome's size limit, told to the model as a tool error. */
const tooLargeForTool = <A, E>(effect: Effect.Effect<A, E | { readonly _tag: "MessageTooLarge"; readonly bytes: number; readonly limit: number }>) =>
  Effect.catchIf(
    effect,
    (error): error is { readonly _tag: "MessageTooLarge"; readonly bytes: number; readonly limit: number } =>
      typeof error === "object" && error !== null && (error as { _tag?: unknown })._tag === "MessageTooLarge",
    (error) => Effect.fail(new ToolError({ message: `The request is ${error.bytes} bytes; Chrome accepts at most ${error.limit}.` }))
  ) as Effect.Effect<A, Exclude<E, { readonly _tag: "MessageTooLarge" }> | ToolError>

/** The broker's socket server: `BrokerRpcs` over ndjson, on a Unix socket or named pipe. */
const serveBroker = (
  socket: string,
  info: Omit<RegistryEntry, "socket" | "token">,
  token: string,
  link: WorkerLink,
  track: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E>
) => {
  const guard = <A, E>(headers: Readonly<Record<string, string | undefined>>, effect: Effect.Effect<A, E>) =>
    carriesToken(headers, token) ? effect : Effect.fail(new BrokerUnauthorized({ message: UNAUTHORIZED }))
  return RpcServer.layer(BrokerRpcs, { disableTracing: true, disableFatalDefects: true }).pipe(
    Layer.provide(BrokerRpcs.toLayer(BrokerRpcs.of({
      broker_info: (_, { headers }) => guard(headers, Effect.succeed(info)),
      list_tabs: (payload, { headers }) => guard(headers, track(tooLargeForTool(link.call("list_tabs", payload)))),
      read_pages: (payload, { headers }) => guard(headers, track(tooLargeForTool(link.call("read_pages", payload)))),
      wake_and_read_pages: (payload, { headers }) =>
        guard(headers, track(tooLargeForTool(link.call("wake_and_read_pages", payload)))),
      // A lease lasts as long as its run, so shutdown doesn't wait for it (it fails at once anyway).
      open_run: (payload, { headers }) =>
        carriesToken(headers, token) ? link.openRun(payload) : Stream.fail(new BrokerUnauthorized({ message: UNAUTHORIZED })),
      update_run: (payload, { headers }) => guard(headers, track(link.call("update_run", payload))),
      ask_panel: (payload, { headers }) => guard(headers, link.call("ask_panel", payload))
    }))),
    Layer.provide(RpcServer.layerProtocolSocketServer),
    Layer.provide(RpcSerialization.layerNdjson),
    Layer.provide(NodeSocketServer.layer({ path: socket }))
  )
}

export const runNativeHost = (options: NativeHostOptions): Effect.Effect<void, CallerRejected | BrokerStartFailed, Stdio.Stdio> =>
  Effect.scoped(Effect.gen(function*() {
    const caller = callerOf(options.args)
    if (caller !== EXTENSION_ORIGIN) return yield* new CallerRejected({ origin: caller ?? "(none)" })

    const port = yield* makeNativePort
    // However the host ends, frames already queued (a Welcome before an early exit) reach Chrome.
    yield* Effect.addFinalizer(() => port.close)
    const hello = yield* Deferred.make<NativeHello>()
    const ended = yield* Deferred.make<string>()
    const inbox = yield* Queue.unbounded<RpcFromServer | typeof PORT_CLOSED>()

    yield* port.incoming.pipe(
      Stream.runForEach((raw) => {
        const frame = decodeFrame(raw)
        if (frame._tag === "Failure") return Effect.logWarning("native host: dropped a malformed message from the extension")
        return frame.value._tag === "Hello"
          ? Effect.asVoid(Deferred.succeed(hello, frame.value))
          : Effect.asVoid(Queue.offer(inbox, frame.value.rpc))
      }),
      Effect.match({
        onSuccess: () => "Chrome closed the port",
        onFailure: (error) => `the port failed: ${error.message}`
      }),
      Effect.tap(() => Queue.offer(inbox, PORT_CLOSED)),
      Effect.flatMap((reason) => Deferred.succeed(ended, reason)),
      Effect.forkScoped
    )

    const greeting = yield* Deferred.await(hello).pipe(
      Effect.raceFirst(Effect.flatMap(Deferred.await(ended), (reason) =>
        Effect.fail(new BrokerStartFailed({ message: `no Hello from the extension: ${reason}` })))),
      Effect.timeoutOrElse({
        duration: options.helloTimeout ?? Duration.seconds(10),
        orElse: () => Effect.fail(new BrokerStartFailed({ message: "no Hello from the extension in time" }))
      })
    )
    yield* port.send({ _tag: "Welcome", protocol: NATIVE_PROTOCOL_VERSION, companionVersion: options.companionVersion }).pipe(
      Effect.orDie
    )
    if (greeting.protocol !== NATIVE_PROTOCOL_VERSION) {
      yield* Effect.logError(
        `native host: the extension speaks protocol ${greeting.protocol}, this companion ${NATIVE_PROTOCOL_VERSION}; update the older one`
      )
      return yield* port.close
    }

    const profileId: ProfileId = greeting.profileId
    const registry = makeRegistry(options.registry ?? liveDeps(options.location))
    const socket = socketPath(options.location, profileId, options.pid)
    if (isUnixSocketPathTooLong(options.location, socket)) {
      return yield* new BrokerStartFailed({
        message: `the socket path is too long for this OS (${socket}); set WHEREFORE_HOME to a shorter directory and run install again`
      })
    }
    yield* registry.ensureDir.pipe(Effect.mapError((error) => new BrokerStartFailed({ message: error.message })))
    // Clears entries left by brokers that crashed, so the registry only lists live ones.
    yield* registry.list.pipe(Effect.ignore)
    const unix = options.location.platform !== "win32"
    // A socket file at our path is a leftover of a dead process that had our pid.
    if (unix) yield* Effect.promise(() => Fs.rm(socket, { force: true }).catch(() => undefined))

    const link = yield* makeWorkerLink({ send: port.send, inbox })
    let inFlight = 0
    const track = <A, E>(effect: Effect.Effect<A, E>) =>
      Effect.acquireUseRelease(Effect.sync(() => inFlight++), () => effect, () => Effect.sync(() => inFlight--))

    const info = {
      profileId,
      extensionVersion: greeting.extensionVersion,
      companionVersion: options.companionVersion,
      protocol: NATIVE_PROTOCOL_VERSION,
      pid: options.pid,
      startedAt: Date.now()
    }
    const token = makeToken()
    yield* Layer.build(serveBroker(socket, info, token, link, track)).pipe(
      Effect.mapError((error) => new BrokerStartFailed({ message: `cannot listen on ${socket}: ${messageOf(error.reason.cause)}` }))
    )
    if (unix) yield* Effect.promise(() => Fs.chmod(socket, 0o600).catch(() => undefined))
    const entry: RegistryEntry = { ...info, socket, token }
    yield* Effect.acquireRelease(
      registry.register(entry).pipe(Effect.mapError((error) => new BrokerStartFailed({ message: error.message }))),
      () => registry.unregister(entry)
    )
    yield* Effect.logInfo(`native host: broker for profile ${profileId} on ${socket}`)

    const reason = yield* Deferred.await(ended)
    yield* Effect.logInfo(`native host: ${reason}; shutting down`)
    // Calls in flight just failed with ExtensionUnavailable: let those replies reach their clients.
    for (let i = 0; i < 200 && inFlight > 0; i++) yield* Effect.sleep(Duration.millis(10))
    yield* Effect.sleep(Duration.millis(100))
  }))


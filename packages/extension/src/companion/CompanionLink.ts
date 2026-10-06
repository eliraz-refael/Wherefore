/**
 * The worker's link to the companion (architecture A3): one native-messaging port, opened at
 * startup and kept open. Chrome keeps a worker alive while it has an open native port (Chrome
 * 105+), so with the companion installed the worker stays up; that is the accepted trade-off.
 *
 * On the port (core companion.ts): the worker says `Hello` with this profile's stable id (made
 * once, stored in `chrome.storage.local`), the host answers `Welcome`, and from then on the
 * worker serves `TabToolRpcs` to the host, over the same `TabTools` pages use. The host's broker
 * forwards calls from MCP and ACP agents.
 *
 * **Reconnect policy.**
 * - Host not found: status `NotInstalled`, and no retries. The worker tries again at its next
 *   start, or when a view calls `check_companion` (e.g. "Check again" after installing).
 * - Chrome forbids the host, or the protocol versions differ: `Unavailable`, no retries either;
 *   only reinstalling or updating fixes those.
 * - Anything else (the host exited, crashed, didn't answer): retry after 1 s, 2 s, 4 s, ... up to
 *   `MAX_RETRIES` attempts, then wait for the next start or `check_companion`. A connection that
 *   stayed up for `STABLE_AFTER` starts the count over, so a companion that restarts now and then
 *   reconnects at once, and one that crashes at start doesn't spin.
 *
 * The status is kept in `chrome.storage.session` (`companionStatusKey`), so every view can show it.
 */
import {
  type CompanionStatus,
  CompanionStatus as CompanionStatusSchema,
  HostToExtension,
  NATIVE_PROTOCOL_VERSION,
  type NativeWelcome,
  type ProfileId,
  profileIdFromBytes,
  type RpcFromClient,
  TabToolRpcs
} from "@wherefore/core"
import { Clock, Context, Deferred, Duration, Effect, Layer, Queue, Schema, Stream, SubscriptionRef } from "effect"
import { Store } from "../background/Store.ts"
import { TabTools } from "../background/TabTools.ts"
import { tabToolHandlers } from "../background/toolHandlers.ts"
import { ChromeApi } from "../chrome/ChromeApi.ts"
import { companionStatusKey } from "../store/keys.ts"
import { type RpcMessage, RpcSerialization, RpcServer } from "../unstable.ts"
import { NativeConnector, type NativePort } from "./NativeConnector.ts"

/** Chrome's `runtime.lastError` messages for a native port. */
export const NOT_FOUND = "Specified native messaging host not found."
export const FORBIDDEN = "Access to the specified native messaging host is forbidden."

/** How long the host has to answer `Hello`. */
export const WELCOME_TIMEOUT = Duration.seconds(10)
/** Failed attempts in a row before the worker stops retrying on its own. */
export const MAX_RETRIES = 6
/** A connection up at least this long resets the failure count. */
export const STABLE_AFTER = Duration.seconds(30)
/** The wait before retry `n` (from 1): 1 s, 2 s, 4 s, ... capped at a minute. */
export const retryDelay = (attempt: number): Duration.Duration =>
  Duration.millis(Math.min(1000 * 2 ** (attempt - 1), 60_000))

export class CompanionLink extends Context.Service<CompanionLink, {
  /** The link's current state. */
  readonly status: Effect.Effect<CompanionStatus>
  /**
   * Connects now unless connected or already connecting, and returns the state that attempt
   * reached (or the current one after a few seconds, if it hasn't settled).
   */
  readonly check: Effect.Effect<CompanionStatus>
}>()("@wherefore/extension/CompanionLink") {
  /** Starts the link with the worker and stops it (closing the port) with the worker. */
  static readonly layer: Layer.Layer<CompanionLink, never, NativeConnector | ChromeApi | Store | TabTools> = Layer.effect(
    CompanionLink
  )(Effect.gen(function*() {
    return yield* make
  }))
}

/** How one connection ended. */
type Outcome =
  | { readonly _tag: "NotInstalled" }
  | { readonly _tag: "Forbidden" }
  | { readonly _tag: "Incompatible"; readonly protocol: number }
  | { readonly _tag: "Lost"; readonly message: string; readonly upFor: number }

const encodeStatus = Schema.encodeSync(CompanionStatusSchema)
const decodeHostFrame = Schema.decodeUnknownExit(HostToExtension)

const describe = (welcomed: boolean, error: string | undefined): string =>
  welcomed
    ? `The companion disconnected${error === undefined ? "" : ` (${error})`}.`
    : `The companion didn't start${error === undefined ? "" : ` (${error})`}.`

const make = Effect.gen(function*() {
  const connector = yield* NativeConnector
  const chrome = yield* ChromeApi
  const store = yield* Store
  const tools = yield* TabTools
  const toolHandlers = TabToolRpcs.toLayer(tabToolHandlers(tools))
  const statusRef = yield* SubscriptionRef.make<CompanionStatus>({ _tag: "Checking" })
  const wakes = yield* Queue.unbounded<void>()

  const setStatus = (status: CompanionStatus) =>
    SubscriptionRef.set(statusRef, status).pipe(
      Effect.andThen(chrome.storage.session.set({ [companionStatusKey]: encodeStatus(status) })),
      Effect.catch((error) => Effect.logWarning(`companion: couldn't store the status: ${error.message}`))
    )

  const profileId = store.profileId(() => profileIdFromBytes(crypto.getRandomValues(new Uint8Array(16))))

  /** Serves `TabToolRpcs` to the host until `gone`. The port's only client is the broker. */
  const serve = (port: NativePort, requests: Queue.Dequeue<RpcFromClient>, gone: Deferred.Deferred<string | undefined>) =>
    Effect.gen(function*() {
      const protocol = yield* RpcServer.Protocol.make((writeRequest) =>
        Effect.gen(function*() {
          const disconnects = yield* Queue.unbounded<number>()
          yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(requests), (request) =>
            writeRequest(0, request as RpcMessage.FromClientEncoded))))
          yield* Effect.forkScoped(Effect.andThen(Deferred.await(gone), Queue.offer(disconnects, 0)))
          return {
            disconnects,
            send: (_clientId, response) =>
              Effect.sync(() => {
                try {
                  port.postMessage({ _tag: "FromWorker", rpc: response })
                } catch {
                  // The host is gone; `onDisconnect` follows.
                }
              }),
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
      // A handler that dies fails only its own call.
      yield* RpcServer.make(TabToolRpcs, { disableTracing: true, disableFatalDefects: true }).pipe(
        Effect.provideService(RpcServer.Protocol, protocol),
        Effect.provide(toolHandlers),
        Effect.forkScoped
      )
    })

  /** One connection, from `connectNative` until the port is gone. */
  const connectOnce = (id: ProfileId): Effect.Effect<Outcome> =>
    Effect.scoped(Effect.gen(function*() {
      const opened = yield* Effect.result(connector.connect)
      if (opened._tag === "Failure") return { _tag: "Lost", message: describe(false, opened.failure.message), upFor: 0 } as const
      const port = opened.success
      const welcome = yield* Deferred.make<NativeWelcome>()
      const gone = yield* Deferred.make<string | undefined>()
      const requests = yield* Queue.unbounded<RpcFromClient>()
      const onMessage = (message: unknown) => {
        const frame = decodeHostFrame(message)
        if (frame._tag === "Failure") {
          console.warn("companion: dropped a malformed message from the host")
          return
        }
        if (frame.value._tag === "Welcome") Deferred.doneUnsafe(welcome, Effect.succeed(frame.value))
        else Queue.offerUnsafe(requests, frame.value.rpc)
      }
      const onDisconnect = (error: string | undefined) => {
        Deferred.doneUnsafe(gone, Effect.succeed(error))
      }
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          port.onMessage.addListener(onMessage)
          port.onDisconnect.addListener(onDisconnect)
        }),
        () =>
          Effect.sync(() => {
            port.onMessage.removeListener(onMessage)
            port.onDisconnect.removeListener(onDisconnect)
            port.disconnect()
          })
      )
      try {
        port.postMessage({ _tag: "Hello", protocol: NATIVE_PROTOCOL_VERSION, profileId: id, extensionVersion: connector.extensionVersion })
      } catch {
        // The port died at once (host missing); `onDisconnect` says why.
      }

      const first = yield* Effect.raceFirst(
        Effect.map(Deferred.await(welcome), (value) => ({ _tag: "Welcome", value } as const)),
        Effect.map(Deferred.await(gone), (error) => ({ _tag: "Gone", error } as const))
      ).pipe(Effect.timeoutOption(WELCOME_TIMEOUT))
      if (first._tag === "None") return { _tag: "Lost", message: "The companion didn't answer.", upFor: 0 } as const
      if (first.value._tag === "Gone") {
        const error = first.value.error
        if (error === NOT_FOUND) return { _tag: "NotInstalled" } as const
        if (error === FORBIDDEN) return { _tag: "Forbidden" } as const
        return { _tag: "Lost", message: describe(false, error), upFor: 0 } as const
      }
      const greeting = first.value.value
      if (greeting.protocol !== NATIVE_PROTOCOL_VERSION) return { _tag: "Incompatible", protocol: greeting.protocol } as const

      const since = yield* Clock.currentTimeMillis
      yield* serve(port, requests, gone)
      yield* setStatus({ _tag: "Connected", profileId: id, companionVersion: greeting.companionVersion, since })
      const error = yield* Deferred.await(gone)
      return { _tag: "Lost", message: describe(true, error), upFor: (yield* Clock.currentTimeMillis) - since } as const
    }))

  const waitForWake = Effect.andThen(Queue.take(wakes), Queue.clear(wakes))

  const loop = Effect.gen(function*() {
    let failures = 0
    while (true) {
      yield* setStatus({ _tag: "Checking" })
      const id = yield* Effect.result(profileId)
      if (id._tag === "Failure") {
        yield* setStatus({ _tag: "Unavailable", reason: "failed", message: `This profile's id couldn't be read: ${id.failure.message}` })
        yield* waitForWake
        continue
      }
      const outcome = yield* connectOnce(id.success)
      switch (outcome._tag) {
        case "NotInstalled":
          failures = 0
          yield* setStatus({ _tag: "NotInstalled" })
          yield* waitForWake
          break
        case "Forbidden":
          failures = 0
          yield* setStatus({
            _tag: "Unavailable",
            reason: "forbidden",
            message: "Chrome won't let this extension start the companion. Run the companion's install command again."
          })
          yield* waitForWake
          break
        case "Incompatible":
          failures = 0
          yield* setStatus({
            _tag: "Unavailable",
            reason: "incompatible",
            message: outcome.protocol > NATIVE_PROTOCOL_VERSION
              ? "The companion is newer than this extension. Update the extension."
              : "The companion is older than this extension. Update the companion and run its install command again."
          })
          yield* waitForWake
          break
        case "Lost": {
          if (outcome.upFor >= Duration.toMillis(STABLE_AFTER)) failures = 0
          failures++
          if (failures > MAX_RETRIES) {
            failures = 0
            yield* setStatus({ _tag: "Unavailable", reason: "failed", message: outcome.message })
            yield* waitForWake
            break
          }
          const delay = retryDelay(failures)
          const retryAt = (yield* Clock.currentTimeMillis) + Duration.toMillis(delay)
          yield* setStatus({ _tag: "Unavailable", reason: "failed", message: outcome.message, retryAt })
          yield* Effect.raceFirst(Effect.sleep(delay), waitForWake)
          break
        }
      }
    }
  })

  yield* Effect.forkScoped(loop)

  const check = Effect.gen(function*() {
    const current = yield* SubscriptionRef.get(statusRef)
    if (current._tag === "Connected" || current._tag === "Checking") return current
    yield* Queue.offer(wakes, undefined)
    const settled = yield* SubscriptionRef.changes(statusRef).pipe(
      Stream.filter((status) => status !== current && status._tag !== "Checking"),
      Stream.runHead,
      Effect.timeoutOption(Duration.seconds(5))
    )
    return settled._tag === "Some" && settled.value._tag === "Some" ? settled.value.value : yield* SubscriptionRef.get(statusRef)
  })

  return CompanionLink.of({ status: SubscriptionRef.get(statusRef), check })
})

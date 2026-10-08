/**
 * A fake Chrome for the broker: the host's stdin and stdout in memory (Effect's `Stdio`), with a
 * fake service worker on the other side of the "native port". The worker is a real
 * `effect/unstable/rpc` server of core's `CompanionWorkerRpcs`, like the extension's, so the broker
 * is tested against the same protocol it meets in Chrome; and a real client of the broker's
 * `AgentRpcs` (ACP mode), as the extension's `CompanionLink` is.
 */
import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as NodePath from "node:path"
import {
  type AgentEvent,
  type AgentPrefs,
  AgentRpcs,
  type AgentRunError,
  type AskPanelError,
  CompanionWorkerRpcs,
  EXTENSION_ORIGIN,
  HostToExtension,
  NATIVE_PROTOCOL_VERSION,
  type ProfileId,
  type Question,
  QuestionsUnavailable,
  type Run,
  type RunAlreadyActive,
  RunNotActive,
  type RunId,
  type RunSignal,
  type RpcFromClient,
  type RpcFromServer,
  ToolError
} from "@wherefore/core"
import { type Cause, Deferred, Effect, Exit, Fiber, Layer, Option, Queue, Schema, Scope, Sink, Stdio, Stream } from "effect"
import { runNativeHost } from "../src/broker/nativeHost.ts"
import type { RegistryEntry } from "../src/broker/registry.ts"
import { encodeFrame, makeFrameDecoder } from "../src/native/codec.ts"
import { type Location, platformOf, registryDir } from "../src/paths.ts"
import {
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodePath as NodePathLayer,
  RpcClient,
  type RpcClientError,
  type RpcMessage,
  RpcSerialization,
  RpcServer
} from "../src/unstable.ts"

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
  /** The profile the extension says it is (default `PROFILE`). */
  readonly profile?: ProfileId
  readonly listTabs?: Effect.Effect<unknown, ToolError>
  /** What `read_pages` does; by default it never finishes. */
  readonly readPages?: (payload: { readonly tabIds: ReadonlyArray<number> }) => Effect.Effect<unknown, ToolError>
  /** What `ask_panel` does; by default no panel is open. */
  readonly askPanel?: (payload: {
    readonly runId: string
    readonly askId: string
    readonly questions: ReadonlyArray<Question>
  }) => Effect.Effect<{ readonly answers: ReadonlyArray<{ readonly id: string; readonly answer: string }> }, AskPanelError>
  /** Another run is going in this profile: `open_run` fails with this. */
  readonly busy?: RunAlreadyActive
  /** What the agent's MCP server runs (ACP mode). */
  readonly mcp?: { readonly node: string; readonly cli: string }
  /** The agent's environment (ACP mode). */
  readonly env?: Readonly<Record<string, string | undefined>>
}

/** The worker's client of the broker's `AgentRpcs`. */
export type AgentClient = (
  tag: "start_agent",
  payload: { readonly runId: RunId; readonly command: string; readonly prefs: AgentPrefs }
) => Stream.Stream<AgentEvent, AgentRunError | RpcClientError.RpcClientError>

export const NO_PANEL = "The Wherefore side panel isn't open in this Chrome profile, so the user can't see the questions."

/** The day the fake worker reports with every tab list, as the real one does (core `localDay`). */
export const FAKE_TODAY = "2026-10-08 (Thu)"

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
  readonly profile: ProfileId
  /** The runs the fake worker stored (`update_run`), latest version of each. */
  readonly runs: Map<string, Run>
  /** Open leases (`open_run`), by run id. */
  readonly leases: Map<string, Queue.Queue<RunSignal, Cause.Done>>
  /** Runs the panel started (ACP mode): only these can be attached to with `open_run({ mode: "acp" })`. */
  readonly panelRuns: Set<string>
  /** The worker's client of the broker's `AgentRpcs`. */
  readonly agentClient: AgentClient

  constructor(fields: {
    welcomed: Deferred.Deferred<unknown>
    host: Fiber.Fiber<void, unknown>
    stdin: Queue.Queue<Uint8Array, Cause.Done>
    location: Location
    fromHost: Array<unknown>
    workerLog: Array<string>
    profile: ProfileId
    runs: Map<string, Run>
    leases: Map<string, Queue.Queue<RunSignal, Cause.Done>>
    panelRuns: Set<string>
    agentClient: AgentClient
  }) {
    this.welcomed = fields.welcomed
    this.host = fields.host
    this.stdin = fields.stdin
    this.location = fields.location
    this.fromHost = fields.fromHost
    this.workerLog = fields.workerLog
    this.profile = fields.profile
    this.runs = fields.runs
    this.leases = fields.leases
    this.panelRuns = fields.panelRuns
    this.agentClient = fields.agentClient
  }

  /**
   * The panel presses Tidy up in ACP mode: the worker has created run `runId` (so the agent's MCP
   * session may attach to it) and asks the broker to start the agent.
   */
  readonly startAgent = (runId: string, command: string, prefs: AgentPrefs = {}) => {
    this.panelRuns.add(runId)
    return this.agentClient("start_agent", { runId: runId as RunId, command, prefs })
  }

  /** The user presses Stop in this profile's panel. */
  readonly stop = (runId: string) =>
    Effect.suspend(() => {
      const lease = this.leases.get(runId)
      if (lease === undefined) return Effect.die(new Error(`no lease for ${runId}`))
      this.leases.delete(runId)
      const run = this.runs.get(runId)
      if (run !== undefined) this.runs.set(runId, { ...run, status: "cancelled", finishedAt: run.startedAt })
      return Effect.andThen(Queue.offer(lease, { _tag: "Stopped", message: "The user stopped this tidy-up in the Wherefore side panel." }), Queue.end(lease))
    })

  /** The host's `Welcome`, once it arrives. */
  readonly welcome = Effect.suspend(() => Deferred.await(this.welcomed))

  /** Chrome closes the port: the host's stdin ends. */
  readonly closePort = Effect.suspend(() => Effect.asVoid(Queue.end(this.stdin)))

  /** Writes raw bytes to the host's stdin. */
  readonly write = (bytes: Uint8Array) => Effect.asVoid(Queue.offer(this.stdin, bytes))

  /** The broker's registry entry, once it is registered. */
  readonly entry = Effect.gen({ self: this }, function*() {
    const file = NodePath.join(registryDir(this.location), `${this.profile}.json`)
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
    const profile = options.profile ?? PROFILE
    const runs = new Map<string, Run>()
    const leases = new Map<string, Queue.Queue<RunSignal, Cause.Done>>()
    const panelRuns = new Set<string>()
    const fromBroker = yield* Queue.unbounded<RpcFromServer>()
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
          else if (frame.value._tag === "FromBroker") Queue.offerUnsafe(fromBroker, frame.value.rpc)
          else {
            const rpc = frame.value.rpc
            workerLog.push(rpc._tag === "Request" ? `request ${rpc.tag}` : rpc._tag.toLowerCase())
            Queue.offerUnsafe(toWorker, rpc)
          }
        }
      })
    )

    // The fake service worker: an RPC server of CompanionWorkerRpcs whose one client is the native port.
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
    const handlers = CompanionWorkerRpcs.toLayer(CompanionWorkerRpcs.of({
      list_tabs: () =>
        (options.listTabs ?? Effect.succeed({ tabs: sampleTabs })).pipe(
          Effect.map((listed) => ({ today: FAKE_TODAY, ...(listed as object) }))
        ) as Effect.Effect<never, ToolError>,
      read_pages: (payload) =>
        options.readPages !== undefined
          ? options.readPages(payload) as Effect.Effect<never, ToolError>
          : Effect.never.pipe(Effect.onInterrupt(() => Effect.sync(() => workerLog.push("worker interrupted read_pages")))),
      wake_and_read_pages: () => Effect.fail(new ToolError({ message: "asleep" })),
      open_run: ({ id, mode }) =>
        Stream.unwrap(Effect.gen(function*() {
          if (options.busy !== undefined) return yield* Effect.fail(options.busy)
          // Like the worker: an ACP session attaches only to a run the panel started.
          if (mode === "acp" && !panelRuns.has(id)) {
            return yield* Effect.fail(new RunNotActive({ runId: id, message: "The side panel didn't start this tidy-up." }))
          }
          const signals = yield* Queue.unbounded<RunSignal, Cause.Done>()
          leases.set(id, signals)
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              const run = runs.get(id)
              // Like the worker: a run still running when its lease ends was interrupted.
              if (leases.get(id) === signals && run?.status === "running") {
                runs.set(id, { ...run, status: "interrupted", finishedAt: run.startedAt, error: { reason: "interrupted", message: "gone" } })
              }
              if (leases.get(id) === signals) leases.delete(id)
              workerLog.push(`lease ended ${id}`)
            })
          )
          yield* Queue.offer(signals, { _tag: "Opened" })
          return Stream.fromQueue(signals)
        })),
      update_run: ({ run }) =>
        Effect.suspend(() => {
          if (!leases.has(run.id)) return Effect.fail(new RunNotActive({ runId: run.id, message: "not leased" }))
          runs.set(run.id, run)
          return Effect.void
        }),
      ask_panel: (payload) =>
        options.askPanel !== undefined
          ? options.askPanel(payload) as Effect.Effect<never, AskPanelError>
          : Effect.fail(new QuestionsUnavailable({ message: NO_PANEL }))
    }))
    yield* RpcServer.make(CompanionWorkerRpcs, { disableTracing: true }).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provide(handlers),
      Effect.forkScoped
    )

    // The worker's client of the broker (ACP mode): `ToBroker` frames out, `FromBroker` frames in.
    const agentProtocol = yield* RpcClient.Protocol.make((writeResponse, clientIds) =>
      Effect.gen(function*() {
        yield* Effect.forkScoped(Effect.forever(Effect.flatMap(Queue.take(fromBroker), (reply) =>
          Effect.forEach(clientIds, (clientId) => writeResponse(clientId, reply as RpcMessage.FromServerEncoded), { discard: true }))))
        return {
          send: (_clientId, request) => Effect.asVoid(Queue.offer(stdin, frameOf({ _tag: "ToBroker", rpc: request }))),
          supportsAck: true,
          supportsTransferables: false,
          codecFor: RpcSerialization.json.codecFor
        }
      })
    )
    const agentClient: AgentClient = yield* RpcClient.make(AgentRpcs, { flatten: true, disableTracing: true }).pipe(
      Effect.provideService(RpcClient.Protocol, agentProtocol)
    )

    const host = yield* runNativeHost({
      args: options.args ?? [EXTENSION_ORIGIN],
      location: options.location,
      pid: process.pid,
      companionVersion: "9.9.9",
      helloTimeout: "2 seconds",
      ...(options.mcp === undefined ? {} : { mcp: options.mcp }),
      ...(options.env === undefined ? {} : { env: options.env })
    }).pipe(
      Effect.provide(NodeChildProcessSpawner.layer.pipe(Layer.provide(Layer.mergeAll(NodeFileSystem.layer, NodePathLayer.layer)))),
      Effect.provide(Layer.succeed(Stdio.Stdio)(Stdio.make({
        args: Effect.succeed([]),
        stdin: Stream.fromQueue(stdin),
        stdout: () => stdout,
        stderr: () => Sink.drain
      }))),
      Effect.forkScoped
    )

    const hello = options.hello === undefined
      ? { _tag: "Hello", protocol: NATIVE_PROTOCOL_VERSION, profileId: profile, extensionVersion: "1.2.3" }
      : options.hello
    if (hello !== null) yield* Queue.offer(stdin, frameOf(hello))

    return new FakeChrome({
      welcomed,
      host,
      stdin,
      location: options.location,
      fromHost,
      workerLog,
      profile,
      runs,
      leases,
      panelRuns,
      agentClient
    })
  })

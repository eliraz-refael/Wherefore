/**
 * `AgentProcess`: the ACP agent as a child process of the broker (architecture A1: the unstable
 * `effect/unstable/process` module stays behind this one service).
 *
 * - Spawned with the companion's own environment, so the agent finds what the install wrapper
 *   baked in: `PATH`, `CLAUDE_CONFIG_DIR` (where the user's Claude Code login lives), proxies.
 * - On POSIX it runs in its own process group, and on Windows it is killed with `taskkill /T`, so
 *   closing the scope ends the whole tree (`npx`, the Node it starts, and Claude Code under it):
 *   SIGTERM first, then SIGKILL after `KILL_GRACE`. Nothing is left behind.
 * - Its stderr is kept, the last few KB only, to explain a failed start. It is never logged: the
 *   agent may write page text there.
 */
import { AgentFailed, AgentNotFound, agentFailedMessage, agentNotFoundMessage } from "@wherefore/core"
import { Cause, Context, Deferred, Duration, Effect, Exit, Layer, Queue, Stream, type Scope } from "effect"
import type { Platform } from "../paths.ts"
import { ChildProcess, ChildProcessSpawner } from "../unstable.ts"
import { spawnPlan } from "./command.ts"

/** How long the agent's tree gets after SIGTERM before SIGKILL. */
export const KILL_GRACE = Duration.seconds(3)

/** How much of the agent's stderr is kept. */
const STDERR_KEEP = 4096

export interface AgentProcess {
  readonly pid: number
  /** The agent's stdin (ACP messages to it). */
  readonly input: WritableStream<Uint8Array>
  /** The agent's stdout (ACP messages from it). */
  readonly output: ReadableStream<Uint8Array>
  /** Completes when the process exits: its exit code, or null when a signal ended it. */
  readonly exited: Effect.Effect<number | null>
  /** The end of what it wrote to stderr. For messages about a failed start only; never logged. */
  readonly stderrTail: () => string
}

export interface SpawnOptions {
  readonly platform: Platform
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
}

export class AgentProcesses extends Context.Service<AgentProcesses, {
  /** Starts `command`. The process tree is ended when the scope closes. */
  readonly spawn: (command: string, options: SpawnOptions) => Effect.Effect<AgentProcess, AgentNotFound | AgentFailed, Scope.Scope>
}>()("@wherefore/companion/AgentProcesses") {
  /** Real processes, through the platform's spawner. */
  static readonly layer: Layer.Layer<AgentProcesses, never, ChildProcessSpawner.ChildProcessSpawner> = Layer.effect(AgentProcesses)(
    Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      return AgentProcesses.of({ spawn: spawnWith(spawner) })
    })
  )
}

const spawnWith = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
(command: string, options: SpawnOptions): Effect.Effect<AgentProcess, AgentNotFound | AgentFailed, Scope.Scope> =>
  Effect.gen(function*() {
    const plan = spawnPlan(options.platform, command)
    if (plan === undefined) return yield* new AgentNotFound({ command, message: agentNotFoundMessage(command) })
    const handle = yield* spawner.spawn(
      ChildProcess.make(plan.program, plan.args, {
        cwd: options.cwd,
        env: { ...options.env },
        extendEnv: false,
        shell: plan.shell,
        killSignal: "SIGTERM",
        forceKillAfter: KILL_GRACE,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe"
      })
    ).pipe(
      Effect.mapError((error) =>
        // ENOENT: no such program on PATH.
        error.reason._tag === "NotFound"
          ? new AgentNotFound({ command, message: agentNotFoundMessage(command) })
          : new AgentFailed({ message: agentFailedMessage(command, `it couldn't be started (${error.message}).`) })
      )
    )

    // stdin: a queue the ACP writer fills, drained into the process.
    const toAgent = yield* Queue.unbounded<Uint8Array, Cause.Done>()
    yield* Stream.fromQueue(toAgent).pipe(Stream.run(handle.stdin), Effect.ignore, Effect.forkScoped)
    const input = new WritableStream<Uint8Array>({
      write: (chunk) => {
        Queue.offerUnsafe(toAgent, chunk)
      },
      close: () => {
        Queue.endUnsafe(toAgent)
      },
      abort: () => {
        Queue.endUnsafe(toAgent)
      }
    })

    let stderr = ""
    yield* handle.stderr.pipe(
      Stream.decodeText,
      Stream.runForEach((text) =>
        Effect.sync(() => {
          stderr = (stderr + text).slice(-STDERR_KEEP)
        })
      ),
      Effect.ignore,
      Effect.forkScoped
    )

    const exit = yield* Deferred.make<number | null>()
    yield* handle.exitCode.pipe(
      Effect.exit,
      Effect.flatMap((result) => Deferred.succeed(exit, Exit.isSuccess(result) ? Number(result.value) : null)),
      Effect.forkScoped
    )

    return {
      pid: Number(handle.pid),
      input,
      output: Stream.toReadableStream(handle.stdout.pipe(Stream.catchCause(() => Stream.empty))),
      exited: Deferred.await(exit),
      stderrTail: () => stderr
    } satisfies AgentProcess
  })

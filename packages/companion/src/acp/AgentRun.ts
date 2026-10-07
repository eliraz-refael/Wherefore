/**
 * One ACP run, in the broker (architecture A2, A4; M2 PR C): what `start_agent` does when the
 * side panel presses Tidy up.
 *
 * 1. Spawn the agent's command (`AgentProcesses`) in a private working directory, with the
 *    companion's environment.
 * 2. ACP `initialize`, then `session/new` with one MCP server: this CLI as
 *    `wherefore mcp --profile <profile> --run <run id>`, so the agent reaches only this profile's
 *    tabs and its tidy-up is the run the panel created. Claude Code (`claude-agent-acp`) is also
 *    asked, through `_meta`, for no built-in tools, only this MCP server, and no bypass mode.
 * 3. Put the permission mode back to "default" if needed, then apply the user's model and effort
 *    preferences, each only if the agent offers it (`prefFor`), in the agent's order (choosing a
 *    model can change which efforts exist).
 * 4. Send core's kickoff (the triage prompt; ACP has no separate system prompt) and wait for the
 *    turn to end. The tool steps and the result reach the run through the MCP server.
 *
 * The stream reports `Started`, `Settings`, `Working`, `Usage` and finally `Finished`; it fails
 * with a typed `AgentRunError` (policy.ts says which). Interrupting it (Stop, or the worker going
 * away) cancels the turn, then ends the agent's process tree; so does the stream ending.
 *
 * Nothing the agent says is logged: its messages, thoughts and stderr may hold page text.
 */
import {
  type AgentEvent,
  AgentFailed,
  type AgentPrefs,
  type AgentRunError,
  type AgentSetting,
  type AgentUsage,
  agentFailedMessage,
  KICKOFF,
  prefFor,
  type ProfileId,
  type RunId
} from "@wherefore/core"
import * as Fs from "node:fs/promises"
import { Cause, Deferred, Duration, Effect, Queue, Stream } from "effect"
import { type Location, pathFor, stateDir } from "../paths.ts"
import { type AcpRequestFailed, connectAcp, type SessionConfigOption } from "./AcpConnection.ts"
import { AgentProcesses } from "./AgentProcess.ts"
import { agentMcpServer } from "./command.ts"
import { classifyFailure, currentMode, decidePermission, flattenSettings, modePlan, type Phase } from "./policy.ts"

/** How long the agent has to answer `initialize` (the first `npx` run downloads it). */
export const START_TIMEOUT = Duration.minutes(2)
/** How long `session/new` and each settings change may take. */
export const SETUP_TIMEOUT = Duration.minutes(1)
/**
 * How long the agent may go without a sign of life (a session update, a permission request) while
 * it works, before the run fails: a hung agent mustn't hold the profile's one run forever.
 */
export const IDLE_TIMEOUT = Duration.minutes(10)

export interface AgentRunOptions {
  readonly runId: RunId
  readonly command: string
  readonly prefs: AgentPrefs
  readonly profile: ProfileId
  readonly location: Location
  readonly companionVersion: string
  /** The Node and CLI that run `wherefore mcp` for the agent. */
  readonly mcp: { readonly node: string; readonly cli: string }
  /** The agent's environment: the companion's own. */
  readonly env: Readonly<Record<string, string | undefined>>
}

/** The agent's working directory: an empty, user-only directory in the state directory. */
export const agentDir = (location: Location): string => pathFor(location.platform).join(stateDir(location), "agent")

/** What `_meta` asks of Claude Code for this session; other agents ignore it. */
export const CLAUDE_CODE_SESSION_META = {
  disableBuiltInTools: true,
  claudeCode: { options: { tools: [], strictMcpConfig: true, allowDangerouslySkipPermissions: false } }
} as const

const zeroUsage: AgentUsage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

/** Runs the agent for one tidy-up; see the module comment. */
export const runAgent = (options: AgentRunOptions): Stream.Stream<AgentEvent, AgentRunError, AgentProcesses> =>
  Stream.callback<AgentEvent, AgentRunError, AgentProcesses>((queue) =>
    // Its own scope, closed when this fiber ends: when the stream is interrupted, the turn is
    // cancelled (the prompt's interruption) before the process tree is ended (this scope).
    Effect.scoped(Effect.gen(function*() {
      const { command } = options
      const processes = yield* AgentProcesses
      const cwd = agentDir(options.location)
      yield* Effect.tryPromise({
        try: () => Fs.mkdir(cwd, { recursive: true, mode: 0o700 }),
        catch: (error) => new AgentFailed({ message: agentFailedMessage(command, `its folder couldn't be made (${String(error)}).`) })
      })

      const agent = yield* processes.spawn(command, { platform: options.location.platform, cwd, env: options.env })
      yield* Effect.logInfo(`acp: started the agent for run ${options.runId} (pid ${agent.pid})`)
      const exit = yield* Deferred.make<{ readonly code: number | null }>()
      yield* agent.exited.pipe(Effect.flatMap((code) => Deferred.succeed(exit, { code })), Effect.forkScoped)

      let phase: Phase = "starting"
      let usage = zeroUsage
      let refused = 0
      let lastSign = Date.now()
      const emit = (event: AgentEvent) => {
        Queue.offerUnsafe(queue, event)
      }

      const acp = yield* connectAcp(agent, {
        onUpdate: ({ update }) => {
          lastSign = Date.now()
          if (update.sessionUpdate === "usage_update" && update.cost !== undefined && update.cost !== null) {
            if (update.cost.currency.toUpperCase() === "USD" && Number.isFinite(update.cost.amount) && update.cost.amount >= 0) {
              usage = { ...usage, costUsd: update.cost.amount }
              emit({ _tag: "Usage", usage })
            }
          }
        },
        onPermission: (request) => {
          lastSign = Date.now()
          const decision = decidePermission(request)
          if (!decision.allowed) refused++
          return decision.response
        }
      })
      yield* Effect.addFinalizer(() =>
        refused === 0 ? Effect.void : Effect.logInfo(`acp: refused ${refused} request(s) to use the agent's own tools`)
      )

      /** The failure for a request that failed (or the process that exited meanwhile). */
      const failed = (request: AcpRequestFailed | undefined) =>
        Effect.gen(function*() {
          // A closed connection usually means the process is exiting: wait a moment for its code.
          const exited = yield* Deferred.await(exit).pipe(Effect.timeoutOption(Duration.millis(1500)))
          return classifyFailure({
            command,
            phase,
            request: request === undefined || (request.code === undefined && exited._tag === "Some") ? undefined : request,
            exit: exited._tag === "Some" ? exited.value : undefined,
            stderr: phase === "starting" ? agent.stderrTail() : ""
          })
        })

      /** One protocol step: fails with the run's error when the request fails or the process exits first. */
      const step = <A>(effect: Effect.Effect<A, AcpRequestFailed>, timeout?: { readonly after: Duration.Duration; readonly what: string }) => {
        const raced = effect.pipe(
          Effect.raceFirst(Effect.flatMap(Deferred.await(exit), () => Effect.fail(undefined)))
        )
        const timed = timeout === undefined ? raced : raced.pipe(
          Effect.timeoutOrElse({
            duration: timeout.after,
            orElse: () => Effect.fail(new AgentFailed({ message: agentFailedMessage(command, timeout.what) }))
          })
        )
        return timed.pipe(
          Effect.catch((error: AcpRequestFailed | AgentFailed | undefined) =>
            error !== undefined && error._tag === "AgentFailed" ? Effect.fail(error) : Effect.flatMap(failed(error), Effect.fail)
          )
        )
      }

      const init = yield* step(acp.initialize({ name: "wherefore", version: options.companionVersion }), {
        after: START_TIMEOUT,
        what: `it didn't answer within ${Duration.toMinutes(START_TIMEOUT)} minutes.`
      })
      const name = init.agentInfo?.name
      emit(name === undefined || name === "" ? { _tag: "Started" } : { _tag: "Started", agent: name })

      const session = yield* step(
        acp.newSession({
          cwd,
          mcpServers: [agentMcpServer({ ...options.mcp, profile: options.profile, runId: options.runId, env: options.env })],
          _meta: CLAUDE_CODE_SESSION_META
        }),
        { after: SETUP_TIMEOUT, what: "it didn't open a session in time." }
      )
      const sessionId = session.sessionId

      /** Changes one setting; returns the agent's options after it, or the old ones if it refused. */
      const change = (current: ReadonlyArray<SessionConfigOption>, id: string, value: string | boolean) =>
        step(acp.setConfigOption(sessionId, id, value), { after: SETUP_TIMEOUT, what: "it didn't answer a settings change in time." }).pipe(
          Effect.catchIf(
            (error): error is AgentFailed => error._tag === "AgentFailed",
            () => Effect.as(Effect.logWarning(`acp: the agent refused a value for its setting ${id}`), current)
          )
        )

      let configOptions: ReadonlyArray<SessionConfigOption> = session.configOptions ?? []
      // The permission mode must ask for every tool, or the guard never sees them: fail closed.
      const notDefault = (mode: string) =>
        new AgentFailed({
          message: agentFailedMessage(
            command,
            `its permission mode ("${mode}") skips permission requests, and it couldn't be set back to "default". Check the default mode in its settings.`
          )
        })
      const plan = modePlan(configOptions, session.modes)
      if (plan._tag === "Refuse") return yield* Effect.fail(notDefault(plan.mode))
      if (plan._tag === "SetOption") {
        configOptions = yield* step(acp.setConfigOption(sessionId, plan.id, "default"), {
          after: SETUP_TIMEOUT,
          what: "it didn't answer a settings change in time."
        }).pipe(Effect.mapError((error) => (error._tag === "AgentFailed" ? notDefault(currentMode(configOptions) ?? "?") : error)))
        const now = currentMode(configOptions)
        if (now !== undefined && now !== "default") return yield* Effect.fail(notDefault(now))
      }
      if (plan._tag === "SetMode") {
        yield* step(acp.setMode(sessionId, "default"), { after: SETUP_TIMEOUT, what: "it didn't answer a settings change in time." }).pipe(
          Effect.mapError((error) => (error._tag === "AgentFailed" ? notDefault(session.modes?.currentModeId ?? "?") : error))
        )
      }
      for (const id of flattenSettings(configOptions).map((setting) => setting.id)) {
        const setting: AgentSetting | undefined = flattenSettings(configOptions).find((candidate) => candidate.id === id)
        const wanted = setting === undefined ? undefined : prefFor(setting, options.prefs)
        if (wanted !== undefined) configOptions = yield* change(configOptions, id, wanted)
      }
      emit({ _tag: "Settings", settings: flattenSettings(configOptions) })

      emit({ _tag: "Working" })
      phase = "working"
      lastSign = Date.now()
      const idle = Effect.gen(function*() {
        while (Date.now() - lastSign < Duration.toMillis(IDLE_TIMEOUT)) yield* Effect.sleep(Duration.seconds(15))
        return yield* new AgentFailed({
          message: agentFailedMessage(command, `it stopped responding for ${Duration.toMinutes(IDLE_TIMEOUT)} minutes.`, true)
        })
      })
      const response = yield* step(acp.prompt(sessionId, KICKOFF)).pipe(Effect.raceFirst(idle))
      if (response.usage !== undefined && response.usage !== null) {
        usage = {
          ...usage,
          inputTokens: usage.inputTokens + response.usage.inputTokens,
          outputTokens: usage.outputTokens + response.usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens + (response.usage.cachedReadTokens ?? 0),
          cacheWriteTokens: usage.cacheWriteTokens + (response.usage.cachedWriteTokens ?? 0)
        }
        emit({ _tag: "Usage", usage })
      }
      emit({ _tag: "Finished", stopReason: response.stopReason })
      yield* Effect.logInfo(`acp: the agent ended its turn for run ${options.runId} (${response.stopReason})`)
      yield* Queue.end(queue)
    })).pipe(
      // A failure of this effect doesn't end the stream by itself: it goes into the queue.
      Effect.catchCause((cause) =>
        Effect.andThen(
          Cause.hasInterruptsOnly(cause)
            ? Effect.void
            : Effect.logWarning(`acp: run ${options.runId} ${Cause.hasFails(cause) ? "failed" : "crashed"}`),
          Queue.failCause(queue, cause)
        )
      )
    )
  )

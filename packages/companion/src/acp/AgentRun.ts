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
import { classifyFailure, decidePermission, defaultModeChange, flattenSettings, type Phase } from "./policy.ts"

/** How long the agent has to answer `initialize` (the first `npx` run downloads it). */
export const START_TIMEOUT = Duration.minutes(2)
/** How long `session/new` and each settings change may take. */
export const SETUP_TIMEOUT = Duration.minutes(1)

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
    Effect.gen(function*() {
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
      const emit = (event: AgentEvent) => {
        Queue.offerUnsafe(queue, event)
      }

      const acp = yield* connectAcp(agent, {
        onUpdate: ({ update }) => {
          if (update.sessionUpdate === "usage_update" && update.cost !== undefined && update.cost !== null) {
            if (update.cost.currency.toUpperCase() === "USD" && Number.isFinite(update.cost.amount) && update.cost.amount >= 0) {
              usage = { ...usage, costUsd: update.cost.amount }
              emit({ _tag: "Usage", usage })
            }
          }
        },
        onPermission: (request) => {
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
      const mode = defaultModeChange(configOptions)
      if (mode !== undefined) configOptions = yield* change(configOptions, mode.id, mode.value)
      for (const id of flattenSettings(configOptions).map((setting) => setting.id)) {
        const setting: AgentSetting | undefined = flattenSettings(configOptions).find((candidate) => candidate.id === id)
        const wanted = setting === undefined ? undefined : prefFor(setting, options.prefs)
        if (wanted !== undefined) configOptions = yield* change(configOptions, id, wanted)
      }
      emit({ _tag: "Settings", settings: flattenSettings(configOptions) })

      emit({ _tag: "Working" })
      phase = "working"
      const response = yield* step(acp.prompt(sessionId, KICKOFF))
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
    }).pipe(
      Effect.onExit((exit) =>
        exit._tag === "Failure" && !Cause.hasInterruptsOnly(exit.cause)
          ? Effect.logWarning(`acp: run ${options.runId} failed: ${Cause.findErrorOption(exit.cause)._tag === "Some" ? "agent error" : "defect"}`)
          : Effect.void
      )
    )
  )

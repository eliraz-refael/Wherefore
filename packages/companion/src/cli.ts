/**
 * `wherefore`: the companion CLI (architecture A3), bundled to dist/cli.js.
 *
 * - `install` / `uninstall`: register (or remove) the native messaging host for Chrome and other
 *   Chromium browsers on this machine.
 * - `status`: where the host is registered, and the live brokers (one per connected profile).
 * - `native-host`: what Chrome runs. It is dispatched before the CLI parser, because Chrome
 *   passes arguments the parser doesn't know (the caller's origin, `--parent-window=<n>` on
 *   Windows) and because nothing but native-messaging frames may reach stdout.
 * - `mcp [--profile <id>]`: the MCP server on stdio (src/mcp/), for agents like Claude Code. Every
 *   connected Chrome profile, or only `--profile`'s (what an ACP run uses, PR C). Stdout is the
 *   MCP channel: everything else goes to stderr.
 *
 * The ACP pieces (PR C) arrive later.
 */
import { existsSync, realpathSync } from "node:fs"
import { homedir } from "node:os"
import { EXTENSION_ORIGIN, NATIVE_HOST_NAME, ProfileId } from "@wherefore/core"
import { Cause, Console, Duration, Effect, Exit, Layer, Logger, Option, Runtime, Schema } from "effect"
import { connectBroker } from "./broker/BrokerClient.ts"
import { callerOf, runNativeHost } from "./broker/nativeHost.ts"
import { liveDeps, makeRegistry } from "./broker/registry.ts"
import { applyInstall, applyUninstall, installedHosts, runCommand } from "./install/apply.ts"
import { serveMcp } from "./mcp/McpSurface.ts"
import { claudeMcpAdd, planInstall, planUninstall, stableNode, wrapperPath } from "./install/plan.ts"
import { type Location, platformOf, registryDir } from "./paths.ts"
import {
  Command,
  Flag,
  NodeChildProcessSpawner,
  NodeFileSystem,
  NodePath,
  NodeRuntime,
  NodeStdio,
  NodeTerminal
} from "./unstable.ts"
import { COMPANION_VERSION } from "./version.ts"

const location = (): Location => ({ platform: platformOf(process.platform), home: homedir(), env: process.env })

/** This file, as installed: the wrapper script runs it. */
const cliPath = () => realpathSync(process.argv[1] ?? "")

/** The Node to pin in the wrapper: a stable `PATH` entry for this binary when there is one (plan.ts). */
const nodePath = (where: Location) =>
  stableNode(where.platform, process.execPath, process.env["PATH"], (path) => {
    try {
      return realpathSync(path)
    } catch {
      return undefined
    }
  })

const pad = (text: string, width: number) => text.padEnd(width)

const install = Command.make("install", {}, () =>
  Effect.gen(function*() {
    const where = location()
    const node = nodePath(where)
    const plan = planInstall(where, { node, cli: cliPath(), env: process.env }, existsSync)
    const registered = yield* applyInstall(where, plan, runCommand)
    yield* Console.log(`Registered the Wherefore native messaging host (${NATIVE_HOST_NAME}):`)
    for (const entry of registered) {
      const state = entry.failed !== undefined
        ? `FAILED: ${entry.failed}`
        : entry.skipped !== undefined
        ? `skipped (${entry.skipped})`
        : `ok  ${entry.where ?? ""}`
      yield* Console.log(`  ${pad(entry.browser, 12)} ${state}`)
    }
    yield* Console.log(`
Chrome runs ${wrapperPath(where)},
which starts ${node} ${cliPath()}.
Only the Wherefore extension (${EXTENSION_ORIGIN}) may start it.

Next: reload the extension in chrome://extensions (or press "Check again" in its Settings),
then run \`node ${cliPath()} status\` to see the connected profiles.

To use Wherefore from Claude Code (MCP mode), add its MCP server once:

  ${claudeMcpAdd(where.platform, node, cliPath())}

then ask Claude Code to tidy up your tabs, with the Wherefore side panel open.`)
  })).pipe(Command.withDescription("Register the native messaging host with Chrome and other Chromium browsers"))

const uninstall = Command.make("uninstall", {}, () =>
  Effect.gen(function*() {
    const removed = yield* applyUninstall(planUninstall(location()), runCommand)
    if (removed.length === 0) yield* Console.log("Nothing to remove: the native messaging host wasn't registered.")
    else {
      yield* Console.log("Removed:")
      for (const item of removed) yield* Console.log(`  ${item}`)
    }
    yield* Console.log(
      "\nRunning brokers stop when Chrome closes their connection (reload the extension, or restart Chrome)."
    )
  })).pipe(Command.withDescription("Remove the native messaging host's manifests, registry keys and wrapper script"))

const status = Command.make("status", {}, () =>
  Effect.gen(function*() {
    const where = location()
    yield* Console.log(`Wherefore companion ${COMPANION_VERSION}`)
    yield* Console.log(`\nNative messaging host ${NATIVE_HOST_NAME}:`)
    for (const browser of yield* installedHosts(where, runCommand)) {
      const host = browser.host
      const text = host._tag === "Installed"
        ? `installed      ${host.where}`
        : host._tag === "Different"
        ? `needs install  ${host.where}: ${host.problem}`
        : browser.present === false
        ? "not installed  (browser not found)"
        : "not installed"
      yield* Console.log(`  ${pad(browser.browser, 12)} ${text}`)
    }

    const registry = makeRegistry(liveDeps(where))
    const { live, removed } = yield* registry.list
    yield* Console.log(`\nBrokers (one per connected Chrome profile), registered in ${registryDir(where)}:`)
    if (removed.length > 0) yield* Console.log(`  (cleaned up ${removed.length} stale entr${removed.length === 1 ? "y" : "ies"})`)
    if (live.length === 0) yield* Console.log("  none. Open Chrome with the Wherefore extension loaded.")
    for (const entry of live) {
      const info = yield* Effect.scoped(Effect.flatMap(connectBroker(entry.socket, entry.token), (client) => client.call("broker_info", undefined))).pipe(
        Effect.timeoutOption(Duration.seconds(2)),
        Effect.option
      )
      const answered = info._tag === "Some" && info.value._tag === "Some" ? info.value.value : undefined
      const since = new Date(entry.startedAt).toLocaleString()
      yield* Console.log(
        answered === undefined
          ? `  ${entry.profileId}  pid ${entry.pid}  not answering  ${entry.socket}`
          : `  ${answered.profileId}  pid ${answered.pid}  extension ${answered.extensionVersion}  companion ${answered.companionVersion}  since ${since}`
      )
    }
  })).pipe(Command.withDescription("Show where the host is registered and which Chrome profiles are connected"))

const mcp = Command.make("mcp", {
  profile: Flag.String("profile").pipe(
    Flag.withDescription("Serve only this Chrome profile's tabs (its id, from `status`)"),
    Flag.optional
  )
}, ({ profile }) =>
  Effect.gen(function*() {
    // Stdout is the MCP channel.
    console.log = console.error
    console.info = console.error
    console.debug = console.error
    console.warn = console.error
    const scoped = Option.getOrUndefined(profile)
    if (scoped !== undefined && !Schema.is(ProfileId)(scoped)) {
      return yield* Console.error(`wherefore mcp: "${scoped}" isn't a profile id; \`status\` lists them.`)
    }
    yield* serveMcp({
      version: COMPANION_VERSION,
      entries: makeRegistry(liveDeps(location())).entries,
      profile: scoped
    })
  })).pipe(Command.withDescription("Serve your tabs to an MCP client (e.g. Claude Code) over stdio"))

const nativeHostCommand = Command.make("native-host", {}, () =>
  Console.error("Chrome starts `native-host` for the Wherefore extension; you don't need to run it.")
).pipe(Command.withDescription("Run as Chrome's native messaging host (Chrome starts this, not you)"))

const wherefore = Command.make("wherefore").pipe(
  Command.withDescription("The Wherefore companion: connects local agents to your tabs through the Wherefore extension"),
  Command.withSubcommands([install, uninstall, status, mcp, nativeHostCommand])
)

const cliServices = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeTerminal.layer, NodeStdio.layer).pipe(
  Layer.provideMerge(Layer.succeed(Logger.LogToStderr)(true)),
  (base) => Layer.merge(base, NodeChildProcessSpawner.layer.pipe(Layer.provide(base)))
)

const args = process.argv.slice(2)

if (args[0] === "native-host" || callerOf(args.slice(0, 1)) !== undefined) {
  // Stdout is Chrome's channel: nothing may print to it but the frame writer.
  console.log = console.error
  console.info = console.error
  console.debug = console.error
  console.warn = console.error
  if (process.platform !== "win32") process.once("SIGHUP", () => process.kill(process.pid, "SIGTERM"))
  const program = runNativeHost({
    args: args[0] === "native-host" ? args.slice(1) : args,
    location: location(),
    pid: process.pid,
    companionVersion: COMPANION_VERSION
  }).pipe(
    Effect.tapError((error) =>
      Console.error(
        error._tag === "CallerRejected"
          ? `wherefore native-host: refusing caller ${error.origin}. Chrome starts this for the Wherefore extension; run \`status\` to check the setup.`
          : `wherefore native-host: ${error.message}`
      )
    ),
    Effect.tapDefect((defect) => Console.error(`wherefore native-host crashed: ${String(defect)}`)),
    Effect.provide(NodeStdio.layer),
    Effect.provide(Layer.succeed(Logger.LogToStderr)(true))
  )
  NodeRuntime.runMain(program, {
    disableErrorReporting: true,
    teardown: (exit, onExit) =>
      Runtime.defaultTeardown(exit, (code) => {
        onExit(code)
        process.exit(code)
      })
  })
} else {
  NodeRuntime.runMain(Command.run(wherefore, { version: COMPANION_VERSION }).pipe(Effect.provide(cliServices)), {
    // `mcp` ends when its client closes stdin, which interrupts the server: a normal end, not an error.
    teardown: (exit, onExit) =>
      Runtime.defaultTeardown(exit, (code) =>
        onExit(args[0] === "mcp" && Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause) ? 0 : code))
  })
}

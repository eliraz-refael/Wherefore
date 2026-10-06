import { execFile } from "node:child_process"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { describe, expect, it } from "@effect/vitest"
import { EXTENSION_ORIGIN, NATIVE_HOST_NAME } from "@wherefore/core"
import { Effect } from "effect"
import { applyInstall, applyUninstall, installedHosts, type RunCommand } from "../src/install/apply.ts"
import {
  batEscape,
  browserTargets,
  planInstall,
  planUninstall,
  shQuote,
  stableNode,
  wrapperPath,
  wrapperScript,
  wrapperTargets
} from "../src/install/plan.ts"
import { type Location, socketPath, stateDir } from "../src/paths.ts"
import { PROFILE, tempLocation } from "./fakes.ts"

const mac: Location = { platform: "darwin", home: "/Users/Ada Lovelace", env: {} }
const linux: Location = { platform: "linux", home: "/home/ada", env: {} }
const windows: Location = { platform: "win32", home: "C:\\Users\\Ada Lovelace", env: {} }

const input = (node: string, cli: string) => ({
  node,
  cli,
  env: { PATH: "/usr/bin:/opt/my tools/bin", ANTHROPIC_API_KEY: "sk-ant-secret", HTTPS_PROXY: "http://proxy:8080" }
})

describe("install plan", () => {
  it("registers Chrome always and other browsers only when present (macOS)", () => {
    const plan = planInstall(mac, input("/usr/local/bin/node", "/Users/Ada Lovelace/src/companion/dist/cli.js"), (dir) =>
      dir.endsWith("BraveSoftware/Brave-Browser"))
    const manifests = plan.files.filter((file) => file.path.endsWith(`${NATIVE_HOST_NAME}.json`)).map((file) => file.path)
    expect(manifests).toEqual([
      `/Users/Ada Lovelace/Library/Application Support/Google/Chrome/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`,
      `/Users/Ada Lovelace/Library/Application Support/BraveSoftware/Brave-Browser/NativeMessagingHosts/${NATIVE_HOST_NAME}.json`
    ])
    expect(plan.report.filter((entry) => entry.skipped !== undefined).map((entry) => entry.browser)).toEqual([
      "Chrome Beta",
      "Chromium",
      "Edge",
      "Arc"
    ])
    expect(plan.commands).toEqual([])
    expect(plan.dirs[0]).toBe("/Users/Ada Lovelace/.wherefore")

    const manifest = JSON.parse(plan.files.find((file) => file.path === manifests[0])?.content ?? "")
    expect(manifest).toEqual({
      name: NATIVE_HOST_NAME,
      description: expect.any(String),
      path: "/Users/Ada Lovelace/.wherefore/native-host.sh",
      type: "stdio",
      allowed_origins: [EXTENSION_ORIGIN]
    })
  })

  it("covers the Linux browser config directories", () => {
    expect(browserTargets("linux", "/home/ada").map((target) => target.manifestDir)).toEqual([
      "/home/ada/.config/google-chrome/NativeMessagingHosts",
      "/home/ada/.config/google-chrome-beta/NativeMessagingHosts",
      "/home/ada/.config/chromium/NativeMessagingHosts",
      "/home/ada/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts",
      "/home/ada/.config/microsoft-edge/NativeMessagingHosts"
    ])
    const plan = planInstall(linux, input("/usr/bin/node", "/home/ada/companion/dist/cli.js"), () => true)
    expect(plan.files.filter((file) => file.path.endsWith(".json"))).toHaveLength(5)
    expect(plan.files[0]).toMatchObject({ path: "/home/ada/.wherefore/native-host.sh", mode: 0o755 })
  })

  it("on Windows, writes a .bat and one manifest, and registers it under HKCU for each browser", () => {
    const plan = planInstall(windows, input("C:\\Program Files\\nodejs\\node.exe", "C:\\Users\\Ada Lovelace\\src\\cli.js"), () => false)
    expect(plan.files.map((file) => file.path)).toEqual([
      "C:\\Users\\Ada Lovelace\\.wherefore\\native-host.bat",
      `C:\\Users\\Ada Lovelace\\.wherefore\\${NATIVE_HOST_NAME}.json`
    ])
    const manifest = JSON.parse(plan.files[1]?.content ?? "")
    expect(manifest.path).toBe("C:\\Users\\Ada Lovelace\\.wherefore\\native-host.bat")
    expect(plan.commands.map(({ browser, file, args }) => [browser, file, ...args])).toEqual(
      [
        ["Chrome", "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts"],
        ["Chromium", "HKCU\\Software\\Chromium\\NativeMessagingHosts"],
        ["Brave", "HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts"],
        ["Edge", "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts"]
      ].map(([browser, key]) => [
        browser,
        "reg",
        "add",
        `${key}\\${NATIVE_HOST_NAME}`,
        "/ve",
        "/t",
        "REG_SZ",
        "/d",
        `C:\\Users\\Ada Lovelace\\.wherefore\\${NATIVE_HOST_NAME}.json`,
        "/f"
      ])
    )
    expect(planUninstall(windows).commands.map((command) => command.args)).toContainEqual([
      "delete",
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
      "/f"
    ])
  })

  it("quotes paths with spaces and quotes in the POSIX wrapper, and never copies API keys", () => {
    const script = wrapperScript("darwin", input("/opt/my node/bin/node", "/Users/O'Brien/dist/cli.js"))
    expect(script.split("\n")).toEqual([
      "#!/bin/sh",
      expect.stringContaining("Generated by"),
      "export PATH='/usr/bin:/opt/my tools/bin'",
      "export HTTPS_PROXY='http://proxy:8080'",
      "node='/opt/my node/bin/node'",
      `cli='/Users/O'\\''Brien/dist/cli.js'`,
      'if [ ! -x "$node" ]; then',
      expect.stringContaining("command -v node"),
      "fi",
      'exec "$node" "$cli" native-host "$@"',
      ""
    ])
    expect(wrapperTargets("darwin", script)).toEqual({ node: "/opt/my node/bin/node", cli: "/Users/O'Brien/dist/cli.js" })
    expect(script).not.toContain("sk-ant")
    expect(shQuote("a'b")).toBe(`'a'\\''b'`)
  })

  it("escapes % in the Windows wrapper, and skips values a batch file can't hold", () => {
    const script = wrapperScript("win32", {
      node: "C:\\Program Files\\nodejs\\node.exe",
      cli: "C:\\Users\\100% Ada\\cli.js",
      env: { PATH: "C:\\bin;%SystemRoot%", HTTPS_PROXY: 'http://"odd"', ANTHROPIC_API_KEY: "sk-ant-secret" }
    })
    expect(script.split("\r\n")).toEqual([
      "@echo off",
      expect.stringContaining("Generated by"),
      'set "PATH=C:\\bin;%%SystemRoot%%"',
      'set "WHEREFORE_NODE=C:\\Program Files\\nodejs\\node.exe"',
      'set "WHEREFORE_CLI=C:\\Users\\100%% Ada\\cli.js"',
      'if not exist "%WHEREFORE_NODE%" set "WHEREFORE_NODE=node"',
      '"%WHEREFORE_NODE%" "%WHEREFORE_CLI%" native-host %*',
      ""
    ])
    expect(wrapperTargets("win32", script)).toEqual({ node: "C:\\Program Files\\nodejs\\node.exe", cli: "C:\\Users\\100% Ada\\cli.js" })
    expect(batEscape("50%")).toBe("50%%")
  })
})

describe("stableNode", () => {
  const real: Record<string, string> = {
    "/nix/store/abc-nodejs-22/bin/node": "/nix/store/abc-nodejs-22/bin/node",
    "/run/current-system/sw/bin/node": "/nix/store/abc-nodejs-22/bin/node",
    "/usr/bin/node": "/usr/lib/node18/node"
  }
  const resolve = (path: string) => real[path]

  it("prefers a PATH entry that resolves to the running Node over its versioned store path", () => {
    expect(stableNode("linux", "/nix/store/abc-nodejs-22/bin/node", "/usr/bin:/run/current-system/sw/bin", resolve)).toBe(
      "/run/current-system/sw/bin/node"
    )
  })

  it("keeps the running Node when no PATH entry is the same binary", () => {
    expect(stableNode("linux", "/nix/store/abc-nodejs-22/bin/node", "/usr/bin:relative", resolve)).toBe(
      "/nix/store/abc-nodejs-22/bin/node"
    )
    expect(stableNode("linux", "/nix/store/abc-nodejs-22/bin/node", undefined, resolve)).toBe("/nix/store/abc-nodejs-22/bin/node")
  })
})

describe("paths", () => {
  it("puts state under ~/.wherefore unless WHEREFORE_HOME says otherwise", () => {
    expect(stateDir(mac)).toBe("/Users/Ada Lovelace/.wherefore")
    expect(stateDir({ ...linux, env: { WHEREFORE_HOME: "/srv/wf" } })).toBe("/srv/wf")
    expect(stateDir(windows)).toBe("C:\\Users\\Ada Lovelace\\.wherefore")
    expect(wrapperPath(windows)).toBe("C:\\Users\\Ada Lovelace\\.wherefore\\native-host.bat")
  })

  it("names sockets by profile and pid: a Unix socket in the registry, or a per-user named pipe", () => {
    expect(socketPath(linux, PROFILE, 42)).toBe(`/home/ada/.wherefore/run/${PROFILE}.42.sock`)
    const pipe = socketPath(windows, PROFILE, 42)
    expect(pipe).toMatch(new RegExp(`^\\\\\\\\\\.\\\\pipe\\\\wherefore-[0-9a-f]{12}-${PROFILE}-42$`))
    expect(socketPath({ ...windows, home: "C:\\Users\\Grace" }, PROFILE, 42)).not.toBe(pipe)
  })
})

describe("install on disk", () => {
  const record = (log: Array<string>): RunCommand => (command) =>
    Effect.sync(() => {
      log.push([command.file, ...command.args].join(" "))
      return { ok: true, output: "" }
    })

  it.live("installs into a temporary home, reports it installed, then uninstalls", () =>
    Effect.gen(function*() {
      if (process.platform === "win32") return
      const location = yield* tempLocation
      const home: Location = { ...location, platform: process.platform === "darwin" ? "darwin" : "linux", env: {} }
      const commands: Array<string> = []
      const cli = NodePath.join(location.home, "cli.js")
      yield* Effect.promise(() => Fs.writeFile(cli, "console.log('ran', process.argv.slice(2).join(' '))\n"))
      const plan = planInstall(home, input(process.execPath, cli), () => false)
      const registered = yield* applyInstall(home, plan, record(commands))
      expect(registered.find((entry) => entry.browser === "Chrome")?.where).toContain(location.home)
      expect(commands).toEqual([])

      const wrapper = yield* Effect.promise(() => Fs.stat(wrapperPath(home)))
      expect(wrapper.mode & 0o777).toBe(0o755)
      const state = yield* Effect.promise(() => Fs.stat(stateDir(home)))
      expect(state.mode & 0o077).toBe(0)

      const hosts = yield* installedHosts(home, record(commands))
      expect(hosts.find((host) => host.browser === "Chrome")?.host._tag).toBe("Installed")
      expect(hosts.find((host) => host.browser === "Edge")?.host._tag).toBe("Absent")

      // A Node that was removed since (Nix GC, a version manager) is reported, and the wrapper
      // falls back to `node` on PATH instead of failing to start.
      const gone = planInstall(home, { node: "/nix/store/gone-nodejs/bin/node", cli, env: { PATH: process.env["PATH"] } }, () => false)
      yield* applyInstall(home, gone, record(commands))
      expect((yield* installedHosts(home, record(commands)))[0]?.host).toMatchObject({ _tag: "Different" })
      const ran = yield* Effect.promise(() =>
        new Promise<string>((resolve, reject) =>
          execFile(wrapperPath(home), ["chrome-extension://x/"], (error, stdout) => (error ? reject(error) : resolve(stdout))))
      )
      expect(ran.trim()).toBe("ran native-host chrome-extension://x/")

      // A manifest that points elsewhere is reported, not trusted.
      const chrome = browserTargets(home.platform, home.home)[0]?.manifestDir ?? ""
      yield* Effect.promise(() =>
        Fs.writeFile(NodePath.join(chrome, `${NATIVE_HOST_NAME}.json`), JSON.stringify({ name: NATIVE_HOST_NAME, path: "/elsewhere", allowed_origins: [EXTENSION_ORIGIN] }))
      )
      expect((yield* installedHosts(home, record(commands)))[0]?.host).toMatchObject({ _tag: "Different" })

      const removed = yield* applyUninstall(planUninstall(home), record(commands))
      expect(removed).toContain(wrapperPath(home))
      expect((yield* installedHosts(home, record(commands)))[0]?.host._tag).toBe("Absent")
    }))
})

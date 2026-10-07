/**
 * The companion's decisions about an ACP agent, without a process: the permission guard, the
 * settings it shows, how a failure reads, and how the agent and its MCP server are started per OS.
 */
import { describe, expect, it } from "@effect/vitest"
import { DEFAULT_AGENT_COMMAND, type ProfileId, type RunId } from "@wherefore/core"
import type { RequestPermissionRequest, SessionConfigOption } from "../src/acp/AcpConnection.ts"
import { agentMcpServer, mcpLauncher, RUN_ID_PATTERN, spawnPlan, splitCommand } from "../src/acp/command.ts"
import { classifyFailure, decidePermission, defaultModeChange, flattenSettings, isWhereforeTool, lastLine, WHEREFORE_TOOLS } from "../src/acp/policy.ts"

const options: RequestPermissionRequest["options"] = [
  { optionId: "a1", name: "Allow", kind: "allow_once" },
  { optionId: "a2", name: "Always", kind: "allow_always" },
  { optionId: "r1", name: "Reject", kind: "reject_once" },
  { optionId: "r2", name: "Never", kind: "reject_always" }
]
const ask = (toolCall: RequestPermissionRequest["toolCall"], offered = options): RequestPermissionRequest => ({
  sessionId: "s",
  toolCall,
  options: offered
})

describe("the permission guard", () => {
  it("knows Wherefore's five tools", () => {
    expect(WHEREFORE_TOOLS).toEqual(["list_tabs", "read_pages", "wake_and_read_pages", "ask_user", "submit_intentions"])
  })

  it("allows Wherefore's tools once, never always", () => {
    for (const tool of WHEREFORE_TOOLS) {
      const decision = decidePermission(ask({ toolCallId: "t", title: `mcp__wherefore__${tool}` }))
      expect(decision).toEqual({ allowed: true, response: { outcome: { outcome: "selected", optionId: "a1" } } })
    }
    // Claude Code's own name for the tool decides when it reports one.
    expect(isWhereforeTool({ toolCallId: "t", title: "Wherefore", _meta: { claudeCode: { toolName: "mcp__wherefore__read_pages" } } })).toBe(true)
  })

  it("refuses the agent's own tools, and look-alikes", () => {
    const refused = [
      { toolCallId: "t", title: "rm -rf ~", kind: "execute" as const },
      { toolCallId: "t", title: "Edit /etc/hosts", kind: "edit" as const },
      { toolCallId: "t", title: "Fetch https://evil.example", kind: "fetch" as const },
      // A shell command named like our tool is still a shell command.
      { toolCallId: "t", title: "mcp__wherefore__list_tabs", kind: "execute" as const },
      { toolCallId: "t", title: "echo mcp__wherefore__list_tabs" },
      { toolCallId: "t", title: "mcp__wherefore__list_tabs; rm -rf ~" },
      { toolCallId: "t", title: "mcp__other__list_tabs" },
      // The agent's real name wins over a title that looks like ours.
      { toolCallId: "t", title: "mcp__wherefore__list_tabs", _meta: { claudeCode: { toolName: "Bash" } } },
      { toolCallId: "t" }
    ]
    for (const toolCall of refused) {
      expect(decidePermission(ask(toolCall))).toEqual({ allowed: false, response: { outcome: { outcome: "selected", optionId: "r1" } } })
    }
  })

  it("falls back to the other option of the same kind, and to cancelling", () => {
    expect(decidePermission(ask({ toolCallId: "t", title: "Bash" }, [options[0]!, options[3]!])).response)
      .toEqual({ outcome: { outcome: "selected", optionId: "r2" } })
    expect(decidePermission(ask({ toolCallId: "t", title: "Bash" }, [options[0]!])))
      .toEqual({ allowed: false, response: { outcome: { outcome: "cancelled" } } })
    expect(decidePermission(ask({ toolCallId: "t", title: "list_tabs" }, [options[2]!])))
      .toEqual({ allowed: false, response: { outcome: { outcome: "cancelled" } } })
  })
})

describe("agent settings", () => {
  const offered: Array<SessionConfigOption> = [
    {
      id: "mode",
      name: "Mode",
      category: "mode",
      type: "select",
      currentValue: "bypassPermissions",
      options: [{ value: "default", name: "Default" }, { value: "bypassPermissions", name: "Bypass" }]
    },
    {
      id: "model",
      name: "Model",
      description: "AI model to use",
      category: "model",
      type: "select",
      currentValue: "sonnet",
      options: [{ group: "g", name: "Claude", options: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus", description: "" }] }]
    },
    { id: "fast", name: "Fast", category: "model_config", type: "boolean", currentValue: false },
    { id: "other", name: "Other", category: "something_else", type: "boolean", currentValue: true }
  ]

  it("shows model, effort and model options, never permission modes", () => {
    expect(flattenSettings(offered)).toEqual([
      {
        id: "model",
        name: "Model",
        description: "AI model to use",
        category: "model",
        value: "sonnet",
        choices: [{ value: "sonnet", name: "Sonnet" }, { value: "opus", name: "Opus" }]
      },
      { id: "fast", name: "Fast", category: "model_config", value: false }
    ])
    expect(flattenSettings(null)).toEqual([])
  })

  it("puts the session back to the default permission mode when it starts in another", () => {
    expect(defaultModeChange(offered)).toEqual({ id: "mode", value: "default" })
    expect(defaultModeChange([{ ...offered[0]!, currentValue: "default" } as SessionConfigOption])).toBeUndefined()
    expect(defaultModeChange(offered.slice(1))).toBeUndefined()
  })
})

describe("failures", () => {
  const custom = "my-agent --acp"

  it("a login problem, from the ACP error or the agent's words", () => {
    expect(classifyFailure({ command: custom, phase: "working", request: { code: -32000, message: "Authentication required" }, stderr: "" })._tag)
      .toBe("AgentNotLoggedIn")
    expect(classifyFailure({ command: custom, phase: "working", request: { code: -32603, message: "Not logged in · Please run /login" }, stderr: "" })._tag)
      .toBe("AgentNotLoggedIn")
    expect(classifyFailure({ command: custom, phase: "starting", exit: { code: 1 }, stderr: "Error: Invalid API key\n" })._tag)
      .toBe("AgentNotLoggedIn")
  })

  it("a missing command on Windows, and a failed start with stderr's last line", () => {
    const windows = classifyFailure({
      command: DEFAULT_AGENT_COMMAND,
      phase: "starting",
      exit: { code: 1 },
      stderr: "'npx' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n"
    })
    expect(windows).toMatchObject({ _tag: "AgentNotFound" })
    expect(windows.message).toContain("npx wasn't found")
    expect(classifyFailure({ command: custom, phase: "starting", exit: { code: 1 }, stderr: "npm error 404 Not Found\n\n" }).message)
      .toBe("The agent couldn't start the tidy-up: it exited with code 1: npm error 404 Not Found")
  })

  it("a crash mid-run, without stderr (it may hold page text by then)", () => {
    const crash = classifyFailure({ command: DEFAULT_AGENT_COMMAND, phase: "working", exit: { code: null }, stderr: "page text" })
    expect(crash).toMatchObject({ _tag: "AgentExited", code: null })
    expect(crash.message).not.toContain("page text")
    expect(crash.message).toMatch(/^Claude Code stopped unexpectedly\. Try again/)
  })

  it("an agent error otherwise", () => {
    expect(classifyFailure({ command: custom, phase: "working", request: { code: -32603, message: "Internal error" }, stderr: "" }).message)
      .toBe("The agent couldn't finish the tidy-up: Internal error.")
    expect(lastLine("a\n\n b \n")).toBe("b")
    expect(lastLine("x".repeat(300))?.length).toBe(200)
  })
})

describe("starting the agent and its MCP server", () => {
  it("splits a command line into words; quotes group words", () => {
    expect(splitCommand("  npx -y @agentclientprotocol/claude-agent-acp ")).toEqual(["npx", "-y", "@agentclientprotocol/claude-agent-acp"])
    expect(splitCommand(`"/Applications/My Agent/agent" --flag 'two words' a""b`)).toEqual(["/Applications/My Agent/agent", "--flag", "two words", "ab"])
    expect(splitCommand(`C:\\Tools\\agent.exe --acp`)).toEqual(["C:\\Tools\\agent.exe", "--acp"])
    expect(splitCommand("   ")).toEqual([])
  })

  it("runs the command directly on POSIX, through cmd.exe on Windows (npx is npx.cmd there)", () => {
    expect(spawnPlan("darwin", DEFAULT_AGENT_COMMAND)).toEqual({ program: "npx", args: ["-y", "@agentclientprotocol/claude-agent-acp"], shell: false })
    expect(spawnPlan("linux", "agent")).toEqual({ program: "agent", args: [], shell: false })
    expect(spawnPlan("win32", ` ${DEFAULT_AGENT_COMMAND} `)).toEqual({ program: DEFAULT_AGENT_COMMAND, args: [], shell: true })
    expect(spawnPlan("linux", "")).toBeUndefined()
  })

  it("gives the agent wherefore mcp --profile --run, with the wrapper's Node and CLI", () => {
    const launcher = mcpLauncher({ WHEREFORE_NODE: "/run/current-system/sw/bin/node", WHEREFORE_CLI: "/repo/dist/cli.js" }, { node: "/nix/store/x/node", cli: "/x.js" })
    expect(launcher).toEqual({ node: "/run/current-system/sw/bin/node", cli: "/repo/dist/cli.js" })
    expect(mcpLauncher({ WHEREFORE_NODE: "" }, { node: "/n", cli: "/c" })).toEqual({ node: "/n", cli: "/c" })
    const profile = "abcdefghijklmnopqrstuvwxyz" as ProfileId
    const runId = "5f0c2a8e-1111-4222-8333-944445555666" as RunId
    expect(RUN_ID_PATTERN.test(runId)).toBe(true)
    expect(agentMcpServer({ ...launcher, profile, runId, env: {} })).toEqual({
      name: "wherefore",
      command: "/run/current-system/sw/bin/node",
      args: ["/repo/dist/cli.js", "mcp", "--profile", profile, "--run", runId],
      env: []
    })
    expect(agentMcpServer({ ...launcher, profile, runId, env: { WHEREFORE_HOME: "/tmp/w" } }).env).toEqual([{ name: "WHEREFORE_HOME", value: "/tmp/w" }])
    for (const bad of ["", "-rf", "a b", "a;b", "x".repeat(101)]) expect(RUN_ID_PATTERN.test(bad)).toBe(false)
  })
})

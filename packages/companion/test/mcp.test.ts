/**
 * MCP mode end to end: a real `wherefore mcp` process over stdio (raw JSON-RPC), and real brokers
 * (in this process, on real sockets in a temporary WHEREFORE_HOME) in front of fake workers that
 * store runs and answer questions the way the extension's worker does.
 */
import { describe, expect, it } from "@effect/vitest"
import { KICKOFF, type ProfileId, RunAlreadyActive, TriageToolkit } from "@wherefore/core"
import { Deferred, Effect } from "effect"
import { INSTRUCTIONS, PROMPT_NAME } from "../src/mcp/McpSurface.ts"
import { ASK_ELSEWHERE, NO_BROKERS, PROFILE_GONE, SKIPPED_ANSWER, UNKNOWN_TAB } from "../src/mcp/Session.ts"
import { type FakeChrome, NO_PANEL, startFakeChrome, tempLocation } from "./fakes.ts"
import { eventually, runCli, startMcp } from "./mcpProcess.ts"

const WORK = "workworkworkworkworkworkwo" as ProfileId
const HOME = "homehomehomehomehomehomeho" as ProfileId

const tabsOf = (prefix: string) => [
  { id: 1, window: 1, index: 0, title: `${prefix} PR`, url: `https://github.com/${prefix}/api/pull/1`, active: true },
  { id: 2, window: 1, index: 1, title: `${prefix} docs`, url: `https://docs.example/${prefix}`, openedFrom: 1 }
]

const page = (id: number, title: string) => ({
  id,
  title,
  url: "https://example.com/",
  headings: [],
  description: "",
  text: "Merged",
  scrollPct: null,
  media: null,
  selection: ""
})

const intention = (title: string, tabIds: ReadonlyArray<number>, kind = "read") => ({
  title,
  why: "w",
  kind,
  tab_ids: tabIds,
  confidence: "high",
  evidence: "e"
})

const homeOf = (location: { readonly env: Readonly<Record<string, string | undefined>> }) => location.env["WHEREFORE_HOME"] ?? ""

/** The only run a fake worker stored. */
const onlyRun = (chrome: FakeChrome) => {
  const runs = [...chrome.runs.values()]
  expect(runs).toHaveLength(1)
  return runs[0]!
}

describe("wherefore mcp", () => {
  it.live("introduces itself: core's five tools, the tidy_up prompt and short instructions", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      const mcp = yield* startMcp(homeOf(location))
      const init = (mcp as unknown as { initialize: any }).initialize
      expect(init.serverInfo.name).toBe("wherefore")
      expect(init.instructions).toBe(INSTRUCTIONS)
      const { tools } = yield* Effect.promise(() => mcp.request("tools/list"))
      expect(tools.map((tool: { name: string }) => tool.name)).toEqual(Object.keys(TriageToolkit.tools))
      const { prompts } = yield* Effect.promise(() => mcp.request("prompts/list"))
      expect(prompts.map((prompt: { name: string }) => prompt.name)).toEqual([PROMPT_NAME])
      const prompt = yield* Effect.promise(() => mcp.request("prompts/get", { name: PROMPT_NAME }))
      expect(prompt.messages[0].content.text).toBe(KICKOFF)
    }))

  it.live("says to open Chrome, at once, when no profile is connected", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      const mcp = yield* startMcp(homeOf(location))
      const started = Date.now()
      const result = yield* Effect.promise(() => mcp.callTool("list_tabs"))
      expect(result.isError).toBe(true)
      expect(result.text).toContain(NO_BROKERS)
      expect(Date.now() - started).toBeLessThan(3000)
      // Nothing else hangs either.
      expect((yield* Effect.promise(() => mcp.callTool("submit_intentions", { intentions: [intention("x", [1])] }))).isError).toBe(true)
    }))

  it.live("serves every profile with session ids, records a run in each, and stores each its own result", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      const work = yield* startFakeChrome({
        location,
        profile: WORK,
        listTabs: Effect.succeed({ tabs: tabsOf("work") }),
        readPages: ({ tabIds }) => Effect.succeed({ pages: tabIds.map((id) => page(id, "work page")) })
      })
      const home = yield* startFakeChrome({ location, profile: HOME, listTabs: Effect.succeed({ tabs: tabsOf("home") }) })
      yield* work.entry
      yield* home.entry
      const mcp = yield* startMcp(homeOf(location))

      const listed = yield* Effect.promise(() => mcp.callTool("list_tabs"))
      expect(listed.isError).toBe(false)
      const tabs: Array<any> = listed.structured.tabs
      // Both profiles have tabs 1 and 2: the model sees four distinct ids, and openers follow them.
      expect(tabs.map((tab) => tab.id).sort()).toEqual([1, 2, 3, 4])
      expect(new Set(tabs.map((tab) => tab.window)).size).toBe(2)
      const workPr = tabs.find((tab) => tab.title === "work PR")
      const workDocs = tabs.find((tab) => tab.title === "work docs")
      const homePr = tabs.find((tab) => tab.title === "home PR")
      const homeDocs = tabs.find((tab) => tab.title === "home docs")
      expect(workDocs.openedFrom).toBe(workPr.id)
      expect(homeDocs.openedFrom).toBe(homePr.id)

      // One run per profile, with that profile's real ids.
      const workRun = onlyRun(work)
      expect(workRun).toMatchObject({ mode: "mcp", agent: "test-client", model: "unknown", status: "running" })
      expect(workRun.tabs.map((tab) => tab.id)).toEqual([1, 2])
      expect(onlyRun(home).tabs.map((tab) => tab.title)).toEqual(["home PR", "home docs"])

      // A read goes to the profile that owns the tab, with its real id; the answer comes back mapped.
      const read = yield* Effect.promise(() => mcp.callTool("read_pages", { tab_ids: [workDocs.id, 99] }))
      expect(read.structured.pages).toEqual([
        { ...page(workDocs.id, "work page") },
        { id: 99, error: UNKNOWN_TAB }
      ])
      const sent = work.fromHost.find((frame: any) => frame.rpc?.tag === "read_pages") as any
      expect(sent.rpc.payload).toEqual({ tab_ids: [2] })
      expect(home.workerLog).not.toContain("request read_pages")
      expect(onlyRun(work).steps.at(-1)).toMatchObject({ kind: "tool", tool: "read_pages", status: "ok", summary: "Read 1 page" })

      // A missing tab goes back to the model; then the full result is stored, split by profile.
      const partial = yield* Effect.promise(() =>
        mcp.callTool("submit_intentions", { intentions: [intention("Ship the work PR", [workPr.id, workDocs.id], "work")] })
      )
      expect(partial.isError).toBe(true)
      expect(partial.text).toContain("Missing tab ids")
      expect(onlyRun(work).status).toBe("running")
      expect(onlyRun(work).steps.at(-1)).toMatchObject({ tool: "submit_intentions", status: "error", summary: "Rejected: 2 tabs missing" })

      const done = yield* Effect.promise(() =>
        mcp.callTool("submit_intentions", {
          intentions: [
            intention("Ship the work PR", [workPr.id, workDocs.id], "work"),
            // One intention can span profiles: each profile keeps its own tabs of it.
            intention("Read about the API", [homePr.id, homeDocs.id])
          ]
        })
      )
      expect(done.isError).toBe(false)
      expect(done.structured.message).toContain("Saved 2 groups")
      const workDone = onlyRun(work)
      expect(workDone.status).toBe("succeeded")
      expect(workDone.intentions).toMatchObject([{ id: `${workDone.id}:0`, title: "Ship the work PR", tabIds: [1, 2] }])
      expect(onlyRun(home).intentions).toMatchObject([{ title: "Read about the API", tabIds: [1, 2] }])
      yield* eventually(() => work.leases.size === 0 && home.leases.size === 0)
      expect(onlyRun(home).status).toBe("succeeded")

      // The next call starts a new tidy-up.
      yield* Effect.promise(() => mcp.callTool("list_tabs"))
      expect(work.runs.size).toBe(2)
    }))

  it.live("keeps going when a profile's Chrome closes mid-call: its tabs drop out", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      const work = yield* startFakeChrome({ location, profile: WORK, listTabs: Effect.succeed({ tabs: tabsOf("work") }) })
      // Home's reads never finish.
      const home = yield* startFakeChrome({ location, profile: HOME, listTabs: Effect.succeed({ tabs: tabsOf("home") }) })
      yield* work.entry
      yield* home.entry
      const mcp = yield* startMcp(homeOf(location))
      const tabs: Array<any> = (yield* Effect.promise(() => mcp.callTool("list_tabs"))).structured.tabs
      const homeIds = tabs.filter((tab) => tab.title.startsWith("home")).map((tab) => tab.id)
      const workIds = tabs.filter((tab) => tab.title.startsWith("work")).map((tab) => tab.id)

      const reading = mcp.callTool("read_pages", { tab_ids: homeIds })
      yield* eventually(() => home.workerLog.includes("request read_pages"))
      yield* home.closePort
      const read = yield* Effect.promise(() => reading)
      expect(read.structured.pages).toEqual(homeIds.map((id) => ({ id, error: PROFILE_GONE })))

      const done = yield* Effect.promise(() =>
        mcp.callTool("submit_intentions", { intentions: [intention("Work", workIds, "work"), intention("Home", homeIds)] })
      )
      expect(done.isError).toBe(false)
      expect(done.structured.message).toContain("disconnected")
      expect(onlyRun(work).intentions).toMatchObject([{ title: "Work", tabIds: [1, 2] }])
    }))

  it.live("asks the profile's panel and returns the answers, filling in skipped ones", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      const work = yield* startFakeChrome({
        location,
        profile: WORK,
        listTabs: Effect.succeed({ tabs: tabsOf("work") }),
        // The user answers the first question and skips the second.
        askPanel: ({ questions }) => Effect.succeed({ answers: [{ id: questions[0]!.id, answer: questions[0]!.options[0]! }] })
      })
      yield* work.entry
      const mcp = yield* startMcp(homeOf(location))
      const tabs: Array<any> = (yield* Effect.promise(() => mcp.callTool("list_tabs"))).structured.tabs
      const questions = [
        { id: "q1", tab_ids: [tabs[0].id], question: "Still reviewing?", options: ["Yes", "No"] },
        { id: "q2", tab_ids: [tabs[1].id], question: "Keep the docs?", options: ["Keep"] }
      ]
      const asked = yield* Effect.promise(() => mcp.callTool("ask_user", { questions }))
      expect(asked.structured.answers).toEqual([{ id: "q1", answer: "Yes" }, { id: "q2", answer: SKIPPED_ANSWER }])
      // The panel got the profile's real tab ids; the run keeps the questions and answers.
      const sent = work.fromHost.find((frame: any) => frame.rpc?.tag === "ask_panel") as any
      expect(sent.rpc.payload.questions.map((question: any) => question.tab_ids)).toEqual([[1], [2]])
      const step = onlyRun(work).steps.find((candidate) => candidate.kind === "question")
      expect(step).toMatchObject({ kind: "question", answers: [{ id: "q1", answer: "Yes" }, { id: "q2", answer: SKIPPED_ANSWER }] })
    }))

  it.live("tells the model to ask in the chat when no panel is open, and leaves no question behind", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      const work = yield* startFakeChrome({ location, profile: WORK, listTabs: Effect.succeed({ tabs: tabsOf("work") }) })
      yield* work.entry
      const mcp = yield* startMcp(homeOf(location))
      const tabs: Array<any> = (yield* Effect.promise(() => mcp.callTool("list_tabs"))).structured.tabs
      const asked = yield* Effect.promise(() =>
        mcp.callTool("ask_user", { questions: [{ id: "q1", tab_ids: [tabs[0].id], question: "Why?", options: [] }] })
      )
      expect(asked.isError).toBe(true)
      expect(asked.text).toContain(NO_PANEL)
      expect(asked.text).toContain(ASK_ELSEWHERE)
      const steps = onlyRun(work).steps
      expect(steps.some((step) => step.kind === "question")).toBe(false)
      expect(steps.at(-1)).toMatchObject({ kind: "note", message: `Couldn't show the questions: ${NO_PANEL}` })
    }))

  it.live("Stop in the panel ends the call in flight and the tidy-up; the next call starts afresh", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      const asked = yield* Deferred.make<void>()
      const work = yield* startFakeChrome({
        location,
        profile: WORK,
        listTabs: Effect.succeed({ tabs: tabsOf("work") }),
        askPanel: () => Effect.andThen(Deferred.succeed(asked, undefined), Effect.never)
      })
      yield* work.entry
      const mcp = yield* startMcp(homeOf(location))
      const tabs: Array<any> = (yield* Effect.promise(() => mcp.callTool("list_tabs"))).structured.tabs
      const asking = mcp.callTool("ask_user", { questions: [{ id: "q1", tab_ids: [tabs[0].id], question: "Why?", options: [] }] })
      yield* Deferred.await(asked)
      const runId = onlyRun(work).id
      yield* work.stop(runId)
      const stopped = yield* Effect.promise(() => asking)
      expect(stopped.isError).toBe(true)
      expect(stopped.text).toContain("The user stopped this tidy-up")
      expect(onlyRun(work).status).toBe("cancelled")

      // A fresh tidy-up next time.
      const again = yield* Effect.promise(() => mcp.callTool("list_tabs"))
      expect(again.isError).toBe(false)
      expect(work.runs.size).toBe(2)
      const second = [...work.runs.values()].find((run) => run.id !== runId)!
      // Stopped with nothing in flight: the next call hears it once.
      yield* work.stop(second.id)
      const told = yield* Effect.promise(() => mcp.callTool("read_pages", { tab_ids: [tabs[0].id] }))
      expect(told.isError).toBe(true)
      expect(told.text).toContain("The user stopped this tidy-up")
    }))

  it.live("an unfinished run is interrupted when the client disconnects, and the server exits cleanly", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      const work = yield* startFakeChrome({ location, profile: WORK, listTabs: Effect.succeed({ tabs: tabsOf("work") }) })
      yield* work.entry
      const mcp = yield* startMcp(homeOf(location))
      yield* Effect.promise(() => mcp.callTool("list_tabs"))
      expect(onlyRun(work).status).toBe("running")
      const code = yield* Effect.promise(() => mcp.close())
      expect(code).toBe(0)
      yield* eventually(() => onlyRun(work).status === "interrupted")
      expect(work.leases.size).toBe(0)

      // Killed outright: the same.
      const killed = yield* startMcp(homeOf(location))
      yield* Effect.promise(() => killed.callTool("list_tabs"))
      const second = [...work.runs.values()].find((run) => run.status === "running")!
      killed.child.kill("SIGKILL")
      yield* eventually(() => work.runs.get(second.id)?.status === "interrupted")
    }))

  it.live("refuses to start while another tidy-up runs in the profile, naming where it started", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      const work = yield* startFakeChrome({ location, profile: WORK, busy: new RunAlreadyActive({ source: "api" }) })
      yield* work.entry
      const mcp = yield* startMcp(homeOf(location))
      const result = yield* Effect.promise(() => mcp.callTool("list_tabs"))
      expect(result.isError).toBe(true)
      expect(result.text).toContain("Another tidy-up is already running in this Chrome profile (started from the Wherefore side panel)")
      expect(work.runs.size).toBe(0)

      // With another profile free, list_tabs lists that one and says which was left out.
      const home = yield* startFakeChrome({ location, profile: HOME, listTabs: Effect.succeed({ tabs: tabsOf("home") }) })
      yield* home.entry
      const listed = yield* Effect.promise(() => mcp.callTool("list_tabs"))
      expect(listed.isError).toBe(false)
      expect(listed.structured.tabs.map((tab: any) => tab.title)).toEqual(["home PR", "home docs"])
      expect(listed.structured.notice).toContain(WORK)
      expect(listed.structured.notice).toContain("started from the Wherefore side panel")
    }))

  it.live("--profile with something that isn't a profile id fails with a non-zero exit", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      const { code, stderr } = yield* runCli(homeOf(location), ["mcp", "--profile", "bad"])
      expect(stderr).toContain(`"bad" isn't a profile id`)
      expect(code).not.toBe(0)
      expect(code).not.toBeNull()
    }))

  it.live("--profile serves one profile only", () =>
    Effect.gen(function*() {
      const location = yield* tempLocation
      const work = yield* startFakeChrome({ location, profile: WORK, listTabs: Effect.succeed({ tabs: tabsOf("work") }) })
      const home = yield* startFakeChrome({ location, profile: HOME, listTabs: Effect.succeed({ tabs: tabsOf("home") }) })
      yield* work.entry
      yield* home.entry
      const mcp = yield* startMcp(homeOf(location), ["--profile", HOME])
      const tabs: Array<any> = (yield* Effect.promise(() => mcp.callTool("list_tabs"))).structured.tabs
      expect(tabs.map((tab) => tab.title)).toEqual(["home PR", "home docs"])
      expect(work.runs.size).toBe(0)
      expect(home.runs.size).toBe(1)
    }))
})

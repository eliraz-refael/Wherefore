/**
 * The side panel's pure parts: the review model and save plan, the progress line, and display
 * helpers.
 */
import { assert, describe, expect, it } from "@effect/vitest"
import { Run, SavedItem, TabId, WindowId } from "@wherefore/core"
import { DateTime, Option, Schema } from "effect"
import { maskKey, SECTION_ORDER, sectionOf, siteBadge, tagIn, weekBucket, whenLabel } from "../src/ui/format.ts"
import { progressText } from "../src/ui/progress.ts"
import { buildReview, itemFor, namesOf, planOf, saveBarLabel } from "../src/ui/review.ts"

const run = (fields: Record<string, unknown>): Run => {
  const { finishedAt, ...rest } = {
    id: "r",
    mode: "api",
    model: "claude-opus-5-5",
    startedAt: "2026-10-05T09:00:00.000Z",
    finishedAt: "2026-10-05T09:01:00.000Z",
    status: "succeeded",
    tabs: [],
    steps: [],
    intentions: [],
    usage: { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
    ...fields
  }
  return Schema.decodeUnknownSync(Run)(rest.status === "running" ? rest : { ...rest, finishedAt })
}

const snap = (id: number, url: string, extra: Record<string, unknown> = {}) => ({ id, window: 1, index: id, title: `Tab ${id}`, url, ...extra })
const open = (id: number, url: string, pinned = false) => ({
  id: TabId.make(id),
  windowId: WindowId.make(1),
  title: `Tab ${id}`,
  url,
  pinned
})
const intention = (id: string, kind: string, tabIds: ReadonlyArray<number>, extra: Record<string, unknown> = {}) => ({
  id,
  title: `Title ${id}`,
  why: "why",
  kind,
  tabIds,
  confidence: "high",
  evidence: "e",
  ...extra
})

describe("buildReview and planOf", () => {
  const result = run({
    tabs: [snap(1, "https://a.example/?k=REDACTED"), snap(2, "https://b.example/"), snap(3, "https://c.example/"), snap(4, "https://d.example/")],
    intentions: [
      intention("r:0", "decide", [1, 2], { nextStep: "Pick one" }),
      intention("r:1", "dead", [3]),
      intention("r:2", "app", [4])
    ]
  })

  it("follows restored tabs to their new ids, and falls back to the snapshot for closed ones", () => {
    const model = buildReview({
      run: result,
      openTabs: [open(7, "https://a.example/?k=secret"), open(3, "https://c.example/"), open(4, "https://d.example/")],
      items: [],
      remap: new Map([[TabId.make(1), TabId.make(5)], [TabId.make(5), TabId.make(7)]])
    })
    const [first] = model.results
    expect(first?.tag).toBe("decide")
    expect(first?.tabs.map((tab) => [tab.id, tab.url, tab.open])).toEqual([
      [7, "https://a.example/?k=secret", true],
      [2, "https://b.example/", false]
    ])
    const plan = planOf(model, {})
    expect(plan.close).toEqual([7, 3]) // the closed tab 2 is not closed again; the app stays
    expect(saveBarLabel(plan)).toBe("Save 1 and close 2 tabs")
    assert(first !== undefined)
    const item = itemFor(first, { task: "  ", tag: "read" }, "id" as SavedItem["id"], DateTime.makeUnsafe(0))
    expect(Option.map(item, (saved) => [saved.task, saved.tag, saved.tabs.map((tab) => tab.url)])).toEqual(
      Option.some(["Pick one", "read", ["https://a.example/?k=secret", "https://b.example/"]])
    )
  })

  it("keeps pinned tabs open and counts results kept open as left open", () => {
    const model = buildReview({
      run: result,
      openTabs: [open(1, "https://a.example/", true), open(2, "https://b.example/"), open(3, "https://c.example/"), open(4, "https://d.example/")],
      items: [],
      remap: new Map()
    })
    expect(planOf(model, {}).close).toEqual([2, 3])
    const kept = planOf(model, { "r:0": { keepOpen: true } })
    expect(saveBarLabel(kept)).toBe("Close 1 tab")
    expect(kept.leftOpen.map((tab) => tab.id)).toEqual([4, 1, 2])
    expect(saveBarLabel(planOf(model, { "r:0": { savedAs: "x" as SavedItem["id"] } }))).toBe("Close 1 tab")
  })

  it("names things for summary lines", () => {
    expect(namesOf(["Gmail"])).toBe("Gmail")
    expect(namesOf(["Gmail", "Slack", "Gmail"])).toBe("Gmail and Slack")
    expect(namesOf(["a", "b", "c", "d", "e"])).toBe("a, b, c and 2 more")
  })
})

describe("progressText", () => {
  const at = "2026-10-05T09:00:00.000Z"
  const running = (steps: ReadonlyArray<unknown>, tabs: ReadonlyArray<unknown> = []) =>
    run({ status: "running", steps, tabs })
  it("says what the run is doing in one plain line", () => {
    expect(progressText(running([]))).toBe("Getting started…")
    expect(progressText(running([{ kind: "tool", at, callId: "1", tool: "list_tabs", status: "running", summary: "Listing tabs" }])))
      .toBe("Looking at your tabs…")
    const tabs = [snap(1, "https://a.example/"), snap(2, "https://b.example/")]
    expect(progressText(running([{ kind: "tool", at, callId: "1", tool: "list_tabs", status: "ok", summary: "Listed 2 tabs" }], tabs)))
      .toBe("Found 2 tabs. Thinking about your 2 tabs…")
    expect(progressText(running([{ kind: "tool", at, callId: "2", tool: "read_pages", status: "running", summary: "Reading 3 pages" }], tabs)))
      .toBe("Reading 3 pages…")
    expect(progressText(running([{ kind: "question", at, callId: "3", questions: [] }], tabs))).toBe("Waiting for your answer")
  })
})

describe("format", () => {
  const now = new Date(2026, 9, 7, 15, 0).getTime() // Wednesday 7 Oct 2026, local time
  const ago = (days: number) => DateTime.makeUnsafe(new Date(2026, 9, 7 - days, 10, 0).getTime())
  it("says when, the way a person would", () => {
    expect(whenLabel(ago(0), now)).toBe("today")
    expect(whenLabel(ago(1), now)).toBe("yesterday")
    expect(whenLabel(ago(2), now)).toBe("Monday")
    expect(whenLabel(ago(9), now)).toBe("last week")
    expect(whenLabel(ago(30), now)).toBe("on 7 Sep")
    expect(weekBucket(ago(2), now)).toBe("This week")
    expect(weekBucket(ago(3), now)).toBe("Last week")
    expect(weekBucket(ago(20), now)).toBe("Earlier")
  })

  it("groups tags into the list's sections, do and decide together under To do", () => {
    expect(SECTION_ORDER).toEqual(["todo", "follow_up", "read", "keep"])
    expect((["do", "decide", "track", "read", "keep"] as const).map(sectionOf)).toEqual(
      ["todo", "todo", "follow_up", "read", "keep"]
    )
    // Moving to another section takes that section's tag; moving back keeps the item's own.
    expect(tagIn("read", "decide")).toBe("read")
    expect(tagIn("todo", "decide")).toBe("decide")
    expect(tagIn("todo", "read")).toBe("do")
    expect(tagIn("follow_up", "keep")).toBe("track")
  })

  it("shows a saved key by its last four characters only", () => {
    expect(maskKey("sk-ant-api03-abcdefghijklmnop-WXYZ")).toBe("•••• WXYZ")
    expect(maskKey("short")).toBe("••••")
  })

  it("gives each domain a stable letter and colour instead of fetching its icon", () => {
    expect(siteBadge("github.com")).toEqual(siteBadge("github.com"))
    expect(siteBadge("github.com").letter).toBe("G")
    expect(siteBadge("chrome://settings").letter).toBe("S")
  })
})

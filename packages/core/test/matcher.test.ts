import { describe, expect, it } from "@effect/vitest"
import { matchSavedTabs, SavedItem } from "../src/index.ts"
import { decodeOk } from "./helpers.ts"

const item = (
  id: string,
  urls: ReadonlyArray<string>,
  overrides: { status?: "open" | "done"; savedAt?: string } = {}
) =>
  decodeOk(SavedItem, {
    id,
    type: "todo",
    task: `Task ${id}`,
    intention: `Intention ${id}`,
    why: "",
    tabs: urls.map((url) => ({ title: url, url, domain: "" })),
    status: overrides.status ?? "open",
    savedAt: overrides.savedAt ?? "2026-10-01T00:00:00.000Z",
    ...(overrides.status === "done" ? { doneAt: "2026-10-02T00:00:00.000Z" } : {})
  })

const tab = (id: number, url: string) => ({ id, url })

describe("matchSavedTabs", () => {
  it("splits open tabs into saved and unsaved, keeping their order", () => {
    const pr = item("pr", ["https://github.com/acme/api/pull/412", "https://www.rfc-editor.org/rfc/rfc6749"])
    const tabs = [
      tab(1, "https://news.example/today"),
      tab(2, "https://github.com/acme/api/pull/412/"),
      tab(3, "https://rfc-editor.org/rfc/rfc6749?utm_source=x#section-4"),
      tab(4, "https://github.com/acme/api/pull/413")
    ]
    const { saved, unsaved } = matchSavedTabs(tabs, [pr])
    expect(saved.map((match) => [match.tab.id, match.item.id])).toEqual([[2, "pr"], [3, "pr"]])
    expect(unsaved.map((t) => t.id)).toEqual([1, 4])
  })

  it("matches through tracking parameters, anchors and parameter order", () => {
    const post = item("post", ["https://blog.example/post?id=7&lang=en"])
    const { saved } = matchSavedTabs(
      [tab(1, "https://blog.example/post?lang=en&id=7&utm_campaign=autumn&fbclid=abc#comments")],
      [post]
    )
    expect(saved).toHaveLength(1)
  })

  it("ignores done (archived) items", () => {
    const done = item("done", ["https://x.example/a"], { status: "done" })
    const { saved, unsaved } = matchSavedTabs([tab(1, "https://x.example/a")], [done])
    expect(saved).toEqual([])
    expect(unsaved).toHaveLength(1)
  })

  it("prefers the most recently saved open item when several hold the page", () => {
    const older = item("older", ["https://x.example/a"], { savedAt: "2026-09-01T00:00:00.000Z" })
    const newer = item("newer", ["https://x.example/a"], { savedAt: "2026-10-01T00:00:00.000Z" })
    const done = item("done", ["https://x.example/a"], { status: "done", savedAt: "2026-10-03T00:00:00.000Z" })
    for (const items of [[older, newer, done], [done, newer, older]]) {
      expect(matchSavedTabs([tab(1, "https://x.example/a")], items).saved[0]?.item.id).toBe("newer")
    }
  })

  it("never matches tabs or saved URLs that aren't URLs", () => {
    const odd = item("odd", ["not a url"])
    const { saved, unsaved } = matchSavedTabs([tab(1, "not a url"), tab(2, "")], [odd])
    expect(saved).toEqual([])
    expect(unsaved).toHaveLength(2)
  })

  it("does not conflate pages that differ in identifying parameters or routes", () => {
    const sheet = item("sheet", ["https://docs.example/ccc?key=A", "https://app.example/#/projects/42"])
    const { saved } = matchSavedTabs(
      [tab(1, "https://docs.example/ccc?key=B"), tab(2, "https://app.example/#/projects/43")],
      [sheet]
    )
    expect(saved).toEqual([])
  })

  it("handles no tabs and no items", () => {
    expect(matchSavedTabs([], [item("a", ["https://x.example"])])).toEqual({ saved: [], unsaved: [] })
    expect(matchSavedTabs([tab(1, "https://x.example")], []).unsaved).toHaveLength(1)
  })

  it("passes the caller's tab objects through", () => {
    const original = { id: 9, url: "https://x.example/a", title: "A" }
    const { saved } = matchSavedTabs([original], [item("a", ["https://x.example/a"])])
    expect(saved[0]?.tab).toBe(original)
  })
})

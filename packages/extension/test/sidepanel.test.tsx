// @vitest-environment happy-dom
/**
 * The side panel, rendered with React in a DOM, over the real worker, Store and agent (fake
 * browser, scripted model). See test/fakes/panel.tsx.
 */
import { afterEach, describe, expect, it } from "@effect/vitest"
import { INTERRUPTED_MESSAGE } from "@wherefore/core"
import { cleanup, fireEvent, waitFor, within } from "@testing-library/react"
import { Effect } from "effect"
import { FakeChrome } from "./fakes/chrome.ts"
import { callTools, ScriptedModel, toolCall, toolResults, type Turn } from "./fakes/model.ts"
import { envelope, ISO_NOW, Panels, SETTINGS, storedItem } from "./fakes/panel.tsx"

const panels: Array<Panels> = []
const make = (chrome: FakeChrome, ...rest: ConstructorParameters<typeof Panels> extends [unknown, ...infer R] ? R : never) => {
  const made = new Panels(chrome, ...rest)
  panels.push(made)
  return made
}

afterEach(async () => {
  cleanup()
  for (const made of panels.splice(0)) await made.stop()
})

const storedData = (chrome: FakeChrome, key: string): any => (chrome.local.get(key) as { data: unknown } | undefined)?.data

describe("first run", () => {
  it("asks for an API key, saves it through the worker, then shows the list without the key", async () => {
    const chrome = new FakeChrome({ tabs: [{ id: 1, windowId: 1, url: "https://example.com/" }] })
    const app = make(chrome)
    await app.start()
    const view = app.open()

    const input = await view.ui.findByLabelText("Anthropic API key")
    expect(view.ui.getByText(/Mail, chat, cloud consoles and sign-in pages are never read/)).toBeTruthy()
    const save = view.ui.getByRole("button", { name: "Save key and continue" }) as HTMLButtonElement
    expect(save.disabled).toBe(true)

    fireEvent.change(input, { target: { value: "  sk-ant-secret-key-1234  " } })
    fireEvent.click(save)

    expect(await view.ui.findByRole("heading", { level: 1, name: "Your list is empty" })).toBeTruthy()
    expect(storedData(chrome, "settings")).toEqual({ apiKey: "sk-ant-secret-key-1234" })
    expect(view.container.innerHTML).not.toContain("sk-ant-secret-key")

    // Settings shows it masked, and the model picker offers API_MODELS.
    fireEvent.click(view.ui.getByRole("button", { name: "Settings" }))
    expect(await view.ui.findByText("Saved · •••• 1234")).toBeTruthy()
    const model = view.ui.getByLabelText("Model") as HTMLSelectElement
    expect([...model.options].map((option) => option.textContent)).toEqual(["Claude Opus 5.5", "Claude Sonnet 5.5"])
    expect(model.value).toBe("claude-opus-5-5")
    fireEvent.change(model, { target: { value: "claude-sonnet-5-5" } })
    await waitFor(() => expect(storedData(chrome, "settings").model).toBe("claude-sonnet-5-5"))
    expect(view.container.innerHTML).not.toContain("sk-ant-secret-key")
  })
})

const listChrome = () =>
  new FakeChrome({
    tabs: [
      { id: 1, windowId: 1, url: "https://github.com/acme/api/pull/412?utm_source=mail", title: "Auth PR #412" },
      { id: 2, windowId: 1, url: "https://example.com/other", title: "Other" }
    ],
    local: {
      settings: SETTINGS,
      items: envelope([
        storedItem({ id: "a", task: "Finish the auth PR", tabs: [{ title: "Auth PR #412", url: "https://github.com/acme/api/pull/412" }] }),
        storedItem({ id: "b", task: "Watch the Vite release", type: "follow_up", tabs: [{ title: "Vite", url: "https://vite.dev/" }] }),
        storedItem({ id: "c", task: "Read the Effect guide", type: "read", tabs: [{ title: "Effect", url: "https://effect.website/" }] }),
        storedItem({ id: "d", task: "Chrome API reference", type: "keep", tabs: [{ title: "tabs API", url: "https://developer.chrome.com/docs/extensions/reference/api/tabs" }] }),
        storedItem({ id: "e", task: "Pick a desk", tabs: [{ title: "Desk", url: "https://shop.example/desk" }] }),
        storedItem({ id: "f", task: "Book the dentist", status: "done", tabs: [{ title: "Dentist", url: "https://dentist.example/" }] })
      ])
    }
  })

describe("Your list", () => {
  it("groups open items by type, with each tab's title and domain, and links to the Done archive", async () => {
    const app = make(listChrome())
    await app.start()
    const view = app.open()

    expect(await view.ui.findByRole("heading", { level: 1, name: "5 things you meant to do" })).toBeTruthy()
    const groups = view.ui.getAllByRole("heading", { level: 2 }).map((heading: HTMLElement) => heading.textContent)
    expect(groups).toEqual(["To do", "Follow up", "Read", "Keep"])
    const todo = within(view.ui.getByRole("region", { name: "To do" }))
    expect(todo.getAllByRole("article").map((card) => card.querySelector(".wf-item-task")?.textContent).sort()).toEqual([
      "Finish the auth PR",
      "Pick a desk"
    ])
    expect(within(view.ui.getByRole("region", { name: "Keep" })).getByText("Chrome API reference")).toBeTruthy()

    // Expanding shows the tabs: title and domain.
    const toggle = view.ui.getByRole("button", { name: /^Chrome API reference/ })
    fireEvent.click(toggle)
    expect(toggle.getAttribute("aria-expanded")).toBe("true")
    const tab = view.ui.getByRole("link", { name: /tabs API/ })
    expect(tab.textContent).toContain("developer.chrome.com")
    expect(tab.getAttribute("href")).toBe("https://developer.chrome.com/docs/extensions/reference/api/tabs")

    fireEvent.click(view.ui.getByRole("button", { name: "Done · 1" }))
    expect(await view.ui.findByRole("heading", { level: 1, name: "Done" })).toBeTruthy()
    expect(view.ui.getByText("Book the dentist")).toBeTruthy()
    expect(view.ui.getByText("1 tab · done today")).toBeTruthy()
  })

  it("Done closes the item's open tabs and archives it; Undo brings both back", async () => {
    const chrome = listChrome()
    const app = make(chrome)
    await app.start()
    const view = app.open()

    fireEvent.click(await view.ui.findByRole("button", { name: "Done: Finish the auth PR" }))
    expect(await view.ui.findByText("Done. Closed 1 tab.")).toBeTruthy()
    // The open tab matched despite its tracking parameter; the other tab stays.
    expect(chrome.tabs.map((tab) => tab.id)).toEqual([2])
    expect(storedData(chrome, "items").find((item: any) => item.id === "a").status).toBe("done")
    await waitFor(() => expect(view.ui.queryByText("Finish the auth PR")).toBeNull())
    expect(view.ui.getByRole("button", { name: "Done · 2" })).toBeTruthy()
    // Focus moved on to the next item, not lost.
    expect(document.activeElement?.getAttribute("data-item-toggle")).toBe("e")

    fireEvent.click(view.ui.getByRole("button", { name: "Undo" }))
    expect(await view.ui.findByText("“Finish the auth PR” is back on your list.")).toBeTruthy()
    expect(storedData(chrome, "items").find((item: any) => item.id === "a").status).toBe("open")
    expect(chrome.tabs.map((tab) => tab.url)).toContain("https://github.com/acme/api/pull/412?utm_source=mail")
    expect(await view.ui.findByText("Finish the auth PR")).toBeTruthy()
  })

  it("Remove deletes the item (its tabs stay); Undo puts it back where it was", async () => {
    const chrome = listChrome()
    const app = make(chrome)
    await app.start()
    const view = app.open()

    fireEvent.click(await view.ui.findByRole("button", { name: /^Watch the Vite release/ }))
    fireEvent.click(view.ui.getByRole("button", { name: "Remove from list" }))
    expect(await view.ui.findByText("Removed “Watch the Vite release”.")).toBeTruthy()
    expect(storedData(chrome, "items").map((item: any) => item.id)).toEqual(["a", "c", "d", "e", "f"])
    expect(chrome.tabs).toHaveLength(2)
    await waitFor(() => expect(view.ui.queryByRole("region", { name: "Follow up" })).toBeNull())

    fireEvent.click(view.ui.getByRole("button", { name: "Undo" }))
    await waitFor(() => expect(storedData(chrome, "items").map((item: any) => item.id)).toEqual(["a", "b", "c", "d", "e", "f"]))
    expect(await view.ui.findByRole("region", { name: "Follow up" })).toBeTruthy()
  })

  it("edits a task in place and keeps focus on the item", async () => {
    const chrome = listChrome()
    const app = make(chrome)
    await app.start()
    const view = app.open()

    fireEvent.click(await view.ui.findByRole("button", { name: /^Pick a desk/ }))
    fireEvent.click(view.ui.getByRole("button", { name: "Edit" }))
    const input = view.ui.getByLabelText("Task")
    await waitFor(() => expect(document.activeElement).toBe(input))
    fireEvent.change(input, { target: { value: "Pick a standing desk" } })
    fireEvent.click(view.ui.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(storedData(chrome, "items").find((item: any) => item.id === "e").task).toBe("Pick a standing desk"))
    await waitFor(() => expect(document.activeElement?.getAttribute("data-item-toggle")).toBe("e"))
  })
})

// ---------- Tidy up ----------

const intention = (id: string, title: string, kind: string, tabIds: ReadonlyArray<number>, extra: Record<string, unknown> = {}) => ({
  id,
  title,
  why: `Why: ${title}`,
  kind,
  tabIds,
  confidence: "high",
  evidence: "titles",
  ...extra
})

const snapshot = (id: number, window: number, index: number, title: string, url: string, flags: Record<string, unknown> = {}) => ({
  id,
  window,
  index,
  title,
  url,
  ...flags
})

/**
 * A finished run waiting for review. The panel is in window 2, whose two tabs both close. The
 * snapshot's URL for tab 10 is redacted, as the model saw it; the open tab has the real one.
 */
const reviewChrome = () => {
  const run = {
    id: "run-1",
    mode: "api",
    model: "claude-opus-5-5",
    startedAt: ISO_NOW(),
    finishedAt: ISO_NOW(),
    status: "succeeded",
    tabs: [
      snapshot(10, 2, 0, "Auth PR", "https://github.com/acme/api/pull/7?token=REDACTED"),
      snapshot(11, 2, 1, "AUTH-1", "https://linear.app/acme/issue/AUTH-1"),
      snapshot(12, 1, 0, "Vite 8", "https://vite.dev/blog"),
      snapshot(13, 1, 1, "Effect docs", "https://effect.website/docs"),
      snapshot(14, 1, 2, "Order delivered", "https://shop.example/order/1"),
      snapshot(15, 1, 3, "Sign in", "https://accounts.example/login"),
      snapshot(16, 1, 4, "Inbox", "https://mail.google.com/mail/u/0", { sensitive: true }),
      snapshot(17, 1, 5, "Reference", "https://docs.example/ref", { pinned: true }),
      snapshot(18, 1, 6, "Old thing", "https://tracked.example/thing")
    ],
    steps: [],
    intentions: [
      intention("run-1:0", "Review the auth PR", "work", [10, 11], { nextStep: "Finish reviewing the auth PR" }),
      intention("run-1:1", "Follow the Vite 8 release", "track", [12], { nextStep: "Watch for the Vite 8 release" }),
      intention("run-1:2", "Learn Effect", "read", [13], { confidence: "low" }),
      intention("run-1:3", "Lamp order", "done", [14]),
      intention("run-1:4", "Sign-in page", "dead", [15]),
      intention("run-1:5", "Mail", "app", [16]),
      intention("run-1:6", "Docs reference", "reference", [17]),
      intention("run-1:7", "The old thing", "work", [18])
    ],
    usage: { requests: 2, inputTokens: 1000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.008 }
  }
  return new FakeChrome({
    tabs: [
      { id: 10, windowId: 2, url: "https://github.com/acme/api/pull/7?token=abc", title: "Auth PR" },
      { id: 11, windowId: 2, url: "https://linear.app/acme/issue/AUTH-1", title: "AUTH-1" },
      { id: 12, windowId: 1, url: "https://vite.dev/blog", title: "Vite 8" },
      { id: 13, windowId: 1, url: "https://effect.website/docs", title: "Effect docs" },
      { id: 14, windowId: 1, url: "https://shop.example/order/1", title: "Order delivered" },
      { id: 15, windowId: 1, url: "https://accounts.example/login", title: "Sign in" },
      { id: 16, windowId: 1, url: "https://mail.google.com/mail/u/0", title: "Inbox" },
      { id: 17, windowId: 1, url: "https://docs.example/ref", title: "Reference", pinned: true },
      { id: 18, windowId: 1, url: "https://tracked.example/thing", title: "Old thing" }
    ],
    local: {
      settings: SETTINGS,
      items: envelope([storedItem({ id: "old", task: "The old thing", tabs: [{ title: "Old thing", url: "https://tracked.example/thing" }] })]),
      runIndex: envelope([{ id: "run-1", status: "succeeded" }]),
      "run:run-1": envelope(run)
    }
  })
}

const openReview = async (view: ReturnType<Panels["open"]>) => {
  expect(await view.ui.findByText("Your tidy-up is ready")).toBeTruthy()
  fireEvent.click(view.ui.getByRole("button", { name: "Review" }))
  expect(await view.ui.findByRole("heading", { level: 1, name: "Here’s what your tabs were for" })).toBeTruthy()
}

describe("Tidy up, results", () => {
  it("maps a run's result to the review screen, with smart defaults and the right counts", async () => {
    const app = make(reviewChrome())
    await app.start()
    const view = app.open(2)
    await openReview(view)

    const groups = view.ui.getAllByRole("heading", { level: 2 }).map((heading: HTMLElement) => heading.textContent)
    expect(groups).toEqual(["To do", "Follow up", "Read", "Keep"])
    expect(within(view.ui.getByRole("region", { name: "To do" })).getByText("Finish reviewing the auth PR")).toBeTruthy()
    // Low confidence reads "Not sure"; the confidence itself is never shown.
    const read = within(view.ui.getByRole("region", { name: "Read" }))
    expect(read.getByText("Learn Effect")).toBeTruthy()
    expect(read.getByText("Not sure")).toBeTruthy()
    expect(view.container.textContent).not.toMatch(/confidence|intention|evidence/i)
    // Tab 18 is already in "The old thing": it closes, and isn't offered again.
    expect(view.ui.queryByRole("button", { name: /^The old thing/ })).toBeNull()

    // Saved: the auth PR (2 tabs), Vite, Effect, the reference. Closed: those tabs except the
    // pinned reference, the finished order, the sign-in page and the tab already on the list.
    const bar = view.ui.getByRole("button", { name: "Save 4 and close 7 tabs" })
    expect(bar).toBeTruthy()
    expect(view.ui.getByText("Nothing is lost. You can undo.")).toBeTruthy()
    expect(view.ui.getByText("Left open · 1 tab")).toBeTruthy()
    expect(view.ui.getByText("mail.google.com you use every day")).toBeTruthy()
    const close = view.ui.getByRole("button", { name: /^Close · 3 tabs/ })
    fireEvent.click(close)
    expect(close.getAttribute("aria-expanded")).toBe("true")
    expect(view.ui.getByText("Finished · 1 tab")).toBeTruthy()
    expect(view.ui.getByText("Leftovers · 1 tab")).toBeTruthy()
    expect(view.ui.getByText("Already on your list · 1 tab")).toBeTruthy()

    // Expand a result: edit its task, change its type, read why, see its tabs.
    fireEvent.click(view.ui.getByRole("button", { name: /^Watch for the Vite 8 release/ }))
    expect(view.ui.getByText("Why: Follow the Vite 8 release")).toBeTruthy()
    expect(view.ui.getByText("vite.dev")).toBeTruthy()
    fireEvent.change(view.ui.getByLabelText("Save as"), { target: { value: "Check the Vite 8 notes" } })
    fireEvent.change(view.ui.getByLabelText("Under"), { target: { value: "read" } })
    expect(await within(view.ui.getByRole("region", { name: "Read" })).findByText("Check the Vite 8 notes")).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(view.ui.getByLabelText("Under")))

    // Keep these tabs open: not saved, its tab no longer closes.
    fireEvent.click(view.ui.getByRole("button", { name: "Keep these tabs open" }))
    expect(await view.ui.findByRole("button", { name: "Save 3 and close 6 tabs" })).toBeTruthy()
    expect(view.ui.getByText("Left open · 2 tabs")).toBeTruthy()
  })

  it("saves and closes through the worker, keeping the panel's window open; Undo restores everything", async () => {
    const chrome = reviewChrome()
    const app = make(chrome)
    await app.start()
    const view = app.open(2)
    await openReview(view)

    fireEvent.click(view.ui.getByRole("button", { name: "Save 4 and close 7 tabs" }))
    expect(await view.ui.findByText("Saved 4 and closed 7 tabs.")).toBeTruthy()
    expect(await view.ui.findByRole("heading", { level: 1, name: "5 things you meant to do" })).toBeTruthy()

    // Window 2 (the panel's) lost both its tabs, so the worker opened a new one there first.
    expect(chrome.calls).toContain("tabs.create 2 newtab")
    expect(chrome.tabsIn(2).map((tab) => tab.url)).toEqual(["chrome://newtab/"])
    expect(chrome.tabsIn(1).map((tab) => tab.id)).toEqual([16, 17])
    const items = storedData(chrome, "items")
    expect(items.map((item: any) => [item.task, item.type, item.tabs.length])).toEqual([
      ["The old thing", "todo", 1],
      ["Finish reviewing the auth PR", "todo", 2],
      ["Watch for the Vite 8 release", "follow_up", 1],
      ["Learn Effect", "read", 1],
      ["Docs reference", "keep", 1]
    ])
    // Saved with the real URL, not the redacted one the model saw.
    expect(items[1].tabs[0]).toEqual({ title: "Auth PR", url: "https://github.com/acme/api/pull/7?token=abc", domain: "github.com" })
    expect(storedData(chrome, "run:run-1").reviewedAt).toBeDefined()
    expect(view.ui.queryByText("Your tidy-up is ready")).toBeNull()

    fireEvent.click(view.ui.getByRole("button", { name: "Undo" }))
    expect(await view.ui.findByText("Undone. 7 tabs reopened.")).toBeTruthy()
    expect(storedData(chrome, "items").map((item: any) => item.task)).toEqual(["The old thing"])
    expect(chrome.tabs.map((tab) => tab.url)).toEqual(
      expect.arrayContaining(["https://github.com/acme/api/pull/7?token=abc", "https://shop.example/order/1"])
    )
    expect(storedData(chrome, "run:run-1").reviewedAt).toBeUndefined()
    expect(await view.ui.findByText("Your tidy-up is ready")).toBeTruthy()

    // Back on the results, the restored tabs (new ids) are found again.
    fireEvent.click(view.ui.getByRole("button", { name: "Review" }))
    expect(await view.ui.findByRole("button", { name: "Save 4 and close 7 tabs" })).toBeTruthy()
  })
})

const RUN_TABS = [
  { id: 1, windowId: 1, url: "https://github.com/acme/api/pull/412", title: "Auth PR #412" },
  { id: 2, windowId: 1, url: "https://shop.example/desk-a", title: "Desk A" }
]

const runChrome = () => new FakeChrome({ tabs: RUN_TABS, local: { settings: SETTINGS } })

const question = (id: string, tabIds: ReadonlyArray<number>, text: string, options: ReadonlyArray<string>) => ({
  id,
  tab_ids: tabIds,
  question: text,
  options
})

const submitted = (title: string, kind: string, tabIds: ReadonlyArray<number>) => ({
  title,
  why: `Why: ${title}`,
  kind,
  tab_ids: tabIds,
  confidence: "high",
  evidence: "answers"
})

const submitBoth: Turn = callTools(
  toolCall("submit", "submit_intentions", {
    intentions: [submitted("Finish the auth PR", "work", [1]), submitted("Desk", "done", [2])]
  })
)

/** The answers the model got for an ask, from its next request. */
const answersIn = (answers: Array<unknown>, callId: string, then: Turn): Turn => (prompt) => {
  answers.push(toolResults(prompt).get(callId)?.result)
  return then(prompt)
}

const never: Turn = () => Effect.never

describe("Tidy up, working", () => {
  it("shows questions one at a time, sends the answers together, then the results", async () => {
    const answers: Array<unknown> = []
    const model = new ScriptedModel([
      callTools(toolCall("ask1", "ask_user", {
        questions: [
          question("q1", [1], "Is the auth PR yours?", ["Mine", "Someone else's"]),
          question("q2", [2], "Still buying a desk?", ["Still deciding", "Bought it"])
        ]
      })),
      answersIn(answers, "ask1", submitBoth)
    ])
    const app = make(runChrome(), model)
    await app.start()
    const view = app.open()

    fireEvent.click(await view.ui.findByRole("button", { name: "Tidy up" }))
    expect(await view.ui.findByRole("heading", { level: 2, name: "Is the auth PR yours?" })).toBeTruthy()
    expect(view.ui.getByRole("heading", { level: 1, name: "Tidying up" })).toBeTruthy()
    expect(view.ui.getByRole("progressbar", { name: "Tidy-up progress" })).toBeTruthy()
    expect(view.ui.getByText("Question 1 of 2")).toBeTruthy()
    expect(view.ui.getByText("Waiting for your answer")).toBeTruthy()
    expect(view.ui.queryByRole("heading", { name: "Still buying a desk?" })).toBeNull()
    fireEvent.click(view.ui.getByRole("button", { name: "Show me: Auth PR #412" }))
    expect(view.shown).toEqual([1])

    fireEvent.click(view.ui.getByRole("button", { name: "Mine" }))
    const second = await view.ui.findByRole("heading", { level: 2, name: "Still buying a desk?" })
    expect(view.ui.getByText("Question 2 of 2")).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(second))
    expect(model.calls).toBe(1) // nothing sent until the last answer
    fireEvent.click(view.ui.getByRole("button", { name: "Bought it" }))

    expect(await view.ui.findByRole("heading", { level: 1, name: "Here’s what your tabs were for" })).toBeTruthy()
    expect(answers).toEqual([{ answers: [{ id: "q1", answer: "Mine" }, { id: "q2", answer: "Bought it" }] }])
    expect(view.ui.getByRole("button", { name: "Save 1 and close 2 tabs" })).toBeTruthy()
  })

  it("mirrors a run in a second panel, which can answer its questions; the first answer wins", async () => {
    const answers: Array<unknown> = []
    const model = new ScriptedModel([
      callTools(toolCall("ask1", "ask_user", {
        questions: [question("q1", [1], "Is the auth PR yours?", ["Mine", "Someone else's"])]
      })),
      answersIn(answers, "ask1", submitBoth)
    ])
    const app = make(runChrome(), model)
    await app.start()
    const first = app.open(1)
    const second = app.open(2)

    fireEvent.click(await first.ui.findByRole("button", { name: "Tidy up" }))
    expect(await first.ui.findByRole("heading", { level: 2, name: "Is the auth PR yours?" })).toBeTruthy()

    // The other panel sees the run from the Store and joins it.
    expect(await second.ui.findByText("Tidying up…")).toBeTruthy()
    fireEvent.click(second.ui.getByRole("button", { name: "Show" }))
    expect(await second.ui.findByRole("heading", { level: 2, name: "Is the auth PR yours?" })).toBeTruthy()

    // Both answer at once: the panel running the run gets there first.
    fireEvent.click(first.ui.getByRole("button", { name: "Mine" }))
    fireEvent.click(second.ui.getByRole("button", { name: "Someone else's" }))
    expect(await second.ui.findByText("That question was already answered, or its tidy-up stopped.")).toBeTruthy()
    expect(await first.ui.findByRole("heading", { level: 1, name: "Here’s what your tabs were for" })).toBeTruthy()
    expect(await second.ui.findByRole("heading", { level: 1, name: "Here’s what your tabs were for" })).toBeTruthy()
    expect(answers).toEqual([{ answers: [{ id: "q1", answer: "Mine" }] }])
  })

  it("answers from the second panel reach the run, and Stop there stops it", async () => {
    const answers: Array<unknown> = []
    const model = new ScriptedModel([
      callTools(toolCall("ask1", "ask_user", {
        questions: [question("q1", [1], "Is the auth PR yours?", ["Mine", "Someone else's"])]
      })),
      answersIn(answers, "ask1", () => Effect.never)
    ])
    const app = make(runChrome(), model)
    await app.start()
    const first = app.open(1)
    const second = app.open(2)

    fireEvent.click(await first.ui.findByRole("button", { name: "Tidy up" }))
    fireEvent.click(await second.ui.findByRole("button", { name: "Show" }))
    fireEvent.click(await second.ui.findByRole("button", { name: "Someone else's" }))
    await waitFor(() => expect(answers).toEqual([{ answers: [{ id: "q1", answer: "Someone else's" }] }]))
    expect(await first.ui.findByText(/Thinking about your 2 tabs/)).toBeTruthy()

    fireEvent.click(second.ui.getByRole("button", { name: "Stop" }))
    expect(await first.ui.findByRole("heading", { level: 2, name: "You stopped this tidy-up" })).toBeTruthy()
    expect(await second.ui.findByRole("heading", { level: 2, name: "You stopped this tidy-up" })).toBeTruthy()
  })

  it("shows a run whose panel closed as interrupted, and starts again", async () => {
    const model = new ScriptedModel([never, submitBoth])
    const chrome = runChrome()
    const app = make(chrome, model)
    await app.start()
    const first = app.open(1)
    const second = app.open(2)

    fireEvent.click(await first.ui.findByRole("button", { name: "Tidy up" }))
    fireEvent.click(await second.ui.findByRole("button", { name: "Show" }))
    expect(await second.ui.findByRole("heading", { level: 1, name: "Tidying up" })).toBeTruthy()
    // The run is waiting on the model: every step so far is stored.
    await waitFor(() => expect(model.calls).toBe(1))

    first.crash()
    expect(await second.ui.findByRole("heading", { level: 2, name: "This tidy-up was interrupted" })).toBeTruthy()
    expect(second.ui.getByText(INTERRUPTED_MESSAGE)).toBeTruthy()

    fireEvent.click(second.ui.getByRole("button", { name: "Start again" }))
    expect(await second.ui.findByRole("heading", { level: 1, name: "Here’s what your tabs were for" })).toBeTruthy()
    expect(storedData(chrome, "runIndex").map((entry: any) => entry.status)).toEqual(["interrupted", "succeeded"])
  })
})

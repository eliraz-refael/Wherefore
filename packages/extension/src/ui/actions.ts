/**
 * What the views do, as Effects over the panel's services (panelLayer.ts). Every write goes
 * through the worker (`WorkerClient`); reads come from the Atoms. An action that can be undone
 * returns an `Undo` for its toast.
 */
import {
  type Answer,
  type ApiModel,
  normalizeUrl,
  type ResettableKey,
  type Run,
  type SavedItem,
  SavedItemId,
  type Settings,
  type TabId,
  type UndoResult,
  type UndoToken
} from "@wherefore/core"
import { DateTime, Effect, Option } from "effect"
import { WorkerClient } from "../messaging/WorkerClient.ts"
import { settingsKey } from "../store/keys.ts"
import { StoreReader } from "../store/StoreReader.ts"
import { Atom, type AtomRegistry } from "../unstable.ts"
import { choicesAtom, itemsAtom, openTabsAtom, remapAtom, runsAtom, settingsAtom } from "./atoms.ts"
import { plural, tabCount } from "./format.ts"
import { type OpenTab, PageTabs } from "./PageTabs.ts"
import type { PanelServices } from "./panelLayer.ts"
import { closable, itemFor, planOf, type ResultChoice, type ReviewModel, type ReviewResult, taskOf } from "./review.ts"
import { Tidy } from "./Tidy.ts"

/** An Effect a view can run (`useRun`). */
export type PanelEffect<A, E = never> = Effect.Effect<A, E, PanelServices | AtomRegistry.AtomRegistry>

/** Undoes an action; returns what to tell the user. Never fails: a failure is the message. */
export type Undo = PanelEffect<string>

/** What an undoable action did: the toast's text and its undo. */
export interface Done {
  readonly message: string
  readonly undo?: Undo
}

/** Every error a view can see, in words for the user. */
export const describeError = (error: unknown): string => {
  const tag = typeof error === "object" && error !== null && "_tag" in error ? String(error._tag) : ""
  const message = typeof error === "object" && error !== null && "message" in error ? String(error.message) : ""
  switch (tag) {
    case "WorkerUnavailable":
      return "The extension's background worker didn't answer. Try again."
    case "BrowserError":
      return `Chrome couldn't do that: ${message}`
    case "ItemNotFound":
      return "That item isn't on your list any more."
    case "StoreUnreadable":
      return "Your saved data couldn't be read. Settings has a way to start fresh."
    case "UndoUnavailable":
      return "It's too late to undo that."
    case "RunAlreadyActive":
      return "A tidy-up is already running in another window."
    case "ModelError":
      return message !== "" ? message : "The model couldn't be reached. Try again."
    default:
      return "Something went wrong. Try again."
  }
}

/** Runs an undo step; a failure becomes its message. */
const undoing = <E>(effect: PanelEffect<string, E>): Undo =>
  effect.pipe(Effect.catch((error) => Effect.succeed(describeError(error))))

const worker = Effect.service(WorkerClient)

// ---------- settings ----------

const updateSettings = (change: (settings: Settings) => Settings) =>
  Effect.gen(function*() {
    const current = yield* (yield* StoreReader).get(settingsKey)
    return yield* (yield* worker).call("update_settings", { settings: change(current) })
  })

/** Saves the API key (trimmed). It is never logged, and views show it masked from now on. */
export const saveApiKey = (key: string) => updateSettings((settings) => ({ ...settings, apiKey: key.trim() }))

export const setModel = (model: ApiModel) => updateSettings((settings) => ({ ...settings, model }))

/** Asks the worker to connect to the companion now ("Check again"). The status atom follows by itself. */
export const checkCompanion = Effect.flatMap(worker, (client) => client.call("check_companion", undefined))

/** Recovers an unreadable key (keeping a backup) and reloads what views show of it. */
export const resetStoreKey = (key: ResettableKey) =>
  Effect.gen(function*() {
    const { backupKey } = yield* (yield* worker).call("reset_store_key", { key })
    if (key === "items") yield* Atom.refresh(itemsAtom)
    else if (key === "settings") yield* Atom.refresh(settingsAtom)
    else yield* Atom.refresh(runsAtom)
    return backupKey
  })

// ---------- tabs ----------

const currentTabs = Atom.getResult(openTabsAtom)

const recordRemap = (result: UndoResult) =>
  Atom.update(remapAtom, (remap) => {
    const next = new Map(remap)
    for (const { from, to } of result.restored) next.set(from, to)
    return next
  })

/** Closes tabs with undo, keeping this panel's window open. */
const closeTabs = (ids: ReadonlyArray<TabId>) =>
  Effect.gen(function*() {
    if (ids.length === 0) return { closed: 0, token: null }
    const windowId = yield* (yield* PageTabs).windowId
    const result = yield* (yield* worker).call("close_tabs", { tabIds: ids, keepWindowAlive: windowId })
    return { closed: result.closed.length, token: result.undo }
  })

const undoClose = (token: UndoToken | null) =>
  token === null
    ? Effect.succeed(0)
    : Effect.gen(function*() {
      const result = yield* (yield* worker).call("undo_close", { token })
      yield* recordRemap(result)
      return result.restored.length
    })

/** The open tabs showing one of the item's pages. */
const openTabsOf = (item: SavedItem): PanelEffect<ReadonlyArray<OpenTab>, unknown> =>
  Effect.map(currentTabs, (tabs) => {
    const pages = new Set(item.tabs.flatMap((tab) => Option.toArray(normalizeUrl(tab.url))))
    return tabs.filter((tab) => Option.match(normalizeUrl(tab.url), { onNone: () => false, onSome: (url) => pages.has(url) }))
  })

/** "Show me": switches to a tab. */
export const showTab = (id: TabId) => Effect.flatMap(Effect.service(PageTabs), (tabs) => tabs.show(id))

// ---------- your list ----------

/** Done: closes the item's open tabs and moves it to the Done archive. */
export const markItemDone = (item: SavedItem) =>
  Effect.gen(function*() {
    const client = yield* worker
    const tabs = yield* openTabsOf(item)
    const { closed, token } = yield* closeTabs(tabs.map((tab) => tab.id))
    // Done is one step for the user: if the item can't be archived, its tabs come back.
    yield* client.call("mark_done", { id: item.id }).pipe(Effect.onError(() => Effect.ignore(undoClose(token))))
    return {
      message: closed === 0 ? `Done: “${item.task}”.` : `Done. Closed ${tabCount(closed)}.`,
      undo: undoing(Effect.gen(function*() {
        yield* undoClose(token)
        yield* client.call("mark_open", { id: item.id })
        return `“${item.task}” is back on your list.`
      }))
    } satisfies Done
  })

/** Remove: deletes the item (its tabs stay as they are), with undo. */
export const removeItem = (item: SavedItem) =>
  Effect.gen(function*() {
    const client = yield* worker
    const removed = yield* client.call("remove_item", { id: item.id })
    return {
      message: `Removed “${item.task}”.`,
      undo: undoing(Effect.as(client.call("restore_item", { removed }), `“${item.task}” is back on your list.`))
    } satisfies Done
  })

/** Open: reopens the item's tabs in this window, as a tab group named after the task. */
export const openItem = (item: SavedItem) =>
  Effect.gen(function*() {
    const windowId = yield* (yield* PageTabs).windowId
    const { tabIds } = yield* (yield* worker).call("resume_item", { id: item.id, windowId })
    return tabIds.length === 0 ? "Couldn't open its tabs." : `Opened ${tabCount(tabIds.length)}.`
  })

export const editTask = (item: SavedItem, task: string) =>
  Effect.flatMap(worker, (client) => client.call("save_items", { items: [{ ...item, task: task.trim() }] }))

/** Moves a done item back to the list. */
export const putBack = (item: SavedItem) =>
  Effect.flatMap(worker, (client) => client.call("mark_open", { id: item.id }))

// ---------- tidy up ----------

/**
 * Tidy up: starts a run in this page, or finds the one already running in another window. Returns
 * the run to show.
 */
export const startTidy = Effect.gen(function*() {
  const tidy = yield* Tidy
  return yield* tidy.start.pipe(
    Effect.catchTag("RunAlreadyActive", (error) =>
      Effect.gen(function*() {
        if (error.runId !== undefined) return error.runId
        const { runs } = yield* Atom.getResult(runsAtom)
        const running = runs.findLast((run) => run.status === "running")
        return running === undefined ? yield* Effect.fail(error) : running.id
      }))
  )
})

export const answerAsk = (run: Run, askId: string, answers: ReadonlyArray<Answer>) =>
  Effect.flatMap(Effect.service(Tidy), (tidy) => tidy.answer(run.id, askId, answers))

export const stopRun = (run: Run) => Effect.flatMap(Effect.service(Tidy), (tidy) => tidy.cancel(run.id))

export const updateChoice = (run: Run, result: ReviewResult, patch: ResultChoice) =>
  Atom.update(choicesAtom(run.id), (choices) => ({
    ...choices,
    [result.intention.id]: { ...choices[result.intention.id], ...patch }
  }))

const newId = Effect.sync(() => SavedItemId.make(crypto.randomUUID()))

/** "Save just this": saves one result now and closes its tabs, with undo. */
export const saveOne = (run: Run, result: ReviewResult) =>
  Effect.gen(function*() {
    const client = yield* worker
    const choice = (yield* Atom.get(choicesAtom(run.id)))[result.intention.id]
    const item = itemFor(result, choice, yield* newId, yield* DateTime.now)
    if (Option.isNone(item)) return { message: "There's nothing to save: its tabs are gone." } satisfies Done
    yield* client.call("save_items", { items: [item.value] })
    yield* updateChoice(run, result, { savedAs: item.value.id })
    const { closed, token } = yield* closeTabs(closable(result.tabs))
    const task = taskOf(result, choice)
    return {
      message: closed === 0 ? `Saved “${task}”.` : `Saved “${task}” and closed ${tabCount(closed)}.`,
      undo: undoing(Effect.gen(function*() {
        yield* undoClose(token)
        yield* client.call("remove_item", { id: item.value.id }).pipe(Effect.catchTag("ItemNotFound", () => Effect.void))
        yield* Atom.update(choicesAtom(run.id), (choices) => {
          const { savedAs: _, ...rest } = choices[result.intention.id] ?? {}
          return { ...choices, [result.intention.id]: rest }
        })
        return `Undone. “${task}” isn't saved.`
      }))
    } satisfies Done
  })

/** "Save N and close M tabs": the whole review in one step, with undo. */
export const saveAndClose = (run: Run, model: ReviewModel) =>
  Effect.gen(function*() {
    const client = yield* worker
    const choices = yield* Atom.get(choicesAtom(run.id))
    const plan = planOf(model, choices)
    const now = yield* DateTime.now
    const items: Array<SavedItem> = []
    for (const result of plan.save) {
      const item = itemFor(result, choices[result.intention.id], yield* newId, now)
      if (Option.isSome(item)) items.push(item.value)
    }
    if (items.length > 0) yield* client.call("save_items", { items })
    const { closed, token } = yield* closeTabs(plan.close)
    yield* client.call("set_run_reviewed", { id: run.id, reviewed: true }).pipe(Effect.ignore)
    const saved = items.length === 0 ? "" : `Saved ${items.length}`
    const message = saved !== "" && closed > 0
      ? `${saved} and closed ${tabCount(closed)}.`
      : saved !== ""
      ? `${saved}.`
      : closed > 0
      ? `Closed ${tabCount(closed)}.`
      : "Done."
    return {
      message,
      undo: undoing(Effect.gen(function*() {
        const restored = yield* undoClose(token)
        yield* Effect.forEach(items, (item) =>
          client.call("remove_item", { id: item.id }).pipe(Effect.catchTag("ItemNotFound", () => Effect.void)), { discard: true })
        yield* client.call("set_run_reviewed", { id: run.id, reviewed: false }).pipe(Effect.ignore)
        return restored === 0 ? "Undone." : `Undone. ${plural(restored, "tab")} reopened.`
      }))
    } satisfies Done
  })

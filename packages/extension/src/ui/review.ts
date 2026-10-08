/**
 * The Tidy up results screen as data: a finished run's intentions, the tabs open now and the
 * user's list, turned into what the screen shows and what "Save N and close M tabs" does. Pure.
 *
 * Smart defaults (canvas v6): every result is saved under its kind's tag (core `dispositionOf`)
 * and its tabs close; finished and dead tabs close; everyday apps stay open; tabs that are already
 * in an item on the list close without a second copy. Pinned tabs never close in bulk.
 */
import {
  dispositionOf,
  domainOf,
  type Intention,
  type ItemTag,
  matchSavedTabs,
  newSavedItem,
  type Run,
  type SavedItem,
  type SavedItemId,
  type SavedTab,
  type TabId
} from "@wherefore/core"
import { type DateTime, Option } from "effect"
import { displayDomain } from "./format.ts"
import type { OpenTab } from "./PageTabs.ts"

/** A tab of the run, as the screen shows it. */
export interface ReviewTab {
  /** The id the tab has now (after an undo, a restored tab has a new id). */
  readonly id: TabId
  readonly title: string
  readonly domain: string
  /** The real URL when the tab is open; else the URL the model saw (redacted). */
  readonly url: string
  readonly open: boolean
  readonly pinned: boolean
}

/** An intention to save: a "result" on the screen. */
export interface ReviewResult {
  readonly intention: Intention
  /** The tag its kind maps to (core `dispositionOf`). */
  readonly tag: ItemTag
  readonly tabs: ReadonlyArray<ReviewTab>
  /** Low confidence. The screen says "Not sure" (and never shows the confidence itself). */
  readonly unsure: boolean
}

export interface ReviewGroup {
  readonly intentions: ReadonlyArray<Intention>
  readonly tabs: ReadonlyArray<ReviewTab>
}

export interface ReviewModel {
  readonly results: ReadonlyArray<ReviewResult>
  /** `done` intentions: the thing behind them is finished. */
  readonly finished: ReviewGroup
  /** `dead` intentions: sign-in and error pages, duplicates. */
  readonly leftovers: ReviewGroup
  /** Open tabs whose page is already in an item on the list. */
  readonly onList: { readonly tabs: ReadonlyArray<ReviewTab>; readonly items: ReadonlyArray<SavedItem> }
  /** `app` intentions: everyday tools, left open. */
  readonly apps: ReviewGroup
}

/** What the user changed on one result. */
export interface ResultChoice {
  readonly task?: string
  readonly tag?: ItemTag
  /** "Keep these tabs open": not saved, tabs stay. */
  readonly keepOpen?: boolean
  /** Already saved on its own ("Save just this"): the item's id. */
  readonly savedAs?: SavedItemId
}

export type Choices = Readonly<Record<string, ResultChoice>>

/** Restored tabs get new ids: `remap` maps an id the run knows to the tab's id now. */
export type TabRemap = ReadonlyMap<TabId, TabId>

const resolve = (remap: TabRemap, id: TabId): TabId => {
  let current = id
  for (let hops = 0; hops < 10; hops++) {
    const next = remap.get(current)
    if (next === undefined) return current
    current = next
  }
  return current
}

export const buildReview = (input: {
  readonly run: Run
  readonly openTabs: ReadonlyArray<OpenTab>
  readonly items: ReadonlyArray<SavedItem>
  readonly remap: TabRemap
}): ReviewModel => {
  const { run, items, remap } = input
  const open = new Map(input.openTabs.map((tab) => [tab.id, tab]))
  const snapshots = new Map(run.tabs.map((tab) => [tab.id, tab]))

  const tabOf = (runId: TabId): ReviewTab => {
    const id = resolve(remap, runId)
    const live = open.get(id)
    if (live !== undefined) {
      return { id, title: live.title, domain: displayDomain(live.url), url: live.url, open: true, pinned: live.pinned }
    }
    const seen = snapshots.get(runId)
    const url = seen?.url ?? ""
    return { id, title: seen?.title ?? "", domain: displayDomain(url), url, open: false, pinned: seen?.pinned === true }
  }

  // Tabs already in an item on the list (by real URL; only open tabs have one).
  const runTabs = run.intentions.flatMap((intention) => intention.kind === "app" ? [] : intention.tabIds.map(tabOf))
  const matched = matchSavedTabs(runTabs.filter((tab) => tab.open), items)
  const onListIds = new Set(matched.saved.map(({ tab }) => tab.id))
  const onListItems = [...new Map(matched.saved.map(({ item }) => [item.id, item])).values()]

  const results: Array<ReviewResult> = []
  const finished: Array<Intention> = []
  const finishedTabs: Array<ReviewTab> = []
  const leftovers: Array<Intention> = []
  const leftoverTabs: Array<ReviewTab> = []
  const apps: Array<Intention> = []
  const appTabs: Array<ReviewTab> = []

  for (const intention of run.intentions) {
    const tabs = intention.tabIds.map(tabOf)
    switch (intention.kind) {
      case "app":
        apps.push(intention)
        appTabs.push(...tabs)
        break
      case "done":
        finished.push(intention)
        finishedTabs.push(...tabs.filter((tab) => !onListIds.has(tab.id)))
        break
      case "dead":
        leftovers.push(intention)
        leftoverTabs.push(...tabs.filter((tab) => !onListIds.has(tab.id)))
        break
      default: {
        const disposition = dispositionOf(intention.kind)
        const fresh = tabs.filter((tab) => !onListIds.has(tab.id))
        // Every tab is in an item already: nothing new to save.
        if (disposition._tag !== "Save" || fresh.length === 0) break
        results.push({ intention, tag: disposition.tag, tabs: fresh, unsure: intention.confidence === "low" })
      }
    }
  }

  return {
    results,
    finished: { intentions: finished, tabs: finishedTabs },
    leftovers: { intentions: leftovers, tabs: leftoverTabs },
    onList: { tabs: runTabs.filter((tab) => onListIds.has(tab.id)), items: onListItems },
    apps: { intentions: apps, tabs: appTabs }
  }
}

/** The task a result is saved under: the user's text, else the model's next step, else the title. */
export const defaultTask = (intention: Intention): string => {
  const next = intention.nextStep?.trim() ?? ""
  return next !== "" ? next : intention.title
}

/** The short title a result is listed by: the model's `short_title`, else the intention's title (as `newSavedItem`). */
export const titleOf = (intention: Intention): string => {
  const short = intention.shortTitle?.trim() ?? ""
  return short !== "" ? short : intention.title
}

export const taskOf = (result: ReviewResult, choice: ResultChoice | undefined): string => {
  const typed = choice?.task?.trim() ?? ""
  return typed !== "" ? typed : defaultTask(result.intention)
}

export const tagOf = (result: ReviewResult, choice: ResultChoice | undefined): ItemTag => choice?.tag ?? result.tag

export const toSavedTab = (tab: ReviewTab): SavedTab => ({ title: tab.title, url: tab.url, domain: domainOf(tab.url) })

/** Tabs that may be closed: open, not pinned, each once. */
export const closable = (tabs: ReadonlyArray<ReviewTab>): ReadonlyArray<TabId> => [
  ...new Set(tabs.filter((tab) => tab.open && !tab.pinned).map((tab) => tab.id))
]

/** A result's item, as it would be saved. `None` when it has no tab with a URL. */
export const itemFor = (
  result: ReviewResult,
  choice: ResultChoice | undefined,
  id: SavedItemId,
  savedAt: DateTime.Utc
): Option.Option<SavedItem> => {
  const tabs = result.tabs.filter((tab) => tab.url !== "").map(toSavedTab)
  const [first, ...rest] = tabs
  if (first === undefined) return Option.none()
  return Option.map(
    newSavedItem({ id, intention: result.intention, tabs: [first, ...rest], savedAt }),
    (item): SavedItem => ({ ...item, task: taskOf(result, choice), tag: tagOf(result, choice) })
  )
}

export interface Plan {
  /** Results to save now. */
  readonly save: ReadonlyArray<ReviewResult>
  /** Tabs to close: the saved results', finished, leftovers and those already on the list. */
  readonly close: ReadonlyArray<TabId>
  /** Tabs left open: everyday apps and results kept open. */
  readonly leftOpen: ReadonlyArray<ReviewTab>
}

/** What "Save N and close M tabs" does, with the user's choices applied. */
export const planOf = (model: ReviewModel, choices: Choices): Plan => {
  const pending = model.results.filter((result) => choices[result.intention.id]?.savedAs === undefined)
  const save = pending.filter((result) => choices[result.intention.id]?.keepOpen !== true)
  const kept = pending.filter((result) => choices[result.intention.id]?.keepOpen === true)
  const close = closable([
    ...save.flatMap((result) => result.tabs),
    ...model.finished.tabs,
    ...model.leftovers.tabs,
    ...model.onList.tabs
  ])
  return { save, close, leftOpen: [...model.apps.tabs, ...kept.flatMap((result) => result.tabs)] }
}

/** The save bar's label. */
export const saveBarLabel = (plan: Plan): string => {
  const n = plan.save.length
  const m = plan.close.length
  if (n > 0 && m > 0) return `Save ${n} and close ${m === 1 ? "1 tab" : `${m} tabs`}`
  if (n > 0) return `Save ${n}`
  if (m > 0) return `Close ${m === 1 ? "1 tab" : `${m} tabs`}`
  // Nothing left to save or close: the bar still finishes the review, so it stops waiting.
  return "Done"
}

/** "Gmail, Slack and 4 more": names for a summary line. */
export const namesOf = (names: ReadonlyArray<string>, max = 3): string => {
  const unique = [...new Set(names.filter((name) => name !== ""))]
  if (unique.length <= max) {
    return unique.length <= 1 ? (unique[0] ?? "") : `${unique.slice(0, -1).join(", ")} and ${unique.at(-1)}`
  }
  return `${unique.slice(0, max).join(", ")} and ${unique.length - max} more`
}

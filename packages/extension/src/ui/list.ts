/**
 * Your list's order, search and filter: which open items show, in which section ("Coming up" for
 * items with a date, soonest first; "Anytime" for the rest, by tag), and the line under each
 * title. Pure: no React, no Effect services.
 */
import { type ItemTag, type SavedItem } from "@wherefore/core"
import { DateTime } from "effect"
import { parseCalendarDate } from "./dates.ts"
import { displayDomain, tabCount } from "./format.ts"

/** The order of tags in "Anytime" and in the filter chips. */
export const TAG_ORDER: ReadonlyArray<ItemTag> = ["do", "track", "decide", "read", "keep"]

/** A filter chip: every item, or one tag. */
export type TagFilter = ItemTag | "all"

const newestFirst = (a: SavedItem, b: SavedItem) => DateTime.toEpochMillis(b.savedAt) - DateTime.toEpochMillis(a.savedAt)

/** The open items, newest first (ties keep the stored order). */
export const openItems = (items: ReadonlyArray<SavedItem>): ReadonlyArray<SavedItem> =>
  items.filter((item) => item.status === "open").sort(newestFirst)

/** The domain shown for a tab: the saved one, else read from its URL. */
const tabDomain = (tab: SavedItem["tabs"][number]): string => (tab.domain === "" ? displayDomain(tab.url) : tab.domain)

/** An item's sites, each once, in tab order. */
export const itemDomains = (item: SavedItem): ReadonlyArray<string> => [...new Set(item.tabs.map(tabDomain))]

/** The line under an item's title: "3 tabs · github.com, docs.google.com" (at most two sites). */
export const metaLine = (item: SavedItem): string => {
  const domains = itemDomains(item).slice(0, 2)
  return domains.length === 0 ? tabCount(item.tabs.length) : `${tabCount(item.tabs.length)} · ${domains.join(", ")}`
}

/** The words of a search, lower-cased. None for a blank query. */
export const searchWords = (query: string): ReadonlyArray<string> =>
  query.trim().toLowerCase().split(/\s+/).filter((word) => word !== "")

/**
 * Whether every word is somewhere in the item: its title, task, why, or a tab's title or domain.
 * No words match everything.
 */
export const matchesSearch = (item: SavedItem, words: ReadonlyArray<string>): boolean => {
  if (words.length === 0) return true
  const text = [item.title, item.task, item.why, ...item.tabs.flatMap((tab) => [tab.title, tabDomain(tab)])]
    .join("\n")
    .toLowerCase()
  return words.every((word) => text.includes(word))
}

/** How many items have each tag. */
export const tagCounts = (items: ReadonlyArray<SavedItem>): { readonly [T in ItemTag]: number } => {
  const counts = { do: 0, track: 0, decide: 0, read: 0, keep: 0 }
  for (const item of items) counts[item.tag]++
  return counts
}

/** Whether an item goes under "Coming up": it has a date that can be read. */
const hasDate = (item: SavedItem): boolean => item.due !== undefined && parseCalendarDate(item.due.date) !== undefined

export interface ListSections {
  /** Items with a date, soonest first (so overdue ones lead). */
  readonly comingUp: ReadonlyArray<SavedItem>
  /** The rest, by tag (`TAG_ORDER`), keeping their order within a tag. */
  readonly anytime: ReadonlyArray<SavedItem>
}

/**
 * The items that match `filter` and `query`, in sections. `items` are the open items in list
 * order (`openItems`); the sorts are stable, so ties keep it.
 */
export const listSections = (
  items: ReadonlyArray<SavedItem>,
  { filter, query }: { readonly filter: TagFilter; readonly query: string }
): ListSections => {
  const words = searchWords(query)
  const shown = items.filter((item) => (filter === "all" || item.tag === filter) && matchesSearch(item, words))
  return {
    // YYYY-MM-DD compares as text in date order.
    comingUp: shown.filter(hasDate).sort((a, b) => (a.due!.date < b.due!.date ? -1 : a.due!.date > b.due!.date ? 1 : 0)),
    anytime: shown.filter((item) => !hasDate(item)).sort((a, b) => TAG_ORDER.indexOf(a.tag) - TAG_ORDER.indexOf(b.tag))
  }
}

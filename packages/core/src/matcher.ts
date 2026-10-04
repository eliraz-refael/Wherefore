/**
 * Incremental triage (architecture A6): before calling the model, match open tabs to the
 * tabs of open saved items, so "15 tabs are already saved" needs no model call.
 */
import { DateTime, Option } from "effect"
import type { SavedItem } from "./savedItem.ts"
import { normalizeUrl } from "./url.ts"

export interface SavedTabMatch<T> {
  readonly tab: T
  readonly item: SavedItem
}

export interface TabMatches<T> {
  /** Open tabs whose page is already in an open saved item. */
  readonly saved: ReadonlyArray<SavedTabMatch<T>>
  /** Everything else: what the model still has to look at. */
  readonly unsaved: ReadonlyArray<T>
}

/**
 * Splits open tabs into those that belong to an open saved item and the rest, comparing
 * URLs with `normalizeUrl`. Pass the tabs' real URLs, not the redacted ones the model sees.
 *
 * Done (archived) items are ignored: a tab reopened after its item was done is new again.
 * When several open items hold the same page, the most recently saved one wins. Tabs keep
 * their input order in both lists.
 */
export const matchSavedTabs = <T extends { readonly url: string }>(
  tabs: ReadonlyArray<T>,
  items: ReadonlyArray<SavedItem>
): TabMatches<T> => {
  const byUrl = new Map<string, SavedItem>()
  for (const item of items) {
    if (item.status !== "open") continue
    for (const savedTab of item.tabs) {
      const key = normalizeUrl(savedTab.url)
      if (Option.isNone(key)) continue
      const current = byUrl.get(key.value)
      if (current === undefined || DateTime.isGreaterThan(item.savedAt, current.savedAt)) byUrl.set(key.value, item)
    }
  }

  const saved: Array<SavedTabMatch<T>> = []
  const unsaved: Array<T> = []
  for (const tab of tabs) {
    const item = Option.flatMap(normalizeUrl(tab.url), (key) => Option.fromNullishOr(byUrl.get(key)))
    if (Option.isSome(item)) saved.push({ tab, item: item.value })
    else unsaved.push(tab)
  }
  return { saved, unsaved }
}

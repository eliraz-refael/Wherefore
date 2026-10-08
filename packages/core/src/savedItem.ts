/**
 * The tracker: intentions the user saved so their tabs could be closed.
 *
 * A saved item keeps each tab's title, real URL, favicon URL and domain, so the UI can show
 * it and reopen one tab or all of them. No screenshots or page snapshots are stored.
 *
 * An item is `open` until the user marks it done: its tabs close and it moves to the Done
 * archive, keeping its tabs, title and `doneAt`. Removing an item deletes it outright (no
 * status, no archive); `removeItem` / `restoreItem` let the UI undo that. `removeTab` /
 * `restoreTab` do the same for one of an item's tabs; removing its last tab removes the item.
 */
import { Data, DateTime, Option, Schema } from "effect"
import { SavedItemId } from "./ids.ts"
import { Due, type IntentionKind } from "./intention.ts"

/** What kind of thing an item is, shown as a tag next to its title. From the intention kind (`dispositionOf`). */
export const ItemTag = Schema.Literals(["do", "track", "decide", "read", "keep"])
export type ItemTag = typeof ItemTag.Type

export const tagLabel: { readonly [T in ItemTag]: string } = {
  do: "Do",
  track: "Track",
  decide: "Decide",
  read: "Read",
  keep: "Keep"
}

/** `done`: finished and archived. A removed item has no status: it is deleted. */
export const SavedItemStatus = Schema.Literals(["open", "done"])
export type SavedItemStatus = typeof SavedItemStatus.Type

/** A tab as it was when saved. The URL is the real one; the model only ever saw a redacted copy. */
export const SavedTab = Schema.Struct({
  title: Schema.String,
  url: Schema.NonEmptyString,
  faviconUrl: Schema.optionalKey(Schema.String),
  /** For display next to the title, e.g. "github.com" (see `domainOf`). */
  domain: Schema.String
})
export type SavedTab = typeof SavedTab.Type

const DateTimeUtc = Schema.DateTimeUtcFromString

export const SavedItem = Schema.Struct({
  id: SavedItemId,
  tag: ItemTag,
  /** A few words to list it by: the model's `short_title`, else the intention's title. */
  title: Schema.NonEmptyString,
  /** The one-line task. Starts as the model's `next_step` (or the intention's title); the user can edit it. */
  task: Schema.NonEmptyString,
  /** The intention's title. */
  intention: Schema.String,
  why: Schema.String,
  /** The date the pages gave for it, if any. `source` is page text, quoted by the model. */
  due: Schema.optionalKey(Due),
  tabs: Schema.Array(SavedTab).check(Schema.isMinLength(1)),
  status: SavedItemStatus,
  savedAt: DateTimeUtc,
  /** When it was marked done; absent while open. */
  doneAt: Schema.optionalKey(DateTimeUtc)
}).check(
  Schema.makeFilter((item) =>
    (item.status === "done") === (item.doneAt !== undefined) ||
    "doneAt must be set exactly when the item is done"
  )
)
export type SavedItem = typeof SavedItem.Type

/** What an intention's tabs become after review. */
export type Disposition = Data.TaggedEnum<{
  /** Save as an item with this tag, then close the tabs. */
  Save: { readonly tag: ItemTag }
  /** Nothing left to do: close the tabs (done and dead). */
  Close: {}
  /** An everyday tool or inbox: leave it open, save nothing. */
  KeepOpen: {}
}>
export const Disposition = Data.taggedEnum<Disposition>()

export const dispositionOf = (kind: IntentionKind): Disposition => {
  switch (kind) {
    case "work":
      return Disposition.Save({ tag: "do" })
    case "track":
      return Disposition.Save({ tag: "track" })
    case "decide":
      return Disposition.Save({ tag: "decide" })
    case "read":
      return Disposition.Save({ tag: "read" })
    case "reference":
      return Disposition.Save({ tag: "keep" })
    case "done":
    case "dead":
      return Disposition.Close()
    case "app":
      return Disposition.KeepOpen()
  }
}

/** The intention fields a saved item is made from. */
export interface SavableIntention {
  readonly title: string
  readonly shortTitle?: string
  readonly why: string
  readonly nextStep?: string
  readonly due?: Due
  readonly kind: IntentionKind
}

/**
 * A new, open saved item for an intention; `None` for kinds that aren't saved (done, dead, app).
 * The task is the model's `next_step`, and the title its `short_title`; both fall back to the
 * intention's title.
 */
export const newSavedItem = (input: {
  readonly id: SavedItemId
  readonly intention: SavableIntention
  readonly tabs: readonly [SavedTab, ...Array<SavedTab>]
  readonly savedAt: DateTime.Utc
}): Option.Option<SavedItem> => {
  const disposition = dispositionOf(input.intention.kind)
  if (disposition._tag !== "Save") return Option.none()
  const { intention } = input
  const nextStep = intention.nextStep?.trim() ?? ""
  const shortTitle = intention.shortTitle?.trim() ?? ""
  return Option.some({
    id: input.id,
    tag: disposition.tag,
    title: shortTitle !== "" ? shortTitle : intention.title,
    task: nextStep !== "" ? nextStep : intention.title,
    intention: intention.title,
    why: intention.why,
    ...(intention.due === undefined ? {} : { due: intention.due }),
    tabs: input.tabs,
    status: "open",
    savedAt: input.savedAt
  })
}

/** Marks an item done (it moves to the Done archive), recording when. */
export const markDone = (item: SavedItem, at: DateTime.Utc): SavedItem => ({ ...item, status: "done", doneAt: at })

/** Moves a done item back to open, e.g. to undo "Done". */
export const reopen = (item: SavedItem): SavedItem => {
  const { doneAt: _, ...rest } = item
  return { ...rest, status: "open" }
}

/** A removed item and where it was, so `restoreItem` can put it back. A schema, so it can cross to the worker. */
export const RemovedItem = Schema.Struct({
  item: SavedItem,
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})
export type RemovedItem = typeof RemovedItem.Type

/** Deletes an item from the list. `None` when no item has that id. */
export const removeItem = (
  items: ReadonlyArray<SavedItem>,
  id: SavedItemId
): Option.Option<{ readonly items: ReadonlyArray<SavedItem>; readonly removed: RemovedItem }> => {
  const index = items.findIndex((item) => item.id === id)
  const item = items[index]
  if (item === undefined) return Option.none()
  return Option.some({ items: items.filter((_, i) => i !== index), removed: { item, index } })
}

/**
 * Undoes `removeItem`: puts the item back where it was (clamped to the list's current length).
 * A no-op when an item with that id is already in the list.
 */
export const restoreItem = (items: ReadonlyArray<SavedItem>, removed: RemovedItem): ReadonlyArray<SavedItem> => {
  if (items.some((item) => item.id === removed.item.id)) return items
  const index = Math.min(Math.max(removed.index, 0), items.length)
  return [...items.slice(0, index), removed.item, ...items.slice(index)]
}

/**
 * A tab removed from an item and where it was, so `restoreTab` can put it back. `copiesLeft` is how
 * many tabs with its URL the item still had, so an item may hold the same URL twice and undo still
 * knows whether this copy is back.
 */
export const RemovedTab = Schema.Struct({
  itemId: SavedItemId,
  tab: SavedTab,
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  copiesLeft: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
})
export type RemovedTab = typeof RemovedTab.Type

/**
 * What removing one tab did: `TabRemoved` (undo with `restoreTab`), or, when it was the item's
 * last tab, `ItemRemoved`: the whole item is gone (undo with `restoreItem`; it keeps its tab).
 */
export const TabRemoval = Schema.Union([
  Schema.TaggedStruct("TabRemoved", { removed: RemovedTab }),
  Schema.TaggedStruct("ItemRemoved", { removed: RemovedItem })
])
export type TabRemoval = typeof TabRemoval.Type

/**
 * Deletes one tab from an item: the tab at `index` if its URL is `url`, else the first tab with
 * that URL (the list may have changed since the caller looked). `None` when no item has that id
 * or it has no such tab.
 */
export const removeTab = (
  items: ReadonlyArray<SavedItem>,
  id: SavedItemId,
  tab: { readonly index: number; readonly url: string }
): Option.Option<{ readonly items: ReadonlyArray<SavedItem>; readonly removal: TabRemoval }> => {
  const item = items.find((item) => item.id === id)
  if (item === undefined) return Option.none()
  const index = item.tabs[tab.index]?.url === tab.url ? tab.index : item.tabs.findIndex((saved) => saved.url === tab.url)
  const removedTab = item.tabs[index]
  if (removedTab === undefined) return Option.none()
  const rest = item.tabs.filter((_, i) => i !== index)
  if (rest.length === 0) {
    return Option.map(removeItem(items, id), ({ items, removed }) => ({ items, removal: { _tag: "ItemRemoved", removed } }))
  }
  return Option.some({
    items: items.map((saved) => (saved.id === id ? { ...saved, tabs: rest } : saved)),
    removal: {
      _tag: "TabRemoved",
      removed: { itemId: id, tab: removedTab, index, copiesLeft: rest.filter((saved) => saved.url === tab.url).length }
    }
  })
}

/**
 * Undoes `removeTab`: puts the tab back where it was in its item (clamped to the item's current
 * tabs). A no-op when the item is gone or this copy of the URL is already back.
 */
export const restoreTab = (items: ReadonlyArray<SavedItem>, removed: RemovedTab): ReadonlyArray<SavedItem> => {
  const item = items.find((item) => item.id === removed.itemId)
  if (item === undefined) return items
  if (item.tabs.filter((tab) => tab.url === removed.tab.url).length > removed.copiesLeft) return items
  const index = Math.min(Math.max(removed.index, 0), item.tabs.length)
  const tabs = [...item.tabs.slice(0, index), removed.tab, ...item.tabs.slice(index)]
  return items.map((saved) => (saved.id === removed.itemId ? { ...saved, tabs } : saved))
}

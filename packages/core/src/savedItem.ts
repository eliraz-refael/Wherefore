/**
 * The tracker: intentions the user saved so their tabs could be closed.
 *
 * A saved item keeps each tab's title, real URL, favicon URL and domain, so the UI can show
 * it and reopen one tab or all of them. No screenshots or page snapshots are stored.
 *
 * An item is `open` until the user marks it done: its tabs close and it moves to the Done
 * archive, keeping its tabs, title and `doneAt`. Removing an item deletes it outright (no
 * status, no archive); `removeItem` / `restoreItem` let the UI undo that.
 */
import { Data, DateTime, Option, Schema } from "effect"
import { SavedItemId } from "./ids.ts"
import type { IntentionKind } from "./intention.ts"

export const TrackerType = Schema.Literals(["todo", "follow_up", "read", "keep"])
export type TrackerType = typeof TrackerType.Type

export const trackerTypeLabel: { readonly [T in TrackerType]: string } = {
  todo: "To do",
  follow_up: "Follow up",
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
  type: TrackerType,
  /** The one-line task. Starts as the model's `next_step` (or the intention's title); the user can edit it. */
  task: Schema.NonEmptyString,
  /** The intention's title. */
  intention: Schema.String,
  why: Schema.String,
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
  /** Save as a tracker item, then close the tabs. */
  Save: { readonly type: TrackerType }
  /** Nothing left to do: close the tabs (done and dead). */
  Close: {}
  /** An everyday tool or inbox: leave it open, save nothing. */
  KeepOpen: {}
}>
export const Disposition = Data.taggedEnum<Disposition>()

export const dispositionOf = (kind: IntentionKind): Disposition => {
  switch (kind) {
    case "work":
    case "decide":
      return Disposition.Save({ type: "todo" })
    case "track":
      return Disposition.Save({ type: "follow_up" })
    case "read":
      return Disposition.Save({ type: "read" })
    case "reference":
      return Disposition.Save({ type: "keep" })
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
  readonly why: string
  readonly nextStep?: string
  readonly kind: IntentionKind
}

/**
 * A new, open saved item for an intention; `None` for kinds that aren't saved (done, dead, app).
 * The task is the model's `next_step`, falling back to the intention's title.
 */
export const newSavedItem = (input: {
  readonly id: SavedItemId
  readonly intention: SavableIntention
  readonly tabs: readonly [SavedTab, ...Array<SavedTab>]
  readonly savedAt: DateTime.Utc
}): Option.Option<SavedItem> => {
  const disposition = dispositionOf(input.intention.kind)
  if (disposition._tag !== "Save") return Option.none()
  const nextStep = input.intention.nextStep?.trim() ?? ""
  return Option.some({
    id: input.id,
    type: disposition.type,
    task: nextStep !== "" ? nextStep : input.intention.title,
    intention: input.intention.title,
    why: input.intention.why,
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

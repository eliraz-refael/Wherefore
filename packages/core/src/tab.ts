/**
 * What the model sees about open tabs: the snapshot from `list_tabs` and the page reads
 * from `read_pages` / `wake_and_read_pages`.
 *
 * Titles, URLs and page text come from the web. They are untrusted data: show them, send
 * them to the model as data, never act on them as instructions.
 */
import { Schema } from "effect"
import { TabId, WindowId } from "./ids.ts"

/** Present and `true`, or absent: keeps the snapshot short for the model. */
const Flag = Schema.optionalKey(Schema.Literal(true))

/** One open tab, before any page content is read. URLs are redacted (see `redactUrl`). */
export const TabSnapshot = Schema.Struct({
  id: TabId,
  window: WindowId,
  /** Position within its window. */
  index: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  title: Schema.String,
  /** Redacted: secret query values replaced, credentials removed. */
  url: Schema.String,
  /** The tab group's title. */
  group: Schema.optionalKey(Schema.String),
  pinned: Flag,
  active: Flag,
  /** Discarded by Chrome's memory saver: reading it needs a reload. */
  asleep: Flag,
  audible: Flag,
  /** The tab that opened this one (Chrome's `openerTabId`). */
  openedFrom: Schema.optionalKey(TabId),
  /** Coarse and relative, e.g. "3d ago". */
  lastUsed: Schema.optionalKey(Schema.String),
  /** The first open tab with the same URL (ignoring the fragment). */
  duplicateOf: Schema.optionalKey(TabId),
  /** A page we never read (mail, chat, cloud consoles, sign-in pages, localhost). */
  sensitive: Flag
})
export type TabSnapshot = typeof TabSnapshot.Type

/** What a page read extracts from a tab. Every text field is untrusted page content. */
export const PageContent = Schema.Struct({
  id: TabId,
  title: Schema.String,
  /** Redacted, like the snapshot's. */
  url: Schema.String,
  headings: Schema.Array(Schema.String),
  description: Schema.String,
  text: Schema.String,
  /** How far down the page the user scrolled, in percent; null for pages too short to scroll. */
  scrollPct: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(100))),
  /** Playback position of the page's video, if it has one. */
  media: Schema.NullOr(Schema.Struct({
    currentSec: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    durationSec: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
  })),
  /** Text the user had selected. */
  selection: Schema.String
})
export type PageContent = typeof PageContent.Type

/** A tab that couldn't be read: gone, asleep, sensitive or blocked. `error` says which, for the model. */
export const PageReadError = Schema.Struct({
  id: TabId,
  error: Schema.String
})
export type PageReadError = typeof PageReadError.Type

export const PageRead = Schema.Union([PageContent, PageReadError])
export type PageRead = typeof PageRead.Type

/**
 * Branded ids, so a tab id can't be passed where a window id is expected (and so on).
 *
 * Tab and window ids are Chrome's own (non-negative integers; Chrome uses -1 for "none").
 * Intention, saved item and question ids are opaque non-empty strings.
 */
import { Schema } from "effect"

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))

/** Chrome's `tabs.Tab.id`. Only valid while the tab is open; a restored tab gets a new id. */
export const TabId = NonNegativeInt.pipe(Schema.brand("TabId"))
export type TabId = typeof TabId.Type

/** Chrome's `windows.Window.id`. */
export const WindowId = NonNegativeInt.pipe(Schema.brand("WindowId"))
export type WindowId = typeof WindowId.Type

/** Identifies one intention within a triage run. Assigned by us, not by the model. */
export const IntentionId = Schema.NonEmptyString.pipe(Schema.brand("IntentionId"))
export type IntentionId = typeof IntentionId.Type

/** Identifies a saved item in the tracker. */
export const SavedItemId = Schema.NonEmptyString.pipe(Schema.brand("SavedItemId"))
export type SavedItemId = typeof SavedItemId.Type

/** Identifies a question within one `ask_user` call. Chosen by the model; answers echo it back. */
export const QuestionId = Schema.NonEmptyString.pipe(Schema.brand("QuestionId"))
export type QuestionId = typeof QuestionId.Type

/** Names one undoable close in the worker's session storage, so undo survives a worker restart. */
export const UndoToken = Schema.NonEmptyString.pipe(Schema.brand("UndoToken"))
export type UndoToken = typeof UndoToken.Type

/** Identifies one triage run, e.g. in its storage key `run:<id>`. */
export const RunId = Schema.NonEmptyString.pipe(Schema.brand("RunId"))
export type RunId = typeof RunId.Type

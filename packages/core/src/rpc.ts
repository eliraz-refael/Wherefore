/**
 * The service worker's RPC surface, defined once (architecture A4: the worker executes tools and
 * owns storage writes; views and, from M2, the companion call it).
 *
 * `WorkerRpcs` is the one group the worker serves to extension pages. It is the merge of:
 * - `TabToolRpcs`: the model's worker-side tools. Tags, payloads, results and errors are the
 *   Toolkit's own (tools.ts), so the payload's wire form is exactly what the model sent. M2's
 *   companion can forward an MCP tool call to the worker without translating it.
 * - `TabRpcs`: closing with undo, and resuming an item as a tab group. Used by the UI only.
 * - `StoreRpcs`: every write to the user's items and settings.
 * - `RunRpcs`: persisting triage runs step by step, marking runs whose page went away, and
 *   answering or stopping a run the companion drives.
 * - `CompanionRpcs`: the state of the worker's link to the companion.
 *
 * `ask_user` and `submit_intentions` are not here: they are answered where the run lives (the page
 * in API mode, the companion's MCP server in MCP mode), not in the worker.
 *
 * `CompanionWorkerRpcs` is what the worker serves the companion's broker on the native port: the
 * tool RPCs plus `CompanionRunRpcs`, through which an MCP (or ACP) run is stored step by step in
 * this profile and asks its questions in this profile's side panel.
 */
import { Schema } from "effect"
import { CompanionStatus } from "./companion.ts"
import { RunId, SavedItemId, TabId, UndoToken, WindowId } from "./ids.ts"
import { Answer, Question } from "./intention.ts"
import { CompanionRunMode, Run, RunMode } from "./run.ts"
import { RemovedItem, SavedItem } from "./savedItem.ts"
import { Settings } from "./settings.ts"
import { ListTabs, ReadPages, ToolError, WakeAndReadPages } from "./tools.ts"
import { Rpc, RpcGroup } from "./unstable.ts"

// ---------- errors ----------

/** A `chrome.*` call failed. `operation` names it, e.g. "tabs.remove". */
export class BrowserError extends Schema.TaggedError<BrowserError>()("BrowserError", {
  operation: Schema.String,
  message: Schema.String
}) {}

/** The undo token is unknown (already used, or never issued) or its undo window has passed. */
export class UndoUnavailable extends Schema.TaggedError<UndoUnavailable>()("UndoUnavailable", {
  reason: Schema.Literals(["expired", "unknown"])
}) {}

/**
 * A stored value couldn't be read: it doesn't decode, or it was written by a newer version.
 * It is never overwritten: the raw value is copied to `backupKey` (when the worker found it), and
 * writes to that key fail with this error until the user decides what to do.
 */
export class StoreUnreadable extends Schema.TaggedError<StoreUnreadable>()("StoreUnreadable", {
  key: Schema.String,
  message: Schema.String,
  backupKey: Schema.optionalKey(Schema.String)
}) {}

/** No saved item has this id. */
export class ItemNotFound extends Schema.TaggedError<ItemNotFound>()("ItemNotFound", {
  id: SavedItemId
}) {}

/**
 * Another triage run is going in this Chrome profile: runs are exclusive per profile, whatever
 * started them (tabs are the profile's, so two triages at once would only double the work). `runId`
 * and `source` say which run, when known.
 */
export class RunAlreadyActive extends Schema.TaggedError<RunAlreadyActive>()("RunAlreadyActive", {
  runId: Schema.optionalKey(RunId),
  source: Schema.optionalKey(RunMode)
}) {}

/**
 * A companion run's update or question arrived after the run ended in the extension (the user
 * stopped it, or it was never opened on this connection). The run's owner should stop.
 */
export class RunNotActive extends Schema.TaggedError<RunNotActive>()("RunNotActive", {
  runId: RunId,
  message: Schema.String
}) {}

/** Nobody can answer a question right now: no side panel is open, or it closed before an answer. */
export class QuestionsUnavailable extends Schema.TaggedError<QuestionsUnavailable>()("QuestionsUnavailable", {
  message: Schema.String
}) {}

const StoreError = Schema.Union([StoreUnreadable, BrowserError])

/** The fixed storage keys the user can reset after `StoreUnreadable` (resetting `runIndex` also drops the runs it listed). */
export const ResettableKey = Schema.Literals(["items", "settings", "runIndex"])
export type ResettableKey = typeof ResettableKey.Type
const ItemError = Schema.Union([ItemNotFound, StoreUnreadable, BrowserError])

// ---------- the model's worker-side tools ----------

/** `list_tabs`, as the worker serves it. The broker forwards the same request (broker.ts). */
export const ListTabsRpc = Rpc.make(ListTabs.name, {
  payload: ListTabs.parametersSchema,
  success: ListTabs.successSchema,
  error: ToolError
})

export const ReadPagesRpc = Rpc.make(ReadPages.name, {
  payload: ReadPages.parametersSchema,
  success: ReadPages.successSchema,
  error: ToolError
})

export const WakeAndReadPagesRpc = Rpc.make(WakeAndReadPages.name, {
  payload: WakeAndReadPages.parametersSchema,
  success: WakeAndReadPages.successSchema,
  error: ToolError
})

/**
 * The model's worker-side tools. Served to extension pages (in `WorkerRpcs`) and, on its own, to
 * the companion over the native-messaging port (companion.ts), so an MCP or ACP agent reaches the
 * same `TabTools` with the same schemas.
 */
export const TabToolRpcs = RpcGroup.make(ListTabsRpc, ReadPagesRpc, WakeAndReadPagesRpc)

// ---------- closing, undo, resume ----------

/** What `close_tabs` did. `undo` is null when nothing was closed. */
export const CloseResult = Schema.Struct({
  closed: Schema.Array(TabId),
  /** Ids that weren't open (already closed, or in another profile). */
  missing: Schema.Array(TabId),
  undo: Schema.NullOr(UndoToken)
})
export type CloseResult = typeof CloseResult.Type

/** A restored tab gets a new id: `from` is the id it had when closed, `to` the new one. */
export const TabRemap = Schema.Struct({ from: TabId, to: TabId })
export type TabRemap = typeof TabRemap.Type

export const UndoResult = Schema.Struct({
  restored: Schema.Array(TabRemap),
  /** Closed tabs that couldn't be brought back (no URL to reopen, or Chrome refused). */
  failed: Schema.Array(TabId)
})
export type UndoResult = typeof UndoResult.Type

export const ResumeResult = Schema.Struct({
  tabIds: Schema.Array(TabId),
  /** The new tab group's id; null when no tab could be opened. */
  groupId: Schema.NullOr(Schema.Int)
})
export type ResumeResult = typeof ResumeResult.Type

export const TabRpcs = RpcGroup.make(
  Rpc.make("close_tabs", {
    payload: {
      tabIds: Schema.Array(TabId),
      /**
       * The caller's window. If every tab in it is being closed, a new tab is opened there
       * first, so the window (and the side panel in it) stays open.
       */
      keepWindowAlive: WindowId
    },
    success: CloseResult,
    error: BrowserError
  }),
  Rpc.make("undo_close", {
    payload: { token: UndoToken },
    success: UndoResult,
    error: Schema.Union([UndoUnavailable, BrowserError])
  }),
  Rpc.make("resume_item", {
    payload: { id: SavedItemId, windowId: WindowId },
    success: ResumeResult,
    error: ItemError
  })
)

// ---------- store writes ----------

export const StoreRpcs = RpcGroup.make(
  /** Adds items; an item whose id is already saved replaces it in place. */
  Rpc.make("save_items", { payload: { items: Schema.Array(SavedItem) }, error: StoreError }),
  /** Moves an item to the Done archive. Returns it as stored. */
  Rpc.make("mark_done", { payload: { id: SavedItemId }, success: SavedItem, error: ItemError }),
  /** Moves a done item back to open (undo of "Done"). */
  Rpc.make("mark_open", { payload: { id: SavedItemId }, success: SavedItem, error: ItemError }),
  /** Deletes an item. Keep the result to undo with `restore_item`. */
  Rpc.make("remove_item", { payload: { id: SavedItemId }, success: RemovedItem, error: ItemError }),
  Rpc.make("restore_item", { payload: { removed: RemovedItem }, error: StoreError }),
  /** Replaces the settings. Returns them as stored. */
  Rpc.make("update_settings", { payload: { settings: Settings }, success: Settings, error: StoreError }),
  /**
   * Recovers a key that can't be read (`StoreUnreadable`): its raw value is kept in a backup key
   * (made now if the worker hasn't made one yet), then the key starts over empty. Returns the
   * backup's key; null when the value was readable, in which case nothing changes.
   */
  Rpc.make("reset_store_key", {
    payload: { key: ResettableKey },
    success: Schema.Struct({ backupKey: Schema.NullOr(Schema.String) }),
    error: BrowserError
  })
)

// ---------- runs ----------

export const RunRpcs = RpcGroup.make(
  /**
   * Stores a run under its own key: replaces the stored run with the same id, or adds it (keeping
   * the newest `MAX_RUNS`; older runs are deleted). The page running it calls this after every
   * step; it is idempotent, so it is safe to retry. Also marks other runs interrupted when their
   * page is gone.
   */
  Rpc.make("save_run", { payload: { run: Run }, error: StoreError }),
  /** Marks every stored run that is still "running" but whose page is gone as interrupted. */
  Rpc.make("check_runs", { error: StoreError }),
  /**
   * Records that the user finished reviewing a run's result (`reviewed: true`), or undoes that.
   * A run that is no longer stored is ignored.
   */
  Rpc.make("set_run_reviewed", { payload: { id: RunId, reviewed: Schema.Boolean }, error: StoreError }),
  /**
   * Answers a question a companion run (MCP, ACP) asked in this profile's panels. The first answer
   * wins: false when the ask is already answered or withdrawn, or isn't a companion run's. API-mode
   * runs are answered in the page running them.
   */
  Rpc.make("answer_ask", {
    payload: { runId: RunId, askId: Schema.String, answers: Schema.Array(Answer) },
    success: Schema.Boolean
  }),
  /**
   * Stops a companion run (MCP, ACP): it is stored as cancelled at once and its agent is told. A run
   * that isn't the companion's, or isn't running, is left alone.
   */
  Rpc.make("stop_run", { payload: { id: RunId }, error: StoreError })
)

// ---------- the companion ----------

export const CompanionRpcs = RpcGroup.make(
  /**
   * The worker's link to the companion (architecture A3), as stored in `chrome.storage.session`.
   * When the companion isn't connected, this also tries to connect now (the worker doesn't retry
   * on its own once it found the companion missing), so "Check again" after installing works
   * without reloading the extension.
   */
  Rpc.make("check_companion", { success: CompanionStatus })
)

/** Everything the worker serves to extension pages. */
export const WorkerRpcs = TabToolRpcs.merge(TabRpcs, StoreRpcs, RunRpcs, CompanionRpcs)

// ---------- runs the companion drives (on the native port) ----------

/**
 * What a companion run's lease (`open_run`) tells its owner: `Opened` once the run is its own (the
 * first element), `Stopped` when the user stopped it from a panel (the last).
 */
export const RunSignal = Schema.Union([
  Schema.TaggedStruct("Opened", {}),
  Schema.TaggedStruct("Stopped", { message: Schema.String })
])
export type RunSignal = typeof RunSignal.Type

export const OpenRunError = Schema.Union([RunAlreadyActive, StoreUnreadable, BrowserError])
export type OpenRunError = typeof OpenRunError.Type

/**
 * Leases a run for the companion: while this stream is open, run `id` is the profile's one active
 * run, owned by the caller. The worker holds the run's Web Locks for it (architecture A4), so an
 * API-mode run can't start meanwhile, and views see the run as alive. Nothing is stored until the
 * first `update_run`.
 *
 * The stream emits `Opened`, then nothing until the user stops the run (`Stopped`, then it ends).
 * When the caller goes away (the stream is interrupted: its MCP client or broker disconnected, or
 * Chrome closed the native port), a run still stored as running is marked interrupted.
 */
export const OpenRunRpc = Rpc.make("open_run", {
  payload: { id: RunId, mode: CompanionRunMode },
  success: RunSignal,
  error: OpenRunError,
  stream: true
})

export const UpdateRunError = Schema.Union([RunNotActive, StoreUnreadable, BrowserError])
export type UpdateRunError = typeof UpdateRunError.Type

/** Stores a leased run as it is now (idempotent), like the page's `save_run`. */
export const UpdateRunRpc = Rpc.make("update_run", {
  payload: { run: Run },
  error: UpdateRunError
})

export const AskPanelError = Schema.Union([QuestionsUnavailable, RunNotActive])
export type AskPanelError = typeof AskPanelError.Type

/**
 * Shows a leased run's questions in this profile's side panel(s) and waits for the answers; the
 * first panel to answer wins (`answer_ask`). The caller records the question step first, so the
 * panel can show it. Fails at once with `QuestionsUnavailable` when no panel is open, and later if
 * every panel closes before an answer. Interrupting it withdraws the questions.
 */
export const AskPanelRpc = Rpc.make("ask_panel", {
  payload: { runId: RunId, askId: Schema.String, questions: Schema.Array(Question) },
  success: Schema.Struct({ answers: Schema.Array(Answer) }),
  error: AskPanelError
})

export const CompanionRunRpcs = RpcGroup.make(OpenRunRpc, UpdateRunRpc, AskPanelRpc)

/** What the worker serves the companion's broker on the native port. */
export const CompanionWorkerRpcs = TabToolRpcs.merge(CompanionRunRpcs)

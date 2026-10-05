/**
 * Everything the extension keeps in `chrome.storage.local` (architecture A5).
 */
import { defaultSettings, Run, type RunId, RunIndexEntry, SavedItem, Settings } from "@wherefore/core"
import { Schema } from "effect"
import type { StoreKey } from "./StoreKey.ts"

/** The user's list: open items and the Done archive (done items keep their tabs and `doneAt`). */
export const itemsKey: StoreKey<ReadonlyArray<SavedItem>> = {
  name: "items",
  version: 1,
  schema: Schema.Array(SavedItem),
  migrations: {},
  empty: []
}

/** API key and model choice. Local only: never `chrome.storage.sync`. */
export const settingsKey: StoreKey<Settings> = {
  name: "settings",
  version: 1,
  schema: Settings,
  migrations: {},
  empty: defaultSettings
}

/** Every run key starts with this; the rest is the run id. */
export const runKeyPrefix = "run:"

/**
 * One triage run, under its own key (`run:<id>`), so a step rewrites only its own run. The page
 * running a run writes it after every step (through the worker), so other views can mirror it.
 * `undefined` when no run has this id (never started, or pruned).
 */
export const runKey = (id: RunId): StoreKey<Run | undefined> => ({
  name: `${runKeyPrefix}${id}`,
  version: 1,
  schema: Schema.UndefinedOr(Run),
  migrations: {},
  empty: undefined
})

/**
 * The stored runs, oldest first, at most `MAX_RUNS` (core run.ts): each run's id and status. The
 * worker writes it together with the run key, so pruning and the interrupted-run sweep read this
 * small key, not every run.
 */
export const runIndexKey: StoreKey<ReadonlyArray<RunIndexEntry>> = {
  name: "runIndex",
  version: 1,
  schema: Schema.Array(RunIndexEntry),
  migrations: {},
  empty: []
}

/** Every fixed key, for startup migration. Run keys are found through `runIndexKey`. */
export const storeKeys: ReadonlyArray<StoreKey<unknown>> = [itemsKey, settingsKey, runIndexKey]

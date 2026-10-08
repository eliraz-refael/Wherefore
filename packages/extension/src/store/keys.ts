/**
 * Everything the extension keeps in `chrome.storage.local` (architecture A5).
 */
import {
  AgentOptions,
  defaultSettings,
  type ItemTag,
  ProfileId,
  Run,
  type RunId,
  RunIndexEntry,
  SavedItem,
  Settings
} from "@wherefore/core"
import { Schema } from "effect"
import type { StoreKey } from "./StoreKey.ts"

/** Version 1 item types, and the tag each became. */
const tagOfType: ReadonlyMap<unknown, ItemTag> = new Map([
  ["todo", "do"],
  ["follow_up", "track"],
  ["read", "read"],
  ["keep", "keep"]
])

const trimmed = (value: unknown): string => (typeof value === "string" ? value.trim() : "")

/**
 * Items, version 1 to 2: the type becomes a tag, and the title is the intention's title (else the
 * task), trimmed. Version 1 had no due dates. Anything else is left for the schema to judge.
 */
const itemsV2 = (data: unknown): unknown => {
  if (!Array.isArray(data)) throw new Error("not a list")
  return data.map((item: unknown) => {
    if (typeof item !== "object" || item === null) throw new Error("an item is not an object")
    const { type, ...rest } = item as Readonly<Record<string, unknown>>
    const tag = tagOfType.get(type)
    if (tag === undefined) throw new Error(`unknown item type ${JSON.stringify(type)}`)
    // A task that is only spaces stays as it was, so the title is never empty.
    const title = [trimmed(rest["intention"]), trimmed(rest["task"])].find((text) => text !== "") ?? rest["task"]
    return { ...rest, tag, title }
  })
}

/** The user's list: open items and the Done archive (done items keep their tabs and `doneAt`). */
export const itemsKey: StoreKey<ReadonlyArray<SavedItem>> = {
  name: "items",
  version: 2,
  schema: Schema.Array(SavedItem),
  migrations: { 1: itemsV2 },
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

/**
 * This Chrome profile's id for the companion (core companion.ts): Chrome doesn't tell a native
 * host which profile started it, so the worker makes a random id at its first connection and
 * sends it every time. `undefined` until then. Kept in `local`, so it survives browser restarts
 * and stays the same for as long as the extension is installed in this profile.
 */
export const profileKey: StoreKey<{ readonly id: ProfileId } | undefined> = {
  name: "profile",
  version: 1,
  schema: Schema.UndefinedOr(Schema.Struct({ id: ProfileId })),
  migrations: {},
  empty: undefined
}

/**
 * What the ACP agent offered on its last run (model, effort), for Settings, with the command it
 * came from: another command's agent offers other settings. Written by the worker when an ACP run
 * starts; `undefined` until the first one.
 */
export const agentOptionsKey: StoreKey<AgentOptions | undefined> = {
  name: "agentOptions",
  version: 1,
  schema: Schema.UndefinedOr(AgentOptions),
  migrations: {},
  empty: undefined
}

/** Every fixed key, for startup migration. Run keys are found through `runIndexKey`. */
export const storeKeys: ReadonlyArray<StoreKey<unknown>> = [itemsKey, settingsKey, runIndexKey, profileKey, agentOptionsKey]

/**
 * The worker's link to the companion (core `CompanionStatus`), in `chrome.storage.session`: it
 * describes this browser session only, so it is neither versioned nor kept across restarts. Only
 * the worker writes it; views follow it with `StoreReader.watchCompanion`.
 */
export const companionStatusKey = "companion"

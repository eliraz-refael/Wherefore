/**
 * Everything the extension keeps in `chrome.storage.local` (architecture A5). PR 3 adds `runs`.
 */
import { defaultSettings, SavedItem, Settings } from "@wherefore/core"
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

/** Every key, for startup migration. */
export const storeKeys: ReadonlyArray<StoreKey<unknown>> = [itemsKey, settingsKey]

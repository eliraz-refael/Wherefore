/**
 * The user's settings. Stored by the extension in `chrome.storage.local` only: never synced,
 * never sent anywhere except that the API key goes to the model provider the user chose.
 */
import { Schema } from "effect"

export const Settings = Schema.Struct({
  /** The model provider's API key, for API mode. Absent until the user enters one. */
  apiKey: Schema.optionalKey(Schema.NonEmptyString),
  /** The model id for API mode. Absent means the agent's default. */
  model: Schema.optionalKey(Schema.NonEmptyString)
})
export type Settings = typeof Settings.Type

/** Settings before the user has changed anything. */
export const defaultSettings: Settings = {}

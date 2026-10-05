/**
 * Why a model request failed, provider-neutral, with a message written for the user. The API key
 * never appears in it: messages are ours, plus at most the provider's own error message.
 */
import type { RunError } from "@wherefore/core"
import { Schema } from "effect"

export const ModelErrorReason = Schema.Literals([
  "missing_key",
  "invalid_key",
  "permission",
  "rate_limited",
  "overloaded",
  "server",
  "network",
  "bad_request",
  "refusal",
  "max_tokens",
  "invalid_response",
  "unexpected"
])
export type ModelErrorReason = typeof ModelErrorReason.Type

/** Failures where the same request can simply be sent again: nothing was changed by the failed one. */
const RETRYABLE: ReadonlySet<ModelErrorReason> = new Set(["rate_limited", "overloaded", "server", "network", "invalid_response"])

export class ModelError extends Schema.TaggedError<ModelError>()("ModelError", {
  reason: ModelErrorReason,
  message: Schema.String,
  /** How long the provider asked us to wait, for rate limits. */
  retryAfterMs: Schema.optionalKey(Schema.Number)
}) {
  get retryable(): boolean {
    return RETRYABLE.has(this.reason)
  }
}

const MESSAGES: Record<ModelErrorReason, string> = {
  missing_key: "Add your Anthropic API key in Settings first.",
  invalid_key: "Anthropic didn't accept the API key. Check it in Settings.",
  permission: "This API key isn't allowed to use the chosen model. Check the key or pick another model in Settings.",
  rate_limited: "Anthropic is rate limiting this key. Try again in a minute.",
  overloaded: "Anthropic is overloaded right now. Try again in a few minutes.",
  server: "Anthropic had a server error. Try again.",
  network: "Couldn't reach Anthropic. Check your connection and try again.",
  bad_request: "Anthropic rejected the request.",
  refusal: "The model declined to look at these tabs.",
  max_tokens: "The model's answer was too long and got cut off. Try again, or tidy up fewer tabs at once.",
  invalid_response: "Anthropic sent an answer we couldn't read. Try again.",
  unexpected: "Something went wrong while talking to the model."
}

/** A `ModelError` with the standard message for `reason`, plus the provider's own message when it helps. */
export const modelError = (
  reason: ModelErrorReason,
  options: { readonly detail?: string | undefined; readonly retryAfterMs?: number | undefined } = {}
): ModelError => {
  const detail = options.detail?.trim()
  const message = detail !== undefined && detail !== "" ? `${MESSAGES[reason]} (${detail})` : MESSAGES[reason]
  return new ModelError({
    reason,
    message,
    ...(options.retryAfterMs !== undefined ? { retryAfterMs: options.retryAfterMs } : {})
  })
}

/** As stored in a failed run. (Every model error reason is a run error reason.) */
export const toRunError = (error: ModelError): RunError => ({ reason: error.reason, message: error.message })

/**
 * The seam around the model (architecture A1, A2): `effect/unstable/ai`'s `Chat` and
 * `LanguageModel`, with `@effect/ai-anthropic` over the browser's `fetch`. Nothing outside this
 * file touches them; the agent sees `Conversation`, `ModelTurn` and `ModelError`.
 *
 * One `Conversation.next` is one model request plus the tool calls it asked for: the tools run
 * through the agent's handlers (core's `TriageToolkit`), and the reply and the tool results are
 * appended to the history. A request that fails changes nothing, so it can be sent again.
 *
 * Request shape (Anthropic):
 * - The browser calls api.anthropic.com directly, so every request carries
 *   `anthropic-dangerous-direct-browser-access: true` (the official SDK's browser mode sends the same
 *   header; `@effect/ai-anthropic` doesn't, so it's added with `transformClient`). The key goes
 *   only to Anthropic, in `x-api-key`, which Effect redacts from errors and traces.
 * - Prompt caching: the system prompt is a cache breakpoint (tools render before it, so they are
 *   cached with it), and top-level `cache_control` moves a second breakpoint to the end of the
 *   conversation on every request, so each turn reads the previous turn's prefix from the cache.
 * - Adaptive thinking at `medium` effort, which every offered model (core's `API_MODELS`) takes.
 *   Thinking blocks are kept in the history unchanged.
 * - Plain (non-strict) tools: core's handlers validate every call and return problems to the
 *   model. Strict tool use is left off until it is tried against the live API.
 * - No server-side refusal fallbacks: rc.117's response schema doesn't know the `fallback` block
 *   they add, so a refusal ends the run with a typed error instead.
 */
import type { Settings, TokenUsage, TriageHandlers, TurnStop } from "@wherefore/core"
import { modelOf, TriageToolkit } from "@wherefore/core"
import { Context, Duration, Effect, Layer, Redacted } from "effect"
import {
  AiError,
  AnthropicClient,
  AnthropicLanguageModel,
  Chat,
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  LanguageModel,
  type Response
} from "../unstable.ts"
import { type ModelError, modelError } from "./ModelError.ts"

/**
 * Per-request output budget, thinking included. Requests aren't streamed, so this stays under the
 * ~21k tokens above which Anthropic's SDKs insist on streaming (their 10-minute request timeout).
 */
export const MAX_OUTPUT_TOKENS = 20_000

/** A tool the model called in this turn, and whether the call failed (the model saw the failure). */
export interface ToolCallOutcome {
  readonly id: string
  readonly name: string
  readonly failed: boolean
}

/** One model request, after its tool calls ran. */
export interface ModelTurn {
  /** The visible text of the reply (often empty: the model mostly calls tools). */
  readonly text: string
  readonly toolCalls: ReadonlyArray<ToolCallOutcome>
  readonly stop: TurnStop
  readonly usage: TokenUsage
}

export interface Conversation {
  /** The model id in use. */
  readonly model: string
  /**
   * Sends `userText` (if given) after the history, calls the model, runs the tools it asked for
   * with the handlers, and appends all of it to the history. On failure the history is unchanged.
   */
  readonly next: (userText?: string) => Effect.Effect<ModelTurn, ModelError>
}

export interface ConverseOptions {
  readonly settings: Settings
  readonly system: string
  readonly handlers: TriageHandlers
}

export class ModelClient extends Context.Service<ModelClient, {
  /**
   * Starts a conversation with the model `settings` name, or the default when it isn't offered
   * (core's `modelOf`). Fails with `missing_key` without an API key.
   */
  readonly converse: (options: ConverseOptions) => Effect.Effect<Conversation, ModelError>
}>()("@wherefore/extension/ModelClient") {
  /** Anthropic, through the browser's `fetch`. */
  static readonly layer: Layer.Layer<ModelClient> = Layer.sync(ModelClient)(() => make(anthropicModel))

  /** Any `LanguageModel` (tests use a scripted one). */
  static readonly layerFrom = (
    build: (options: { readonly apiKey: string; readonly model: string }) => Effect.Effect<LanguageModel.LanguageModel>
  ): Layer.Layer<ModelClient> => Layer.sync(ModelClient)(() => make(build))
}

/** The Anthropic `LanguageModel` for one API key and model. */
const anthropicModel = (options: { readonly apiKey: string; readonly model: string }) =>
  Effect.gen(function*() {
    const client = yield* AnthropicClient.make({
      apiKey: Redacted.make(options.apiKey),
      transformClient: HttpClient.mapRequest(HttpClientRequest.setHeader("anthropic-dangerous-direct-browser-access", "true"))
    })
    return yield* AnthropicLanguageModel.make({
      model: options.model,
      config: {
        max_tokens: MAX_OUTPUT_TOKENS,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        cache_control: { type: "ephemeral" },
        structuredOutputs: false
      }
    }).pipe(Effect.provideService(AnthropicClient.AnthropicClient, client))
  }).pipe(Effect.provide(FetchHttpClient.layer))

const make = (
  build: (options: { readonly apiKey: string; readonly model: string }) => Effect.Effect<LanguageModel.LanguageModel>
): ModelClient["Service"] => ({
  converse: ({ settings, system, handlers }) =>
    Effect.gen(function*() {
      const apiKey = settings.apiKey
      if (apiKey === undefined) return yield* modelError("missing_key")
      const model = modelOf(settings)
      const languageModel = yield* build({ apiKey, model })
      const toolkit = yield* TriageToolkit.pipe(Effect.provide(TriageToolkit.toLayer(handlers)))
      const chat = yield* Chat.fromPrompt([
        { role: "system", content: system, options: { anthropic: { cacheControl: { type: "ephemeral" } } } }
      ])
      const next = (userText?: string) =>
        // Tool calls run one at a time, in the order the model made them.
        chat.generateText({ prompt: userText ?? [], toolkit, concurrency: 1 }).pipe(
          Effect.map(toTurn),
          Effect.provideService(LanguageModel.LanguageModel, languageModel),
          Effect.catch((error) => Effect.fail(toModelError(error)))
        )
      return { model, next } satisfies Conversation
    })
})

const STOPS: Record<Response.FinishReason, TurnStop> = {
  "tool-calls": "tool_calls",
  stop: "end",
  length: "max_tokens",
  "content-filter": "refusal",
  pause: "pause",
  error: "other",
  other: "other",
  unknown: "other"
}

const toTurn = <Mode extends Response.ToolParametersMode>(
  response: LanguageModel.GenerateTextResponse<typeof TriageToolkit.tools, Mode>
): ModelTurn => {
  const failed = new Map(response.toolResults.map((result) => [result.id, result.isFailure]))
  const usage = response.usage
  return {
    text: response.text,
    toolCalls: response.toolCalls
      .filter((call) => call.providerExecuted !== true)
      .map((call) => ({ id: call.id, name: call.name, failed: failed.get(call.id) ?? true })),
    stop: STOPS[response.finishReason],
    usage: {
      requests: 1,
      inputTokens: usage.inputTokens.uncached ?? 0,
      outputTokens: usage.outputTokens.total ?? 0,
      cacheReadTokens: usage.inputTokens.cacheRead ?? 0,
      cacheWriteTokens: usage.inputTokens.cacheWrite ?? 0
    }
  }
}

/** The provider's own error message, from an error body like `{ "error": { "message": "..." } }`. */
const providerMessage = (body: string | undefined): string | undefined => {
  if (body === undefined) return undefined
  try {
    const parsed: unknown = JSON.parse(body)
    if (typeof parsed !== "object" || parsed === null || !("error" in parsed)) return undefined
    const error: unknown = parsed.error
    if (typeof error !== "object" || error === null || !("message" in error)) return undefined
    return typeof error.message === "string" ? error.message.slice(0, 300) : undefined
  } catch {
    return undefined
  }
}

const isOverloaded = (reason: AiError.InternalProviderError): boolean =>
  reason.http?.response?.status === 529 || (reason.http?.body ?? "").includes("overloaded_error")

/** Maps whatever a request failed with to a `ModelError` the user can read. */
export const toModelError = (error: unknown): ModelError => {
  if (!AiError.isAiError(error)) return modelError("unexpected")
  const reason = error.reason
  switch (reason._tag) {
    case "AuthenticationError":
      return modelError(reason.kind === "InsufficientPermissions" ? "permission" : "invalid_key")
    case "RateLimitError":
    case "QuotaExhaustedError": {
      const retryAfter = reason._tag === "RateLimitError" ? reason.retryAfter : undefined
      return modelError("rate_limited", {
        retryAfterMs: retryAfter === undefined ? undefined : Duration.toMillis(retryAfter)
      })
    }
    case "InternalProviderError":
      return modelError(isOverloaded(reason) ? "overloaded" : "server")
    case "NetworkError":
      return modelError(reason.reason === "TransportError" ? "network" : "unexpected")
    case "InvalidRequestError":
      return modelError("bad_request", { detail: providerMessage(reason.http?.body) })
    case "ContentPolicyError":
      return modelError("refusal")
    case "InvalidOutputError":
      return modelError("invalid_response")
    case "UnknownError":
      return modelError("bad_request", { detail: providerMessage(reason.http?.body) ?? reason.description })
    default:
      return modelError("unexpected")
  }
}

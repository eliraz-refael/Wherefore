/**
 * `ModelClient` against Anthropic's wire format: the real `@effect/ai-anthropic` adapter over a fake
 * `fetch`, so the request we send (headers, caching, thinking, tools) and the replies and errors we
 * read are checked without a network.
 */
import { assert, describe, expect, it } from "@effect/vitest"
import { TabId, type TriageHandlers, WindowId } from "@wherefore/core"
import { Effect } from "effect"
import { ModelClient } from "../src/agent/ModelClient.ts"
import { FetchHttpClient } from "../src/unstable.ts"

const KEY = "sk-ant-test-secret"

interface Sent {
  readonly url: string
  readonly method: string | undefined
  readonly headers: Record<string, string>
  readonly body: Record<string, unknown>
}

const usage = {
  input_tokens: 10,
  output_tokens: 5,
  cache_creation_input_tokens: 2000,
  cache_read_input_tokens: 300,
  cache_creation: null,
  inference_geo: null,
  service_tier: "standard"
}

const message = (content: ReadonlyArray<unknown>, stopReason: string) => ({
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage
})

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })

/** A `fetch` that records each request and answers with the next scripted response. */
const fakeFetch = (replies: ReadonlyArray<() => Response>) => {
  const sent: Array<Sent> = []
  const fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = init?.body
    const text = typeof raw === "string" ? raw : raw instanceof Uint8Array ? new TextDecoder().decode(raw) : "{}"
    sent.push({
      url: String(input),
      method: init?.method,
      headers: Object.fromEntries(Object.entries(init?.headers ?? {}).map(([k, v]) => [k.toLowerCase(), String(v)])),
      body: JSON.parse(text)
    })
    const reply = replies[sent.length - 1]
    return reply === undefined ? Promise.reject(new Error("no reply scripted")) : Promise.resolve(reply())
  }
  return { sent, fetch: fetch as typeof globalThis.fetch }
}

const listed: Array<string> = []

const handlers: TriageHandlers = {
  list_tabs: () =>
    Effect.sync(() => {
      listed.push("list_tabs")
      return { tabs: [{ id: TabId.make(7), window: WindowId.make(1), index: 0, title: "Docs", url: "https://docs.example/" }] }
    }),
  read_pages: () => Effect.die("not used"),
  wake_and_read_pages: () => Effect.die("not used"),
  ask_user: () => Effect.die("not used"),
  submit_intentions: () => Effect.die("not used")
}

const converse = (model?: string) =>
  Effect.flatMap(ModelClient, (client) =>
    client.converse({
      settings: model === undefined ? { apiKey: KEY } : { apiKey: KEY, model },
      system: "SYSTEM PROMPT",
      handlers
    })).pipe(Effect.provide(ModelClient.layer))

const withFetch = (fetch: typeof globalThis.fetch) => Effect.provideService(FetchHttpClient.Fetch, fetch)

describe("ModelClient (Anthropic)", () => {
  it.effect("sends a cached, adaptive-thinking request from the browser and runs the tools it asks for", () => {
    const { sent, fetch } = fakeFetch([
      () =>
        json(200, message([
          { type: "thinking", thinking: "", signature: "sig-1" },
          { type: "tool_use", id: "toolu_1", name: "list_tabs", input: {} }
        ], "tool_use")),
      () => json(200, message([{ type: "text", text: "Done looking." }], "end_turn"))
    ])
    return Effect.gen(function*() {
      const conversation = yield* converse()
      expect(conversation.model).toBe("claude-opus-5-5")
      const first = yield* conversation.next("hello")

      const request = sent[0]
      assert(request !== undefined)
      // The beta Messages endpoint, as the official SDK uses for `client.beta.messages`.
      expect(request.url).toBe("https://api.anthropic.com/v1/messages?beta=true")
      expect(request.method).toBe("POST")
      expect(request.headers["x-api-key"]).toBe(KEY)
      expect(request.headers["anthropic-version"]).toBe("2023-06-01")
      expect(request.headers["anthropic-dangerous-direct-browser-access"]).toBe("true")
      expect(request.headers["anthropic-beta"] ?? "").not.toContain("structured-outputs")
      expect(request.body).toMatchObject({
        model: "claude-opus-5-5",
        max_tokens: 20_000,
        thinking: { type: "adaptive" },
        output_config: { effort: "medium" },
        cache_control: { type: "ephemeral" },
        system: [{ type: "text", text: "SYSTEM PROMPT", cache_control: { type: "ephemeral" } }],
        messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }]
      })
      const tools = request.body.tools as ReadonlyArray<Record<string, unknown>>
      expect(tools.map((tool) => tool.name)).toEqual([
        "list_tabs",
        "read_pages",
        "wake_and_read_pages",
        "ask_user",
        "submit_intentions"
      ])
      expect(tools.some((tool) => "strict" in tool)).toBe(false)
      expect(JSON.stringify(tools.find((tool) => tool.name === "read_pages")?.input_schema)).toContain("tab_ids")

      expect(listed).toEqual(["list_tabs"])
      expect(first).toEqual({
        text: "",
        toolCalls: [{ id: "toolu_1", name: "list_tabs", failed: false }],
        stop: "tool_calls",
        usage: { requests: 1, inputTokens: 10, outputTokens: 5, cacheReadTokens: 300, cacheWriteTokens: 2000 }
      })

      // The next request carries the thinking block unchanged, the tool call and its result.
      const second = yield* conversation.next()
      expect(second).toMatchObject({ text: "Done looking.", toolCalls: [], stop: "end" })
      const messages = sent[1]?.body.messages as ReadonlyArray<{ role: string; content: ReadonlyArray<Record<string, unknown>> }>
      expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "user"])
      expect(messages[1]?.content).toEqual([
        expect.objectContaining({ type: "thinking", thinking: "", signature: "sig-1" }),
        expect.objectContaining({ type: "tool_use", id: "toolu_1", name: "list_tabs", input: {} })
      ])
      const result = messages[2]?.content[0]
      expect(result).toMatchObject({ type: "tool_result", tool_use_id: "toolu_1", is_error: false })
      expect(JSON.parse(String(result?.content))).toEqual({
        tabs: [{ id: 7, window: 1, index: 0, title: "Docs", url: "https://docs.example/" }]
      })
    }).pipe(withFetch(fetch))
  })

  it.effect("uses the model from Settings", () => {
    const { sent, fetch } = fakeFetch([() => json(200, message([{ type: "text", text: "Hi" }], "end_turn"))])
    return Effect.gen(function*() {
      const conversation = yield* converse("claude-sonnet-5-5")
      yield* conversation.next("hello")
      expect(sent[0]?.body.model).toBe("claude-sonnet-5-5")
    }).pipe(withFetch(fetch))
  })

  it.effect("reports a refusal and a cut-off reply as stop reasons", () => {
    const { fetch } = fakeFetch([
      () => json(200, message([], "refusal")),
      () => json(200, message([{ type: "text", text: "Let me" }], "max_tokens"))
    ])
    return Effect.gen(function*() {
      const conversation = yield* converse()
      expect((yield* conversation.next("hello")).stop).toBe("refusal")
      expect((yield* conversation.next("again")).stop).toBe("max_tokens")
    }).pipe(withFetch(fetch))
  })

  const errorBody = (type: string, msg: string) => ({ type: "error", error: { type, message: msg }, request_id: "req_1" })

  const cases: ReadonlyArray<{
    readonly name: string
    readonly reply: () => Response
    readonly reason: string
    readonly retryable: boolean
    readonly message?: RegExp
    readonly retryAfterMs?: number
  }> = [
    {
      name: "401",
      reply: () => json(401, errorBody("authentication_error", "invalid x-api-key")),
      reason: "invalid_key",
      retryable: false
    },
    {
      name: "403",
      reply: () => json(403, errorBody("permission_error", "no access")),
      reason: "permission",
      retryable: false
    },
    {
      name: "429 with retry-after",
      reply: () => json(429, errorBody("rate_limit_error", "slow down"), { "retry-after": "7" }),
      reason: "rate_limited",
      retryable: true,
      retryAfterMs: 7000
    },
    {
      name: "529",
      reply: () => json(529, errorBody("overloaded_error", "Overloaded")),
      reason: "overloaded",
      retryable: true
    },
    { name: "500", reply: () => json(500, errorBody("api_error", "boom")), reason: "server", retryable: true },
    {
      name: "404 unknown model",
      reply: () => json(404, errorBody("not_found_error", "model: claude-nope")),
      reason: "bad_request",
      retryable: false,
      message: /Anthropic rejected the request\. \(model: claude-nope\)/
    }
  ]

  for (const { name, reply, reason, retryable, message: expected, retryAfterMs } of cases) {
    it.effect(`maps a ${name} to a typed ModelError (${reason})`, () => {
      const { fetch } = fakeFetch([reply])
      return Effect.gen(function*() {
        const conversation = yield* converse()
        const error = yield* Effect.flip(conversation.next("hello"))
        expect(error._tag).toBe("ModelError")
        expect(error.reason).toBe(reason)
        expect(error.retryable).toBe(retryable)
        if (expected !== undefined) expect(error.message).toMatch(expected)
        if (retryAfterMs !== undefined) expect(error.retryAfterMs).toBe(retryAfterMs)
        expect(JSON.stringify(error)).not.toContain(KEY)
        expect(error.message).not.toContain(KEY)
      }).pipe(withFetch(fetch))
    })
  }

  it.effect("maps a network failure to a retryable network error, and leaves the history unchanged", () => {
    let calls = 0
    const { sent, fetch: recording } = fakeFetch([
      () => json(200, message([{ type: "text", text: "Hi" }], "end_turn")),
      () => json(200, message([{ type: "text", text: "Hi" }], "end_turn"))
    ])
    const flaky: typeof globalThis.fetch = (input, init) => {
      calls++
      return calls === 1 ? Promise.reject(new TypeError("Failed to fetch")) : recording(input, init)
    }
    return Effect.gen(function*() {
      const conversation = yield* converse()
      const error = yield* Effect.flip(conversation.next("hello"))
      expect(error).toMatchObject({ reason: "network", message: "Couldn't reach Anthropic. Check your connection and try again." })
      expect(error.retryable).toBe(true)
      // Sending again sends the same single user message: the failed request left no trace.
      yield* conversation.next("hello")
      expect((sent[0]?.body.messages as ReadonlyArray<unknown>)).toHaveLength(1)
    }).pipe(withFetch(flaky))
  })

  it.effect("fails with missing_key without an API key, before any request", () => {
    const { sent, fetch } = fakeFetch([])
    return Effect.gen(function*() {
      const client = yield* ModelClient
      const error = yield* Effect.flip(client.converse({ settings: {}, system: "S", handlers }))
      expect(error.reason).toBe("missing_key")
      expect(sent).toEqual([])
    }).pipe(Effect.provide(ModelClient.layer), withFetch(fetch))
  })
})

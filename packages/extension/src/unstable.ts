/**
 * The only file in @wherefore/extension that imports from `effect/unstable/*`.
 *
 * rc.117 serves these under `effect/unstable/<module>`; Effect 4.0.0 moves them to
 * `effect/<module>` (e.g. `effect/ai`). When the pin moves, only this file changes.
 * Each re-export is consumed only behind one of our own services (architecture A1):
 * - ai + http + @effect/ai-anthropic: the API-mode agent's model calls (`ModelClient`, in the page).
 *   @effect/ai-anthropic is a separate package, but it is built on `effect/unstable/ai` and moves
 *   with it, so it is re-exported here too (and `check:imports` enforces that).
 * - rpc: panel <-> worker messaging (`WorkerClient` in the page, `serveWorkerRpcs` in the worker),
 *   over our own chrome.runtime Port protocol (src/messaging/).
 * - reactivity: the UI store (Atom, bound to React via @effect/atom-react). @effect/atom-react
 *   itself imports `effect/unstable/reactivity`, so the 4.0.0 move also needs its matching version.
 */
export { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic"
export { AiError, Chat, LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/unstable/ai"
export { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http"
export { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity"
export { Rpc, RpcClient, RpcClientError, RpcGroup, RpcMessage, RpcSerialization, RpcServer } from "effect/unstable/rpc"

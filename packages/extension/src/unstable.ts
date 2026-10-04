/**
 * The only file in @wherefore/extension that imports from `effect/unstable/*`.
 *
 * rc.117 serves these under `effect/unstable/<module>`; Effect 4.0.0 moves them to
 * `effect/<module>` (e.g. `effect/ai`). When the pin moves, only this file changes.
 * Each re-export is consumed only behind one of our own services (architecture A1):
 * - ai + http: the API-mode agent (`ModelClient`), running in the page.
 * - reactivity: the UI store (Atom, bound to React via @effect/atom-react in M1).
 */
export { AiError, Chat, LanguageModel, Prompt, Response, Tool, Toolkit } from "effect/unstable/ai"
export { FetchHttpClient, HttpClient } from "effect/unstable/http"
export { AsyncResult, Atom, AtomRegistry } from "effect/unstable/reactivity"

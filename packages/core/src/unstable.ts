/**
 * The only file in @wherefore/core that imports from `effect/unstable/*`.
 *
 * rc.117 serves these under `effect/unstable/<module>`; Effect 4.0.0 moves them to
 * `effect/<module>` (e.g. `effect/ai`). When the pin moves, only this file changes.
 *
 * Core needs `Tool`/`Toolkit` to define the five tools once (architecture A2).
 */
export { Tool, Toolkit } from "effect/unstable/ai"

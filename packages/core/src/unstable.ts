/**
 * The only file in @wherefore/core that imports from `effect/unstable/*`.
 *
 * rc.117 serves these under `effect/unstable/<module>`; Effect 4.0.0 moves them to
 * `effect/<module>` (e.g. `effect/ai`). When the pin moves, only this file changes.
 *
 * Core needs `Tool`/`Toolkit` to define the five tools once (architecture A2), and
 * `Rpc`/`RpcGroup` to define the worker's RPC surface once (rpc.ts), reusing the tools' schemas.
 */
export { Tool, Toolkit } from "effect/unstable/ai"
export { Rpc, RpcGroup } from "effect/unstable/rpc"

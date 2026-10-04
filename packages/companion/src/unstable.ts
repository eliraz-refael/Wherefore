/**
 * The only file in @wherefore/companion that imports from `effect/unstable/*`.
 *
 * rc.117 serves these under `effect/unstable/<module>`; Effect 4.0.0 moves them to
 * `effect/<module>` (e.g. `effect/cli`). When the pin moves, only this file changes.
 * Each re-export is consumed only behind one of our own services (architecture A1, A3):
 * - cli: the companion CLI.
 * - rpc + socket: `BrokerRpc` between MCP/ACP processes and the broker over a local socket.
 * - process: `AgentProcess`, spawning the ACP agent.
 * - ai (McpServer, Tool, Toolkit): `McpSurface`, serving core's Toolkit over stdio.
 */
export { McpSchema, McpServer, Tool, Toolkit } from "effect/unstable/ai"
export { Argument, Command, Flag } from "effect/unstable/cli"
export { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
export { Rpc, RpcClient, RpcGroup, RpcSerialization, RpcServer } from "effect/unstable/rpc"
export { Socket, SocketServer } from "effect/unstable/socket"

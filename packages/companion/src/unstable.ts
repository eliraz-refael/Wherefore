/**
 * The only file in @wherefore/companion that imports from `effect/unstable/*`, from
 * `@effect/platform-node-shared` (Node implementations of those same unstable modules, which move
 * with them), and from `@agentclientprotocol/sdk` (the ACP protocol, a 1.x library we keep behind
 * one service of ours, architecture A1).
 *
 * rc.117 serves these under `effect/unstable/<module>`; Effect 4.0.0 moves them to
 * `effect/<module>` (e.g. `effect/cli`). When the pin moves, only this file changes.
 * Each re-export is consumed only behind one of our own services (architecture A1, A3):
 * - cli: the companion CLI (cli.ts).
 * - rpc + socket: the broker's socket server (`serveBroker`), its client (`BrokerClient`), and
 *   the broker's link to the service worker over the native port (`WorkerLink`).
 * - process: `AgentProcess`, spawning the ACP agent and ending its process tree (M2 PR C).
 * - Acp (`@agentclientprotocol/sdk`): `AcpConnection`, the ACP client of that agent (src/acp/), and
 *   the fake agent the tests spawn.
 * - ai (McpServer, Tool, Toolkit): `McpSurface`, serving core's Toolkit over stdio (M2 PR B).
 * - platform-node-shared: Node's stdio, file system, terminal and process spawner for the CLI,
 *   and the Unix socket / named pipe server and client.
 */
export * as Acp from "@agentclientprotocol/sdk"
export * as NodeChildProcessSpawner from "@effect/platform-node-shared/NodeChildProcessSpawner"
export * as NodeFileSystem from "@effect/platform-node-shared/NodeFileSystem"
export * as NodePath from "@effect/platform-node-shared/NodePath"
export * as NodeRuntime from "@effect/platform-node-shared/NodeRuntime"
export * as NodeSocket from "@effect/platform-node-shared/NodeSocket"
export * as NodeSocketServer from "@effect/platform-node-shared/NodeSocketServer"
export * as NodeStdio from "@effect/platform-node-shared/NodeStdio"
export * as NodeTerminal from "@effect/platform-node-shared/NodeTerminal"
export { McpProtocol, McpSchema, McpServer, Tool, Toolkit } from "effect/unstable/ai"
export { Argument, Command, Flag } from "effect/unstable/cli"
export { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
export { Rpc, RpcClient, RpcClientError, RpcGroup, RpcMessage, RpcSerialization, RpcServer } from "effect/unstable/rpc"
export { Socket, SocketServer } from "effect/unstable/socket"

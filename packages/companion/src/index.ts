/**
 * @wherefore/companion: the local Node CLI (docs/product/architecture.md, A3).
 *
 * - The broker: Chrome's native-messaging host, one per connected profile, serving `BrokerRpcs`
 *   on a local socket and forwarding tool calls to the extension's worker (src/broker/).
 * - `install` / `uninstall` / `status` (src/install/, src/cli.ts).
 * - MCP over stdio (M2 PR B) and the ACP agent spawner (PR C) come next. They find brokers
 *   through the registry and call them with `connectBroker`.
 */
export { packageName as corePackageName } from "@wherefore/core"
export { type BrokerClient, BrokerUnreachable, connectBroker } from "./broker/BrokerClient.ts"
export { liveDeps, makeRegistry, type RegistryEntry } from "./broker/registry.ts"
export { type Location, platformOf, registryDir, stateDir } from "./paths.ts"
export { COMPANION_VERSION } from "./version.ts"

export const packageName = "@wherefore/companion" as const

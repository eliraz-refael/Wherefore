/**
 * @wherefore/extension: the WXT MV3 extension (docs/product/architecture.md).
 * Background (TabTools, Store, broker client), UI (React 19 + Atom) and the API-mode agent.
 *
 * The WXT entrypoints live in src/entrypoints/. This module only exposes package metadata for
 * the workspace smoke test; services and UI land in later M1 PRs.
 */
export { packageName as corePackageName } from "@wherefore/core"

export const packageName = "@wherefore/extension" as const

/**
 * @wherefore/core: the pure domain (docs/product/architecture.md).
 * Effect + Schema, plus Tool/Toolkit through ./unstable.ts; no browser and no Node APIs.
 */
export const packageName = "@wherefore/core" as const

export * from "./ids.ts"
export * from "./intention.ts"
export * from "./matcher.ts"
export * from "./savedItem.ts"
export * from "./tab.ts"
export * from "./tools.ts"
export * from "./url.ts"

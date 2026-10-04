import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { corePackageName, packageName } from "../src/index.ts"
import { Atom, AtomRegistry, Chat, FetchHttpClient, LanguageModel } from "../src/unstable.ts"

describe("extension smoke", () => {
  it.effect("links @tab-intentions/core through the workspace", () =>
    Effect.sync(() => {
      expect(corePackageName).toBe("@tab-intentions/core")
      expect(packageName).toBe("@tab-intentions/extension")
    }))

  it("resolves the effect/unstable/{ai,http,reactivity} seams", () => {
    expect(Chat.empty).toBeDefined()
    expect(LanguageModel.generateText).toBeTypeOf("function")
    expect(FetchHttpClient.layer).toBeDefined()
    const registry = AtomRegistry.make()
    const count = Atom.make(1)
    registry.set(count, 2)
    expect(registry.get(count)).toBe(2)
  })
})

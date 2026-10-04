import { describe, expect, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { packageName } from "../src/index.ts"
import { Tool, Toolkit } from "../src/unstable.ts"

describe("core smoke", () => {
  it.effect("runs an Effect and decodes with Schema", () =>
    Effect.gen(function*() {
      const decoded = yield* Schema.decodeUnknownEffect(Schema.String)(packageName)
      expect(decoded).toBe("@wherefore/core")
    }))

  it("resolves the effect/unstable/ai seam", () => {
    expect(Tool.make).toBeTypeOf("function")
    expect(Toolkit.make).toBeTypeOf("function")
  })
})

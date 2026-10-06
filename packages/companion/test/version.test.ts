import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { COMPANION_VERSION } from "../src/version.ts"

describe("companion version", () => {
  it("matches package.json, so Welcome and status report the real version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
    expect(COMPANION_VERSION).toBe(pkg.version)
  })
})

import { readFileSync } from "node:fs"
import { describe, expect, it } from "@effect/vitest"
import { COMPANION_INSTALL_COMMAND, COMPANION_PACKAGE } from "@wherefore/core"
import { COMPANION_VERSION } from "../src/version.ts"

describe("companion version", () => {
  it("matches package.json, so Welcome and status report the real version", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string }
    expect(COMPANION_VERSION).toBe(pkg.version)
  })

  it("is published under the name the extension tells users to install", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      name: string
      bin: Record<string, string>
    }
    expect(pkg.name).toBe(COMPANION_PACKAGE)
    expect(COMPANION_INSTALL_COMMAND).toBe(`npx ${pkg.name} install`)
    // npx runs the package's only bin.
    expect(Object.keys(pkg.bin)).toEqual(["wherefore"])
  })
})

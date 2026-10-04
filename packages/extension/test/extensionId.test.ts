import { describe, expect, it } from "@effect/vitest"
import { EXTENSION_ID, PUBLIC_KEY } from "../src/extensionId.ts"

/** Chrome's derivation: SHA-256 of the DER key, first 16 bytes, each hex digit 0-f mapped to a-p. */
const extensionIdOf = async (base64Key: string): Promise<string> => {
  const der = Uint8Array.from(atob(base64Key), (char) => char.charCodeAt(0))
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", der))
  return Array.from(digest.subarray(0, 16), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .replace(/[0-9a-f]/g, (hex) => String.fromCharCode(97 + Number.parseInt(hex, 16)))
}

describe("extension identity", () => {
  it("derives the pinned extension ID from the manifest key", async () => {
    expect(EXTENSION_ID).toBe("anpbbaiepneaddgoldgmapilgiflochg")
    expect(await extensionIdOf(PUBLIC_KEY)).toBe(EXTENSION_ID)
  })
})

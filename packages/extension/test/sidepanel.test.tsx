import { RegistryProvider } from "@effect/atom-react"
import { describe, expect, it } from "@effect/vitest"
import { renderToString } from "react-dom/server"

describe("side panel shell", () => {
  it("renders an Effect-backed Atom through @effect/atom-react", async () => {
    // wxt/browser picks up `chrome` when the module loads, so stub it before importing the app.
    Object.assign(globalThis, { chrome: { runtime: { getManifest: () => ({ version: "1.2.3" }) } } })
    const { App } = await import("../src/entrypoints/sidepanel/App.tsx")
    const html = renderToString(
      <RegistryProvider>
        <App />
      </RegistryProvider>,
    )
    expect(html).toContain("Version 1.2.3.")
  })
})

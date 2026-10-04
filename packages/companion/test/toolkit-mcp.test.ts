import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { TriageToolkit } from "@wherefore/core"
import { McpServer } from "../src/unstable.ts"

// Architecture A2: core's one Toolkit is what the companion serves over MCP. The real handlers
// arrive in M2; these stubs only satisfy the types so the tools can be registered.
const stubHandlers = TriageToolkit.toLayer({
  list_tabs: () => Effect.succeed({ tabs: [] }),
  read_pages: () => Effect.succeed({ pages: [] }),
  wake_and_read_pages: () => Effect.succeed({ pages: [] }),
  ask_user: () => Effect.succeed({ answers: [] }),
  submit_intentions: () => Effect.succeed({ message: "Saved." })
})

describe("core's TriageToolkit on McpServer", () => {
  it.effect("registers all five tools with object input and output schemas", () =>
    Effect.gen(function*() {
      yield* McpServer.registerToolkit(TriageToolkit)
      const { tools } = yield* McpServer.McpServer
      expect(tools.map(({ tool }) => tool.name)).toEqual(Object.keys(TriageToolkit.tools))
      for (const { tool } of tools) {
        expect(tool.inputSchema.type).toBe("object")
        expect(tool.outputSchema?.["type"]).toBe("object")
        expect(tool.annotations?.destructiveHint).toBe(false)
      }
    }).pipe(Effect.provide(stubHandlers), Effect.provide(McpServer.McpServer.layer)))
})

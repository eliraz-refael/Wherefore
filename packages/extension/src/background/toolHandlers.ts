/**
 * The model's worker-side tools (`TabToolRpcs`, core rpc.ts) as RPC handlers over `TabTools`. One
 * implementation for both callers: extension pages (inside `WorkerRpcs`) and the companion's
 * broker over the native port (CompanionLink.ts).
 */
import { type BrowserError, DEFAULT_MAX_CHARS, localDay, TabToolRpcs, ToolError } from "@wherefore/core"
import { Clock, Effect } from "effect"
import type { TabTools } from "./TabTools.ts"

/** The model hears what failed, never a stack. */
const toToolError = (error: BrowserError) => new ToolError({ message: `${error.operation} failed: ${error.message}` })

export const tabToolHandlers = (tools: TabTools["Service"]) => TabToolRpcs.of({
  // Today's date comes from here, the user's browser, for every mode: API, MCP and ACP.
  list_tabs: () =>
    Effect.all([tools.listTabs, Clock.currentTimeMillis]).pipe(
      Effect.map(([tabs, now]) => ({ tabs, today: localDay(now) })),
      Effect.mapError(toToolError)
    ),
  read_pages: ({ tabIds, maxChars }) =>
    Effect.map(tools.readPages(tabIds, maxChars ?? DEFAULT_MAX_CHARS), (pages) => ({ pages })),
  wake_and_read_pages: ({ tabIds, maxChars }) =>
    Effect.map(tools.wakeAndReadPages(tabIds, maxChars ?? DEFAULT_MAX_CHARS), (pages) => ({ pages }))
})

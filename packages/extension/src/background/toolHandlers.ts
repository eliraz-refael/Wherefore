/**
 * The model's worker-side tools (`TabToolRpcs`, core rpc.ts) as RPC handlers over `TabTools`. One
 * implementation for both callers: extension pages (inside `WorkerRpcs`) and the companion's
 * broker over the native port (CompanionLink.ts).
 */
import { type BrowserError, DEFAULT_MAX_CHARS, TabToolRpcs, ToolError } from "@wherefore/core"
import { Effect } from "effect"
import type { TabTools } from "./TabTools.ts"

/** The model hears what failed, never a stack. */
const toToolError = (error: BrowserError) => new ToolError({ message: `${error.operation} failed: ${error.message}` })

export const tabToolHandlers = (tools: TabTools["Service"]) => TabToolRpcs.of({
  list_tabs: () => tools.listTabs.pipe(Effect.map((tabs) => ({ tabs })), Effect.mapError(toToolError)),
  read_pages: ({ tabIds, maxChars }) =>
    Effect.map(tools.readPages(tabIds, maxChars ?? DEFAULT_MAX_CHARS), (pages) => ({ pages })),
  wake_and_read_pages: ({ tabIds, maxChars }) =>
    Effect.map(tools.wakeAndReadPages(tabIds, maxChars ?? DEFAULT_MAX_CHARS), (pages) => ({ pages }))
})

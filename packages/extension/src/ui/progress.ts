/**
 * A running tidy-up in one plain sentence, from its newest stored step. The screen shows only this
 * line, never the step log (canvas v6).
 */
import type { Run } from "@wherefore/core"
import { tabCount } from "./format.ts"

export const progressText = (run: Run): string => {
  const thinking = run.tabs.length === 0 ? "Thinking…" : `Thinking about your ${tabCount(run.tabs.length)}…`
  const step = run.steps.at(-1)
  if (step === undefined) return "Getting started…"
  switch (step.kind) {
    case "model":
      return thinking
    case "note":
      return step.message
    case "question":
      return step.answers === undefined ? "Waiting for your answer" : `Thanks. ${thinking}`
    case "tool":
      if (step.status !== "running") {
        return step.tool === "list_tabs" && step.status === "ok" ? `Found ${tabCount(run.tabs.length)}. ${thinking}` : thinking
      }
      switch (step.tool) {
        case "list_tabs":
          return "Looking at your tabs…"
        case "submit_intentions":
          return "Putting it all together…"
        default:
          // "Reading 3 pages", "Waking 2 sleeping tabs": the agent's own short summary.
          return `${step.summary}…`
      }
  }
}

import { browser } from "wxt/browser"
import { defineBackground } from "wxt/utils/define-background"

/**
 * The service worker. M1 shell: it only makes the toolbar action open the side panel.
 * TabTools, the Store and panel messaging land in the next PR (architecture A4: the worker
 * stays thin and never runs a model).
 */
export default defineBackground(() => {
  browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error: unknown) => console.error("sidePanel.setPanelBehavior failed", error))
})

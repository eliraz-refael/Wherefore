import { defineConfig } from "wxt"
import { PUBLIC_KEY } from "./src/extensionId.ts"

export default defineConfig({
  srcDir: "src",
  // Explicit imports only (`wxt/browser`, `wxt/utils/*`): no generated globals to keep in sync.
  imports: false,
  manifest: {
    name: "Wherefore",
    description: "Close every tab without losing what it was for.",
    // Pins the extension ID for every unpacked install (see src/extensionId.ts).
    key: PUBLIC_KEY,
    // M1 (API mode). nativeMessaging and alarms arrive with the companion broker in M2.
    permissions: ["tabs", "tabGroups", "scripting", "storage", "sidePanel", "sessions"],
    // M1 reads any page the agent asks for. M4 moves this to optional_host_permissions,
    // requested at first run.
    host_permissions: ["<all_urls>"],
    // The side panel opens on action click (background.ts); the action has no popup.
    action: { default_title: "Wherefore" },
  },
  vite: () => ({
    build: {
      rolldownOptions: {
        // @effect/atom-react marks its modules "use client" (a React Server Components hint).
        // An extension has no server components, so the directive is meaningless here.
        onLog(level, log, handler) {
          if (log.code === "MODULE_LEVEL_DIRECTIVE" && log.message.includes('"use client"')) return
          handler(level, log)
        },
      },
    },
  }),
})

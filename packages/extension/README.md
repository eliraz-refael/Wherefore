# @wherefore/extension

The Wherefore Chrome extension (MV3, built with [WXT](https://wxt.dev)). See [architecture.md](../../docs/product/architecture.md).

**Status: M1 done (API mode).** The side panel works end to end with your own Anthropic API key: first run, Your list (Done, Open, edit, remove with undo), Tidy up (progress, questions one at a time, results with the "Save N and close M tabs" bar and undo), the Done archive and Settings. The service worker serves tab tools and every storage write over RPC; the API-mode agent (`src/agent/`) runs in the page and stores every step, so a second panel mirrors a run.

## Try it

1. Build and load it (below). Remove the POC first: they share an extension ID.
2. Click the toolbar icon. The side panel asks for an Anthropic API key ([console.anthropic.com](https://console.anthropic.com/settings/keys)). It stays in `chrome.storage.local`; Settings shows only its last four characters.
3. **Tidy up** reads your open tabs (titles and redacted URLs; page text only when the model asks, never for mail, chat, consoles or sign-in pages), may ask a question or two, then shows the results. **Save N and close M tabs** saves them to Your list and closes the tabs; **Undo** in the toast brings everything back.
4. On Your list, **Open** brings an item's tabs back as a tab group; **Done** closes them and moves the item to the Done archive.
5. Without an API key: install the companion (`packages/companion/README.md`). With it connected, first run offers **Tidy up my N tabs · Uses your Claude Code login**: the companion starts Claude Code (ACP) on your own login, and its progress, questions and results show in the panel like any tidy-up. Settings → Connection switches between Claude Code and an API key, and shows Claude Code's model and effort after its first run. The worker connects to the companion at startup and keeps the connection open; Settings → Companion shows its state, with **Check again** after installing. The companion also serves Claude Code over MCP (you ask Claude Code; the panel follows).

## Build and load

```sh
pnpm install                         # also runs `wxt prepare` (generated types in .wxt/)
pnpm -C packages/extension build     # → packages/extension/.output/chrome-mv3
pnpm -C packages/extension dev       # watch mode, opens a fresh Chrome profile
pnpm -C packages/extension zip       # store-ready zip in .output/
```

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → `packages/extension/.output/chrome-mv3`, then click the toolbar icon.

> **One at a time.** This extension and the proof of concept at the repo root share the manifest `key`, so both get the extension ID `anpbbaiepneaddgoldgmapilgiflochg`. Chrome loads only one of them per profile: remove (or use another profile for) the POC before loading this one. The ID is pinned in `src/extensionId.ts` and must never change; the companion's native messaging host allows exactly this ID.

## Layout

| Path | What |
|---|---|
| `wxt.config.ts` | Manifest (name, key, permissions) and build settings |
| `src/entrypoints/background.ts` | Service worker: wires the layers below |
| `src/entrypoints/sidepanel/` | The side panel's page: mounts `src/ui/` |
| `src/ui/` | Views (side panel now, full page in M3): Atoms over `StoreReader`/`PageTabs` (`atoms.ts`), actions through the worker (`actions.ts`), the review model (`review.ts`), `Tidy` (runs, and answers/Stop across panels), React components and `styles.css` |
| `src/chrome/ChromeApi.ts` | The seam around every `chrome.*` call the services make (faked in tests) |
| `src/background/TabTools.ts` | List, read and wake tabs; close with undo; reopen an item as a tab group |
| `src/background/Store.ts` | Storage writes: versioned keys, migrations, backups of unreadable values |
| `src/background/handlers.ts` | `WorkerRpcs` (from core) implemented and served |
| `src/companion/` | The worker's one native port to the companion: `NativeConnector` (the `connectNative` seam), `CompanionLink` (handshake, serving the tab tools to the broker, calling the broker to start ACP agents, reconnects, status), `CompanionRuns` (MCP leases, ACP runs the worker owns, questions, Stop) |
| `src/store/` | Store keys, decoding + migration, `StoreReader` (read and watch, for views) |
| `src/messaging/` | Page <-> worker RPC over a `chrome.runtime` Port: protocol, worker server, `WorkerClient` |
| `src/agent/` | The API-mode agent: `TriageAgent` (the tool loop and run persistence), `ModelClient` (Anthropic via `effect/ai`), `Questions` (how `ask_user` reaches the UI), `ModelError` |
| `src/runs/RunLocks.ts` | Web Locks that mark a run alive while its page is open, and keep runs exclusive |
| `src/unstable.ts` | The only file here that imports `effect/unstable/*` or `@effect/ai-anthropic` (`pnpm check:imports`) |

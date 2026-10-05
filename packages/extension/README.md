# @wherefore/extension

The Wherefore Chrome extension (MV3, built with [WXT](https://wxt.dev)). See [architecture.md](../../docs/product/architecture.md).

**Status: M1, PR 3.** The service worker serves tab tools (list, read, wake, close with undo, resume as a group) and every storage write to the extension's pages over RPC. The API-mode agent (`src/agent/`) runs a triage in the page and stores every step; it is covered by tests but not wired to any screen yet. The side panel is still a placeholder; the real UI comes next.

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
| `src/entrypoints/sidepanel/` | Side panel (React 19, `@effect/atom-react`) |
| `src/chrome/ChromeApi.ts` | The seam around every `chrome.*` call the services make (faked in tests) |
| `src/background/TabTools.ts` | List, read and wake tabs; close with undo; reopen an item as a tab group |
| `src/background/Store.ts` | Storage writes: versioned keys, migrations, backups of unreadable values |
| `src/background/handlers.ts` | `WorkerRpcs` (from core) implemented and served |
| `src/store/` | Store keys, decoding + migration, `StoreReader` (read and watch, for views) |
| `src/messaging/` | Page <-> worker RPC over a `chrome.runtime` Port: protocol, worker server, `WorkerClient` |
| `src/agent/` | The API-mode agent: `TriageAgent` (the tool loop and run persistence), `ModelClient` (Anthropic via `effect/ai`), `Questions` (how `ask_user` reaches the UI), `ModelError` |
| `src/runs/RunLocks.ts` | Web Locks that mark a run alive while its page is open, and keep runs exclusive |
| `src/unstable.ts` | The only file here that imports `effect/unstable/*` or `@effect/ai-anthropic` (`pnpm check:imports`) |

# @wherefore/extension

The Wherefore Chrome extension (MV3, built with [WXT](https://wxt.dev)). See [architecture.md](../../docs/product/architecture.md).

**Status: M1 shell.** A service worker that opens the side panel on toolbar click, and a React 19 + Atom side panel placeholder. Tools, storage, the API agent and the real UI come next.

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
| `src/entrypoints/background.ts` | Service worker |
| `src/entrypoints/sidepanel/` | Side panel (React 19, `@effect/atom-react`) |
| `src/unstable.ts` | The only file here that imports `effect/unstable/*` (`pnpm check:imports`) |

# Wherefore: product architecture (draft 0, 2026-10-04)

Builds on [story.md](story.md) and [../research/effect-v4.md](../research/effect-v4.md). The POC (this repo's current code) stays as the reference until the product reaches parity.

## Shape

```
packages/
  core/        Pure domain. No browser, no Node.
               Schemas (Intention, Item, Run, Tab, Settings), the Toolkit (5 tools), the
               worker's RPC group (WorkerRpcs), the prompt, URL normalization + matching,
               Markdown export. Effect + Schema, plus Tool/Toolkit and Rpc/RpcGroup from
               effect/unstable/* (imported only via src/unstable.ts).
  extension/   WXT, MV3.
               background: TabTools, Store, RPC server for pages, Broker client
               (thin; never runs a model)
               ui: side panel + full page (React 19 + Atom), shared components
               api-mode agent (effect/ai + @effect/ai-anthropic), runs in the page
  companion/   Node CLI (effect/cli).
               broker: native-messaging host the extension keeps open
               mcp: McpServer over stdio, serving core's Toolkit through the broker
               acp: spawns the ACP agent (effect/process + @agentclientprotocol/sdk)
```

One pnpm workspace; `core` is imported by both other packages, so tool schemas, wire types and the prompt exist exactly once.

## Decisions (ADR-style)

### A1. Effect v4, used in two tiers
- **Commit everywhere:** `Effect`, `Schema`, `Context.Service`/`Layer`, `Stream`, `Scope`. Stable core API.
- **Adopt behind our own seams:** `effect/ai` + `@effect/ai-anthropic`, `McpServer`, `effect/rpc`, `effect/process`, `effect/cli` and `effect/reactivity` are all marked unstable. Each sits behind one service of ours (`ModelClient`, `McpSurface`, `BrokerRpc`, `WorkerClient` and the worker's RPC server, `AgentProcess`, the UI store), so a breaking minor release changes one file. RPC group definitions (`Rpc`/`RpcGroup`) live in `core` with the schemas they reuse. Exact version pins; upgrades are deliberate.
- **Keep ours:** ACP protocol (`@agentclientprotocol/sdk`, wrapped in a service), native-messaging framing (a small codec), `chrome.*` access.
- **Why:** typed errors, cancellation and resource safety are exactly what the bridge, the agent processes and the run lifecycle got wrong or hand-rolled in the POC. Schema removes the zod-plus-hand-written-types duplication.

### A2. One Toolkit, three hookups
The five tools are defined once in `core` as an Effect `Toolkit`. API mode hands it to `effect/ai`'s chat with our own short tool loop (`generateText` does one round per call). MCP mode serves the same Toolkit with `McpServer`. ACP mode passes our MCP server to the agent, as today. JSON Schema for tool definitions comes from Schema (`toJsonSchemaDocument`).

### A3. The companion is a broker; the extension stops polling ports
Today every MCP server listens on a localhost port and the service worker probes 8 ports. That causes the console noise, needs an origin check, and adds up to 30 s of discovery delay.
- The service worker opens **one native-messaging connection** to the companion when the companion is installed, and keeps it open. Since Chrome 105, an open native port keeps the worker alive.
- MCP servers and ACP sessions connect to that broker over a **local socket** (a Unix domain socket, or a named pipe on Windows), speaking `effect/rpc`.
- Tool calls flow agent → MCP server → broker → native port → service worker → `TabTools`.
- **Trade-off:** a small Node process stays running while Chrome is open, for users who installed the companion. API-key-only users have no companion and no process. Accepted (2026-10-04).

### A4. The service worker is thin; runs live where they can't be killed
- **Service worker:** executes tools (`TabTools`), owns storage writes (`Store`), holds the broker connection. It never runs a model loop, because it can be stopped at any time.
- **API mode:** runs in the page that started it (side panel or full page), as in the POC.
- **ACP and MCP:** run in the companion; the page only shows progress.
- **Progress:** every step is persisted, so any open view mirrors a run, and a closed view can reattach.
- **Pages talk to the worker over RPC** (M1, PR 2). `WorkerRpcs` (in `core`, so M2's broker can forward tool calls with the same schemas) is served over a `chrome.runtime` Port per page, with a small schema-checked protocol carrying `effect/unstable/rpc` messages. The worker adds its `onConnect` and Port listeners synchronously at startup and buffers events, so the Port that woke it isn't lost. A page reconnects on its next call after the worker stops; calls in flight on a dropped Port fail with `WorkerUnavailable` (never hang), and a call that never left the page is retried once on the new Port. Only Ports from the extension's own origin are served.
- **Undo survives the worker.** `closeTabs` writes the closed tabs to `chrome.storage.session` (`undo:<token>`) before closing anything; `undoClose(token)` works from a restarted worker. Records expire after 10 minutes and are dropped on the next close. The caller passes its window id (`keepWindowAlive`): closing every tab there opens a new one first, so the side panel stays.

### A5. Storage: `chrome.storage.local` behind a `Store` service
- **What's stored:** `items` and `settings` (M1, PR 2), `runs` (the last N, PR 3). Each key is stored as `{ version, data }`, one version per key (not per item). Reading decodes the envelope, runs the key's migrations up to the current version, decodes `data` with its schema, and the worker writes a migrated value back. Adding a key is one `StoreKey` value.
- **Never wipe user data.** A value that doesn't decode (or comes from a newer version) is copied to `backup:<key>:<epoch ms>`, and reads and writes of that key fail with a typed `StoreUnreadable` until the user decides. Views get the same error without making a backup.
- **Writes:** only the worker writes (A4), read-modify-write under one lock; item changes go through `core`'s pure helpers. Views read `chrome.storage.local` directly (`StoreReader.get`, `StoreReader.watch` as a `Stream`). Settings (API key, model) stay in `chrome.storage.local`, never `sync`.
- **Room:** `unlimitedStorage` covers large runs with tab snapshots.
- **Sync:** `storage.onChanged` keeps views in sync, through a custom Atom-backed store.
- **No sync service, no server.** Nothing leaves the machine except calls to the model the user chose.

### A6. Incremental triage
Before calling the model, `core` matches open tabs to open items by normalized URL. Normalization drops tracking parameters and in-page anchors (`#install`), but keeps fragments that look like client-side routes (`#/projects/42`, `#!…`, Gmail's `#inbox/<id>`); otherwise every Gmail thread would match a saved one. Matching compares real URLs: secret parameters are redacted only in what the model sees, because a param like `key=` can identify a document and a false match would close a tab under the wrong item. The model only sees unmatched tabs, plus a compact list of open items (id, task, domains), so `submit_intentions` can attach a new tab to an existing item instead of creating a duplicate.

### A7. UI: React 19 + Atom
Chosen for fit with Effect v4 (2026-10-04): Atom bindings exist for React, Solid and Vue at the same version as `effect` (all at 4.0.0-rc.117). `@effect/atom-react` is the one the Effect team builds and documents first, and React has the widest component ecosystem. The side panel and the full page share components; styles come from the design tokens on the canvas.

**UX direction (canvas v6):** *Your list* is the home screen. Triage is one *Tidy up* screen with smart defaults and a sticky "Save N and close M" bar. Questions come one at a time and are answered with a tap. Builder details (model, cost, MCP, export) live in Settings. The UI shows no confidence, evidence, filters or step log, and never says "intention". Done stays a labelled button. Accessibility rules from the POC review carry over: native controls, labelled inputs, focus kept on in-place updates, a live region for status.

### A8. Testing
`@effect/vitest` for `core` and services, with `TestClock` and layer mocks for chrome APIs. Companion: the existing no-Chrome smoke tests, ported. Extension end-to-end: Playwright with the unpacked build loaded (from M3).

## Milestones

| | Goal | Done when |
| --- | --- | --- |
| M0 | Foundations | Workspace, Effect pinned, `core` schemas + Toolkit + JSON Schema output + URL matcher, tested |
| M1 | API-mode parity | Extension with `TabTools`, `Store`, API agent on `effect/ai`, side panel (React + Atom) reaches POC parity: triage, questions, review, save/close/undo |
| M2 | Companion | Broker + MCP + ACP on Effect; onboarding detects the companion; no port polling |
| M3 | Product loop | Incremental triage, Saved list + full page, resume as group, Markdown export, e2e tests |
| M4 | Store-ready | Optional host permissions requested at first run, icons, privacy policy, unlisted CWS listing, install docs for co-workers |

## Risks

1. **Unstable Effect modules.** Mitigated by the A1 seams and exact pins.
2. **Fresh major (4.0.0 is days old).** Budget time for upstream bugs; keep the POC working until M1.
3. **Bundle size: measured (M1 shell spike, production WXT build, gzip -9).** Shell (React 19 + Atom + Effect): side panel 90 KB, worker 0.3 KB. Adding core's Schema + Toolkit: 119 KB and 39 KB. Adding `effect/ai` (`Chat`, `LanguageModel`) + `FetchHttpClient` + `@effect/ai-anthropic` to the panel: **162 KB** (595 KB minified), of which `@effect/ai-anthropic` is 32 KB (mostly its generated API schemas) and react-dom about 60 KB. `effect/unstable/rpc` on both sides adds 3 KB to the panel and 6 KB to the worker. Loading the agent with `import()` when a run starts keeps the panel's first chunk at 129 KB (agent chunk 36 KB). **Verdict:** over the ~150 KB mark only with the agent loaded eagerly; the extension loads from disk, so this is parse time, not download. Acceptable for M1; recommended: PR 3 loads the agent with `import()`. **Shipped in M1 PR 2:** worker 56 KB (TabTools, Store, RPC server, core schemas + Toolkit); side panel unchanged at 90 KB, and 126 KB once it imports `WorkerClient` + `StoreReader` (spike).
4. **Registry: decided.** Pin `4.0.0-rc.117` for every Effect package: `effect`, `@effect/ai-anthropic`, `@effect/atom-react`, `@effect/platform-*`. `@effect/vitest` is at rc.116, which accepts rc.117. rc.117 still uses the `effect/unstable/*` import paths, and 4.0.0 renamed them (`effect/ai`, `effect/rpc`, ...). The A1 seams keep that rename to a handful of import lines when the registry serves 4.0.0.
5. **MV3 lifecycle.** No official Effect guidance; A4 keeps long work out of the worker.

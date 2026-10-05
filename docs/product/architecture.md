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
- **Adopt behind our own seams:** `effect/ai` + `@effect/ai-anthropic`, `McpServer`, `effect/rpc`, `effect/process`, `effect/cli` and `effect/reactivity` are all marked unstable. Each sits behind one service of ours (`ModelClient`, `McpSurface`, `BrokerRpc`, `WorkerClient` and the worker's RPC server, `AgentProcess`, the UI store), so a breaking minor release changes one file. RPC group definitions (`Rpc`/`RpcGroup`) live in `core` with the schemas they reuse. Exact version pins; upgrades are deliberate. Each package imports `effect/unstable/*` only in its `src/unstable.ts`, and `@effect/ai-anthropic` (built on `effect/unstable/ai`) is held to the same rule (`pnpm check:imports`, M1 PR 3).
- **Keep ours:** ACP protocol (`@agentclientprotocol/sdk`, wrapped in a service), native-messaging framing (a small codec), `chrome.*` access.
- **Why:** typed errors, cancellation and resource safety are exactly what the bridge, the agent processes and the run lifecycle got wrong or hand-rolled in the POC. Schema removes the zod-plus-hand-written-types duplication.

### A2. One Toolkit, three hookups
The five tools are defined once in `core` as an Effect `Toolkit`. API mode hands it to `effect/ai`'s chat with our own short tool loop (`generateText` does one round per call: one model request, then the tools it asked for). The loop ends when `submit_intentions` passes core's coverage check, at a turn limit (15 requests), or on cancel; a model that stops without submitting is reminded twice. The system prompt and the kickoff are in `core` (`prompt.ts`); in API mode the agent lists the tabs itself and puts them in the kickoff, as the POC did, saving one round trip. API mode offers two models, `claude-opus-5-5` (the default) and `claude-sonnet-5-5` (`API_MODELS` in `core`; owner's decision: Haiku is too weak for triage). A stored setting that names any other model runs on the default. MCP mode serves the same Toolkit with `McpServer`. ACP mode passes our MCP server to the agent, as today. JSON Schema for tool definitions comes from Schema (`toJsonSchemaDocument`).

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
- **Progress:** every step is persisted, so any open view mirrors a run, and a closed view can reattach. In API mode the page writes the whole run, to its own key (A5), after each step through the worker (`save_run`, idempotent): model turns, tool calls with short summaries (never page text), questions and answers, the result, token usage and an approximate cost.
- **Interrupted runs (M1 PR 3).** An API-mode run dies with its page, without a chance to record it. The page holds a Web Lock (`navigator.locks`, `wherefore/run/<id>`) for the run's lifetime; the browser drops it the moment the page closes or crashes. Pages and the worker share the extension's origin, so they see the same locks. The worker marks a stored "running" run whose lock is free as interrupted at its startup, on every `save_run`, and on `check_runs` (for views). A second lock, `wherefore/api-run`, makes API-mode runs exclusive: tabs are global, so two triage runs at once make no sense, and starting one while another page runs one fails with `RunAlreadyActive`. Chosen over a heartbeat because it is exact, needs no timers (which Chrome throttles in hidden pages) and writes nothing while idle.
- **Pages talk to the worker over RPC** (M1, PR 2). `WorkerRpcs` (in `core`, so M2's broker can forward tool calls with the same schemas) is served over a `chrome.runtime` Port per page, with a small schema-checked protocol carrying `effect/unstable/rpc` messages. The worker adds its `onConnect` and Port listeners synchronously at startup and buffers events, so the Port that woke it isn't lost. A page reconnects on its next call after the worker stops; calls in flight on a dropped Port fail with `WorkerUnavailable` (never hang), and a call that never left the page is retried once on the new Port. Only Ports from the extension's own origin are served.
- **Views share a run (M1 PR 4).** Every open view shows a run from the Store, but its `QuestionsInbox` and handle live in the page that started it. Views pass "answer this ask" and "stop this run" to that page over a same-origin `BroadcastChannel` (`wherefore/runs`, schema-checked, `Tidy` in `src/ui/`); the owner answers through its inbox, so the first answer still wins, and replies whether it was accepted. A view watching a running run waits on its Web Lock (`whenReleased`) and then calls `check_runs`, so a closed panel's run shows as interrupted in the others at once.
- **Undo survives the worker.** `closeTabs` writes the closed tabs to `chrome.storage.session` (`undo:<token>`) before closing anything; `undoClose(token)` works from a restarted worker. Records expire after 10 minutes and are dropped on the next close. The caller passes its window id (`keepWindowAlive`): closing every tab there opens a new one first, so the side panel stays.

### A5. Storage: `chrome.storage.local` behind a `Store` service
- **What's stored:** `items` and `settings` (M1, PR 2), and runs (PR 3). Each key is stored as `{ version, data }`, one version per key (not per item). Reading decodes the envelope, runs the key's migrations up to the current version, decodes `data` with its schema, and the worker writes a migrated value back. Adding a key is one `StoreKey` value.
- **Runs: one key per run.** Each run is stored under `run:<id>`, so a step rewrites only its own run. `runIndex` lists the stored runs, oldest first, as `{ id, status }`, and keeps the last 10: saving an 11th removes the oldest run's key. The worker writes the run and, when the run is new or its status changed, the index in one `set`. Pruning and the interrupted-run sweep (A4) read the index, and open only the runs it says are running. Views follow one run with `StoreReader.watch(runKey(id))`, or every run with `StoreReader.watchRuns`, which decodes only the runs that changed.
- **Never wipe user data.** A value that doesn't decode (or comes from a newer version) is copied to `backup:<key>:<epoch ms>`, and reads and writes of that key fail with a typed `StoreUnreadable` until the user decides. The way out (M1 PR 4) is `reset_store_key` for `items`, `settings` or `runIndex`: it makes sure the backup exists, then removes the key, so it reads as empty; the UI offers it as "Start fresh (keeps the copy)". Views get the same error without making a backup. This applies per run key: an unreadable run is backed up and refused on its own, the sweep skips it, and `watchRuns` lists it under `unreadable` next to the readable runs.
- **Writes:** only the worker writes (A4), read-modify-write under one lock; item and run changes go through `core`'s pure helpers. Views read `chrome.storage.local` directly (`StoreReader.get`, `StoreReader.watch` as a `Stream`). Settings (API key, model) stay in `chrome.storage.local`, never `sync`.
- **Reviewed runs (M1 PR 4).** A run's `reviewedAt` (optional, so older runs still decode) is set by `set_run_reviewed` when the user saves from its results, and cleared by that save's undo. Home offers "Review" only for the newest succeeded run without it.
- **Room:** `unlimitedStorage` covers large runs with tab snapshots.
- **Sync:** `storage.onChanged` keeps views in sync, through a custom Atom-backed store.
- **No sync service, no server.** Nothing leaves the machine except calls to the model the user chose.

### A6. Incremental triage
Before calling the model, `core` matches open tabs to open items by normalized URL. Normalization drops tracking parameters and in-page anchors (`#install`), but keeps fragments that look like client-side routes (`#/projects/42`, `#!…`, Gmail's `#inbox/<id>`); otherwise every Gmail thread would match a saved one. Matching compares real URLs: secret parameters are redacted only in what the model sees, because a param like `key=` can identify a document and a false match would close a tab under the wrong item. The model only sees unmatched tabs, plus a compact list of open items (id, task, domains), so `submit_intentions` can attach a new tab to an existing item instead of creating a duplicate.

### A7. UI: React 19 + Atom
Chosen for fit with Effect v4 (2026-10-04): Atom bindings exist for React, Solid and Vue at the same version as `effect` (all at 4.0.0-rc.117). `@effect/atom-react` is the one the Effect team builds and documents first, and React has the widest component ecosystem. The side panel and the full page share components (`src/ui/`); styles are plain CSS with the canvas tokens' values copied into neutral custom properties (`--wf-*`), on the system font stack (no remote fonts).

**How views hold state (M1 PR 4).** One `Atom.runtime` per registry builds the view's services (`WorkerClient`, `StoreReader`, the API agent, `PageTabs`, `Tidy`) and is kept alive, because a run started from the page lives in it. The Store and the open tabs are stream-backed Atoms (`StoreReader.watch`/`watchRuns`, `PageTabs.watch`), so a change made anywhere shows up in every view; views never write storage, they call the worker. `PageTabs` reads `chrome.tabs` directly, because saving and matching need real URLs (the model's `list_tabs` is redacted); closing, undo and reopening still go through the worker. The services layer is itself an Atom value, so tests mount the real `App` over the real worker, Store and agent with fake tabs and a scripted model.

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
3. **Bundle size: not a target (owner's decision, M1 PR 3).** The extension loads from local disk, so size costs parse time, not download, and barely matters. The agent is imported eagerly. If worker startup or opening the panel ever feels slow, measure those two times first. For reference (production WXT build, gzip -9): after M1 PR 4 the side panel is 197 KB (713 KB minified) plus 3 KB of CSS, and the worker 59 KB (182 KB minified).
4. **Registry: decided.** Pin `4.0.0-rc.117` for every Effect package: `effect`, `@effect/ai-anthropic`, `@effect/atom-react`, `@effect/platform-*`. `@effect/vitest` is at rc.116, which accepts rc.117. rc.117 still uses the `effect/unstable/*` import paths, and 4.0.0 renamed them (`effect/ai`, `effect/rpc`, ...). The A1 seams keep that rename to a handful of import lines when the registry serves 4.0.0.
5. **MV3 lifecycle.** No official Effect guidance; A4 keeps long work out of the worker.

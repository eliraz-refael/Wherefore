# Tab Intentions: product architecture (draft 0, 2026-10-04)

Builds on [story.md](story.md) and [../research/effect-v4.md](../research/effect-v4.md). The POC (this repo's current code) stays as the reference until the product reaches parity.

## Shape

```
packages/
  core/        Pure domain. No browser, no Node.
               Schemas (Intention, Item, Run, Tab), the Toolkit (5 tools), the prompt,
               URL normalization + matching, Markdown export. Effect + Schema only.
  extension/   WXT, MV3.
               background: TabTools, Store, Broker client (thin; never runs a model)
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
- **Adopt behind our own seams:** `effect/ai` + `@effect/ai-anthropic`, `McpServer`, `effect/rpc`, `effect/process`, `effect/cli` and `effect/reactivity` are all marked unstable. Each sits behind one service of ours (`ModelClient`, `McpSurface`, `BrokerRpc`, `AgentProcess`, the UI store), so a breaking minor release changes one file. Exact version pins; upgrades are deliberate.
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

### A5. Storage: `chrome.storage.local` behind a `Store` service
- **What's stored:** `items`, `runs` (the last N) and `settings`. Each is schema-validated, carries a `version` and migrates on read.
- **Room:** `unlimitedStorage` covers large runs with tab snapshots.
- **Sync:** `storage.onChanged` keeps views in sync, through a custom Atom-backed store.
- **No sync service, no server.** Nothing leaves the machine except calls to the model the user chose.

### A6. Incremental triage
Before calling the model, `core` matches open tabs to open items by normalized URL (dropping fragments and tracking parameters; secret parameters are already redacted for the model). The model only sees unmatched tabs, plus a compact list of open items (id, task, domains), so `submit_intentions` can attach a new tab to an existing item instead of creating a duplicate.

### A7. UI: React 19 + Atom
Chosen for fit with Effect v4 (2026-10-04): Atom bindings exist for React, Solid and Vue at the same version as `effect` (all at 4.0.0-rc.117). `@effect/atom-react` is the one the Effect team builds and documents first, and React has the widest component ecosystem. The side panel and the full page share components; styles come from the design tokens on the canvas. Accessibility rules from the POC review carry over: native controls, labelled inputs, focus kept on in-place updates, a live region for status.

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
3. **Bundle size of AI/RPC/Atom is unmeasured.** Measure in M0 with a spike build; the side panel must stay fast to open.
4. **Registry: decided.** Pin `4.0.0-rc.117` for every Effect package: `effect`, `@effect/ai-anthropic`, `@effect/atom-react`, `@effect/platform-*`. `@effect/vitest` is at rc.116, which accepts rc.117. rc.117 still uses the `effect/unstable/*` import paths, and 4.0.0 renamed them (`effect/ai`, `effect/rpc`, ...). The A1 seams keep that rename to a handful of import lines when the registry serves 4.0.0.
5. **MV3 lifecycle.** No official Effect guidance; A4 keeps long work out of the worker.

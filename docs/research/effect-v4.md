# Effect v4 for Tab Intentions: research notes

Researched 2026-10-04. Source code was read from `Effect-TS/effect` `main` at commit `bc44526` (2026-10-04). "main" in links below means that snapshot.

## Summary

- **Status:** Effect **4.0.0 is out as a stable release.** The GitHub release `effect@4.0.0` was published 2026-10-01 ([release](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0)), and the blog post is dated 2026-09-30 ([blog](https://effect.website/blog/releases/effect/40)). 4.x is an LTS line with at least 3 years of support ([README](https://github.com/Effect-TS/effect/blob/main/README.md)).
- **npm caveat:** from this machine I could not confirm that `effect@4.0.0` is on npm with the `latest` tag. The configured registry (an npm mirror) shows `latest: 3.22.2`, `rc: 4.0.0-rc.117`, `beta: 4.0.0-beta.107`, and has no 4.0.0. See "Unconfirmed / open".
- **Repo move:** development moved from `Effect-TS/effect-smol` (archived 2026-07-14) to `Effect-TS/effect` `main`. v3 now lives on the `v3` branch ([effect-smol README](https://github.com/Effect-TS/effect-smol)).
- **Bottom line:** v4 covers most of what Tab Intentions needs:
  - Schema can replace zod. It emits JSON Schema 2020-12 and supports Standard Schema.
  - There is an Anthropic provider with tool and toolkit support, a stdio MCP server, child processes, a `ws`-based WebSocket server, RPC, a CLI module, Atom with React bindings, and `@effect/vitest`.
  - Nearly all of those modules (everything except Schema/core) are tagged `@stability unstable`, which means breaking changes can land in minor releases.
  - Effect has no ACP module and no native-messaging framing, and it says nothing about MV3 service workers.

## 1. Release status and migration from v3

**Versions and tags**
- On the configured registry (an npm mirror), `npm view effect dist-tags` returned the following on 2026-10-04: `latest 3.22.2` (2026-09-09), `rc 4.0.0-rc.117` (2026-09-21), `beta 4.0.0-beta.107` (2026-08-10). The first v4 prerelease is `4.0.0-beta.0` (2026-02-18), and there are 115 `4.x` prereleases in total.
- GitHub has releases the mirror lacks: `effect@4.0.0-rc.118` (2026-09-28) and `effect@4.0.0` (2026-10-01, not marked prerelease) ([releases](https://github.com/Effect-TS/effect/releases)). On `main`, `packages/effect/package.json` is `4.0.0`.
- The 4.0.0 changelog says: "Effect 4.0 is the first stable release of Effect v4. It replaces the 4.0.0 beta and release-candidate series" ([CHANGELOG 4.0.0](https://github.com/Effect-TS/effect/blob/main/packages/effect/CHANGELOG.md)).
- LTS terms: bug fixes until Sep 2029 or one year after 5.0, whichever is later. Security fixes until Sep 2029 or two years after 5.0 ([blog, 2026-09-30](https://effect.website/blog/releases/effect/40); [README](https://github.com/Effect-TS/effect/blob/main/README.md)).
- Requirements: TypeScript 5.9 or newer, `strict` mode, Node 18 or newer ([README](https://github.com/Effect-TS/effect/blob/main/README.md)).

**Package consolidation** ([MIGRATION.md](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md); [4.0.0 notes](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0))
- These packages were merged into `effect`: `@effect/platform`, `@effect/rpc`, `@effect/cluster`, `@effect/cli`, `@effect/ai`, `@effect/sql`, `@effect/workflow`, `@effect/experimental`.
- These remain separate packages: `@effect/platform-*`, `@effect/sql-*`, `@effect/ai-*` (providers), `@effect/atom-{react,solid,vue}`, `@effect/opentelemetry`, `@effect/vitest`.
- All packages share one version number and must be bumped together. `effect` has zero runtime dependencies.

**Import paths: watch for this**
- In **rc.118** the `effect/unstable/<x>` paths became **`effect/<x>`**, for example `effect/ai`, `effect/http`, `effect/rpc`, `effect/cli`, `effect/reactivity`. No compatibility aliases were kept ([CHANGELOG rc.118, #8354](https://github.com/Effect-TS/effect/blob/main/packages/effect/CHANGELOG.md); [MIGRATION.md](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)).
- The rc.117 build on the mirror still exports `./unstable/*` (from `npm view effect@rc exports`). Blog posts and docs written before late September show the old paths.
- Unstable modules: `ai, cli, cluster, devtools, eventlog, http, http-api, jsonschema, observability, persistence, process, reactivity, rpc, schema, socket, sql, workflow, workers`. Moving them "does not stabilize their APIs" ([MIGRATION.md](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)).
- Stability policy: an `@stability unstable` API may break in a minor release, an `@stability experimental` API may break in a patch release, and an API with no tag follows semver ([README](https://github.com/Effect-TS/effect/blob/main/README.md)).

**Services and layers** ([migration/services.md](https://github.com/Effect-TS/effect/blob/main/migration/services.md))
- `Context.Tag`, `Context.GenericTag`, `Effect.Tag` and `Effect.Service` are all replaced by **`Context.Service`**:
  - Function form: `Context.Service<Shape>("Id")`.
  - Class form: `class X extends Context.Service<X, Shape>()("Id") {}`.
- Earlier v4 betas called this `ServiceMap`. It was renamed to `Context` in beta.44 ([CHANGELOG](https://github.com/Effect-TS/effect/blob/main/packages/effect/CHANGELOG.md)).
- Accessors are gone. Use `yield* Service` or `Service.use(...)`.
- `Effect.Service`'s `make` option survives, but layers are no longer generated for you. You write `static layer = Layer.effect(this, this.make)` yourself. The naming convention is now `.layer` (it was `.Default`).
- `FiberRef` is replaced by `Context.Reference`, and `Runtime<R>` is removed ([MIGRATION.md](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)).

**Effect.fn and generators**
- `Effect.gen`, `Effect.fn` (traced, creates a span) and `Effect.fnUntraced` all exist (`packages/effect/src/Effect.ts` on main). The docs recommend `Effect.fn("name")` for named functions ([LLMS.md](https://github.com/Effect-TS/effect/blob/main/LLMS.md)).
- The only generator change: `Effect.gen(this, fn)` becomes `Effect.gen({ self: this }, fn)` ([migration/generators.md](https://github.com/Effect-TS/effect/blob/main/migration/generators.md)).
- Other changes: `Cause` is flattened and the `catch*` combinators are renamed ([MIGRATION.md](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)).

**Schema changes** ([migration/schema.md](https://github.com/Effect-TS/effect/blob/main/migration/schema.md))
- Many renames:
  - `decodeUnknown` → `decodeUnknownEffect`, `*Either` → `*Exit`.
  - Filters become `check(isX(...))`, for example `minLength` → `isMinLength`.
  - `annotations` → `annotate`, `compose` → `decodeTo`, `parseJson` → `fromJsonString`.
  - `standardSchemaV1` → `toStandardSchemaV1`.
- Behavior change: `Schema.Date` now expects a `Date`, not an ISO string. Use `Schema.DateFromString` for strings.
- `positive`, `negative` and similar filters were removed.
- In the 4.0.0 release, `Schema.brand` became type-only ([4.0.0 notes](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0)).

## 2. Schema as a zod replacement (JSON Schema, Standard Schema)

- **Stability.** Core `Schema` is part of the semver-stable surface. In `Schema.ts` on main, only platform-flavoured declarations carry `@stability unstable` (cookies, headers, URL params, IP/MAC addresses). `Struct`, `String`, `toJsonSchemaDocument` and `toStandardSchemaV1` have no tag.
- **JSON Schema output.**
  - `Schema.toJsonSchemaDocument(schema)` returns a **draft 2020-12** document (`Schema.ts` on main).
  - The stable `effect/JsonSchema` module converts between dialects: it reads Draft-07, 2020-12 and OpenAPI 3.0/3.1, and writes Draft-07, Draft-04 and OpenAPI 3.1 (`JsonSchema.ts` on main).
  - `description` annotations flow into the JSON Schema output; the official tool example annotates each parameter ([ai-docs 20_tools.ts](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/71_ai/20_tools.ts)).
- **Tool definitions.** `Tool.getJsonSchema(tool)` produces the `input_schema` object for a tool. It inlines `$defs`, and it accepts a provider `CodecTransformer` to fit a provider's JSON Schema subset; `effect/ai/AnthropicStructuredOutput.ts` exists for Anthropic (`ai/Tool.ts` on main). This module is unstable.
- **Standard Schema.**
  - `Schema.toStandardSchemaV1(schema)` returns a value that is both the Effect schema and a Standard Schema v1 validator.
  - `Schema.toStandardJSONSchemaV1(schema)` implements the experimental Standard JSON Schema proposal.
  - The spec types are vendored from `@standard-schema/spec` 1.1.0 (`Schema.ts`, `StandardSchema.ts` on main).
- **Verdict.** Schema can define the five tool inputs once and produce the Anthropic and MCP tool definitions. It cannot be passed to `betaZodTool`, which needs zod; you would have to switch to raw JSON-schema tools or to Effect AI.

## 3. Browser use: bundle size, service workers

- Official numbers:
  - "a minimal Effect program bundles to ~6.3 KB (minified + gzipped). With Schema, ~15 KB" ([MIGRATION.md](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md), main 2026-10-04).
  - The release post compares **3.x 35.6 kB vs 4.x 7.1 kB**, min+gz, "built from identical source" ([blog, 2026-09-30](https://effect.website/blog/releases/effect/40)). The two figures probably measure different fixtures; the post does not name the program it measured.
- I found no published size for the `ai`, `rpc`, `reactivity` or `http` modules, or for `@effect/ai-anthropic`. The repo has an internal Rollup/gzip fixture tool (`packages/tools/bundle`), but none of its fixtures cover AI or RPC.
- `effect` declares `sideEffects` only for the Schema JIT-compiler enable entry, so the rest should tree-shake (`packages/effect/package.json` on main).
- I found **no** MV3 service-worker or browser-extension guidance in the repo, MIGRATION docs, changelog or v4 docs nav. `@effect/platform-browser` provides `BrowserSocket` (WebSocket client), `BrowserWorker`, IndexedDB, Clipboard and others (`packages/platform/browser/src`).
- `BrowserKeyValueStore` is backed by `localStorage`, `sessionStorage` or IndexedDB. **`chrome.storage` is not supported**, so you would write a custom `KeyValueStore.make(...)`; that module is unstable (`persistence/KeyValueStore.ts`).

## 4. Node platform pieces for the companion

- `@effect/platform-node` is still a separate package, now at version 4.x ([README](https://github.com/Effect-TS/effect/blob/main/README.md)). It contains `NodeRuntime`, `NodeStdio`, `NodeChildProcessSpawner`, `NodeSocket`, `NodeSocketServer`, `NodeHttpServer`, `NodeWorker` and others (`packages/platform/node/src`).
- **Child processes.**
  - `effect/process` provides `ChildProcess` and `ChildProcessSpawner`.
  - The process handle exposes `stdin` as a `Sink<Uint8Array>` and `stdout`/`stderr` as `Stream<Uint8Array>`.
  - The module is unstable (`process/ChildProcessSpawner.ts` on main; [ai-docs 60_child-process](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/60_child-process/10_working-with-child-processes.ts)).
- **Stdio.** There is a core `Stdio` service plus `NodeStdio.layer`.
- **Sockets.**
  - `NodeSocketServer.makeWebSocket` / `layerWebSocket` wrap the **`ws`** package into a scoped `SocketServer`, so each connection gets a `Socket`.
  - TCP and TLS variants exist.
  - The `ws` options are marked unstable because they expose a third-party API (`platform/node-shared/src/NodeSocketServer.ts`; [4.0.0 notes](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0)).
- **CLI.** `effect/cli` provides `Command`, `Flag`, `Argument`, `Prompt`, completions and help. It is unstable (`cli/Command.ts`; [ai-docs 70_cli](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/70_cli/10_basics.ts)).
- **RPC** (`effect/rpc`, unstable):
  - Server protocols: **SocketServer**, **WebSocket**, HTTP, **Stdio** and **WorkerRunner**.
  - Client protocols: HTTP, **Socket** (WebSocket via `Socket.makeWebSocket` / `BrowserSocket.layerWebSocket`) and Worker.
  - Serialization: `json`, `ndjson`, `jsonRpc`, `ndJsonRpc` and `schemaBinary` (`rpc/RpcServer.ts`, `rpc/RpcClient.ts`, `rpc/RpcSerialization.ts`).
- **Gaps for us:**
  - There is no stdio *client* protocol for RPC (a child process's stdio would need adapting to a `Socket`).
  - Chrome native messaging uses 4-byte length-prefixed JSON frames. None of the built-in serializations do that framing, so it would need a custom codec. This is my inference from the format list.

## 5. AI modules (Anthropic, tools, toolkits, chat/agent loop)

- **Modules.** `effect/ai` contains `LanguageModel`, `Tool`, `Toolkit`, `Chat`, `Prompt`, `Response`, `AiError`, `McpServer` and others. Every module carries `@stability unstable` (`packages/effect/src/ai` on main). The `@effect/ai-anthropic` provider's clients, models and generated schemas are unstable too ([MIGRATION.md](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)). The package is actively changing: Anthropic fixes landed on 2026-10-03 (#8683) and 2026-10-04 (#8603).
- **Tools.**
  - `Tool.make(name, { description, parameters: Schema.Struct(...), success, failure, failureMode })` declares a tool.
  - `Toolkit.make(...tools)` groups them, and `toolkit.toLayer({ ToolName: handler })` provides the handlers.
  - `Tool.dynamic` accepts raw JSON Schema parameters, which is useful for proxying MCP tools.
  - Tools can declare `needsApproval` ([ai-docs 20_tools.ts](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/71_ai/20_tools.ts); `ai/Tool.ts`).
- **Loop semantics.**
  - `LanguageModel.generateText({ prompt, toolkit })` resolves the tool calls of **one** model turn (there is a `disableToolCallResolution` opt-out).
  - The official agent example is a hand-written `while (true)` over `Chat.generateText` that stops when there are no more `toolCalls`.
  - `Chat` keeps history in a `Ref` and can persist it through `BackingPersistence` ([ai-docs 30_chat.ts](https://github.com/Effect-TS/effect/blob/main/ai-docs/src/71_ai/30_chat.ts); `ai/Chat.ts`).
  - There is no built-in equivalent of `toolRunner` / max-steps.
- **Browser with the user's own key.**
  - `AnthropicClient.layer({ apiKey: Redacted, apiUrl?, apiVersion?, transformClient? })` needs only an `HttpClient`, so `FetchHttpClient.layer` from `effect/http` works in browsers.
  - The client sets `x-api-key` and `anthropic-version` but does **not** set `anthropic-dangerous-direct-browser-access`. You can add that header with `transformClient` if CORS requires it (`ai/anthropic/src/AnthropicClient.ts`).
- **Verdict.** It can replace the `@anthropic-ai/sdk` tool runner, at the cost of owning a small loop and accepting an unstable API.

## 6. MCP server

- `effect/ai/McpServer` (unstable) ships a server with `layerStdio`, `layerHttp` and a generic `layer` ([MCP.md](https://github.com/Effect-TS/effect/blob/main/packages/effect/MCP.md); `ai/McpServer.ts`).
- **Tools are the same `Tool`/`Toolkit` objects used for LLM calls**, exposed with `McpServer.toolkit(MyToolkit)` plus `MyToolkit.toLayer(handlers)`. Resources (including URI templates) and prompts with completions are also supported, and elicitation is handled in the source.
- **Stdio transport:** `McpServer.layerStdio({ name, version, protocols: [McpProtocol.v2025_06_18] })` together with `NodeStdio.layer`. Logs must go to stderr.
- Supported protocol revisions are **2024-11-05, 2025-03-26 and 2025-06-18**. The legacy two-endpoint HTTP+SSE transport is not supported ([MCP.md](https://github.com/Effect-TS/effect/blob/main/packages/effect/MCP.md)). There is a conformance test suite under `packages/effect/test/ai/McpServer/McpConformance`.
- I found **no MCP client** in the repo.

## 7. UI and reactivity (Atom)

- Atom has moved into core as `effect/reactivity`: `Atom`, `AtomRegistry`, `AtomRef`, `AsyncResult`, `AtomRpc`, `AtomHttpApi`, `Hydration`. **It is unstable** (`reactivity/Atom.ts`).
- `Atom.kvs` persists atoms through a `KeyValueStore`, and `Atom.searchParam` binds atoms to URL search params.
- Framework bindings are new v4 packages: `@effect/atom-react` (peer `react >=19 <20`), `@effect/atom-solid` and `@effect/atom-vue` ([README](https://github.com/Effect-TS/effect/blob/main/README.md); `packages/atom/react/package.json`).
- The React hooks are `useAtomValue`, `useAtom`, `useAtomSet`, `useAtomSuspense`, `useAtomRef` and others. The hooks module has no stability tag, but it is built on the unstable Atom (`packages/atom/react/src/Hooks.ts`).
- Fixes were still landing in 4.0.0 (`Atom.family` and `Atom.fn` race fixes, [4.0.0 notes](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0)).

## 8. Testing

- `@effect/vitest` 4.x exists, with peer dependency `vitest >=5 <6`. It provides `it.effect`, `it.live`, `layer(...)` (with nested `it.layer`) and `addEqualityTesters` (`packages/vitest`).
- Its `vitest` re-export is marked unstable ([4.0.0 notes](https://github.com/Effect-TS/effect/releases/tag/effect%404.0.0)).
- `RpcTest` and `TestSchema` (unstable) also exist. Official examples: [ai-docs 09_testing](https://github.com/Effect-TS/effect/tree/main/ai-docs/src/09_testing).

## Unconfirmed / open

- **npm state of 4.0.0.** GitHub says 4.0.0 was released 2026-10-01. The registry reachable from here (an npm mirror) shows `latest 3.22.2` and `rc 4.0.0-rc.117`, with neither rc.118 nor 4.0.0. A direct query to `registry.npmjs.org` returned stale data (`beta 4.0.0-beta.60`), and npmjs.com returned HTTP 403. I could not confirm whether `latest` now points to 4.0.0.
- **Bundle cost of the modules we would use.** There are no official numbers for `effect/ai`, `@effect/ai-anthropic`, `effect/rpc` or `effect/reactivity`. We need to measure with our WXT build.
- **MV3 service worker behavior.** There is no official guidance on fiber/scope lifetime when the service worker is killed, or on `ManagedRuntime` per SW wake. This needs a prototype.
- **Anthropic from the extension.** I did not verify whether the request needs `anthropic-dangerous-direct-browser-access` under extension host permissions; this is an Anthropic/Chrome question, not an Effect one. I also did not verify whether `@effect/ai-anthropic` supports all the beta features we use, such as prompt caching.
- **MCP 2025-11-25 support.** It is not listed; only the revisions up to 2025-06-18 are named.
- **Effect output in the MCP TS SDK.** I did not check whether `@modelcontextprotocol/sdk` accepts Standard Schema / Effect Schema directly; the alternative is passing the converted JSON Schema.
- **Docs coverage.** The v4 docs navigation at effect.website shows no AI, MCP, Atom, CLI or RPC sections. The in-repo `ai-docs/`, `MCP.md` and JSDoc are currently the main references.

## Implications for Tab Intentions

**Effect v4 can replace:**
- **zod.** Define `list_tabs`, `read_pages`, `wake_and_read_pages`, `ask_user` and `submit_intentions` once as `Schema` or `Tool.make`. This is stable core API. Derive JSON Schema 2020-12 for both Anthropic and MCP, and use `toStandardSchemaV1` where a library wants Standard Schema.
- **The `@anthropic-ai/sdk` tool runner** (in the browser): `@effect/ai-anthropic` + `FetchHttpClient` + `Toolkit` + `Chat`, with our own short loop. The same `Toolkit` can back the MCP server, which removes the current double definition.
- **The `@modelcontextprotocol/sdk` stdio server** (companion): `McpServer.layerStdio` + `McpServer.toolkit`. Check the protocol revision against our MCP clients.
- **The localhost WebSocket bridge.**
  - Companion side: `NodeSocketServer.layerWebSocket` (`ws`).
  - Extension side: `BrowserSocket.layerWebSocket`.
  - On top of that, `effect/rpc` gives typed, schema-validated request/stream calls in place of hand-rolled message types.
- **UI state.** `effect/reactivity` Atom + `@effect/atom-react` (React 19) if we pick React; Solid and Vue bindings also exist. `chrome.storage` needs a custom `KeyValueStore`.
- **Child-process plumbing.** `effect/process` handles spawning the ACP agent and wiring its stdio streams with scoped cleanup.
- **The companion CLI.** `effect/cli` can serve as the CLI framework.
- **Tests.** `@effect/vitest`.

**Effect v4 cannot replace:**
- **ACP protocol logic.** Effect has no ACP module, so keep `@agentclientprotocol/sdk`, or wrap it in an Effect service.
- **Native-messaging framing.** The 4-byte length-prefixed protocol needs a custom codec over `Stdio`.
- **Chrome APIs and service-worker lifecycle.** `chrome.*`, `chrome.storage` persistence and SW restart handling stay ours.

**Main risks:**
1. **Unstable surface.** Every module we would lean on beyond Schema is `@stability unstable` and can break in minor releases: `ai`, `McpServer`, `rpc`, `socket`, `process`, `cli`, `reactivity`, and the `ai-anthropic` client. Pin exact versions.
2. **Fresh major.** 4.0.0 is days old. Fixes to AI/Anthropic/MCP/Atom are landing daily, and the import paths changed in rc.118. Examples older than late September use `effect/unstable/*` paths that no longer exist.
3. **Bundle size.** The core is about 6–7 KB and roughly 15 KB with Schema, but there are no numbers for AI/RPC/Atom. Measure in the WXT build before committing the side panel and SW to it.
4. **MV3 service worker.** There is no official guidance. Long-lived fibers and scopes die with the SW, so state must still round-trip through `chrome.storage`.
5. **Registry lag.** The npm mirror in use did not have 4.0.0 on 2026-10-04, so check what the registry actually serves before pinning.

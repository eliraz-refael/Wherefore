# Wherefore

**Close every tab without losing what it was for.**

People keep tabs open because each one stands in for an intention: something to finish, follow, decide, read or come back to. Wherefore works out *why* each tab is open, groups your tabs into those intentions, and saves them, so you can close the tabs and keep the reasons. ("Wherefore" means *why*: as in "wherefore art thou Romeo".)

> **Status: early.** A working proof of concept lives at the repo root. The product is being rewritten on [Effect](https://effect.website) v4 in `packages/`. Nothing is published to the Chrome Web Store yet.

## How it works

An agent gets your tabs (titles and redacted URLs) and decides on its own when to:

- `read_pages`: read page text (PR state, product page, article progress)
- `wake_and_read_pages`: reload sleeping tabs in the background, then read them
- `ask_user`: ask you about tabs that are still unclear (shown in the side panel)
- `submit_intentions`: return intentions covering every tab

Finished things (a merged PR, a completed order) and dead tabs (logins, error pages, duplicates) become easy closes. Everything else becomes a saved item (To do, Follow up, Read or Keep) that you can come back to later.

## Try the proof of concept

Requires Node 22+ and pnpm (the version is pinned in `package.json`).

```sh
pnpm install
pnpm build:all        # extension + companion
```

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → `.output/chrome-mv3`.
Click the toolbar icon to open the side panel and pick a mode.

### Three ways to connect a model

| Mode | Who runs the model | Needs |
|---|---|---|
| **API key** | The side panel calls the Claude API directly | An Anthropic API key (pay per use) |
| **MCP** | Your agent (Claude Code, Claude Desktop, Cursor, …) drives the extension's tools | The companion, registered as an MCP server |
| **ACP agent** | The side panel starts an ACP agent (default: Claude Code via `@agentclientprotocol/claude-agent-acp`) | The companion's native host; the agent's own login |

MCP and ACP use your existing agent subscription, with no API key.

#### MCP / ACP setup (once per machine)

```sh
pnpm companion:install
```

This registers the native messaging host for Chrome, Chromium, Brave, Edge and Arc (macOS, Linux, Windows) and prints the MCP command, for example:

```sh
claude mcp add --scope user tab-intentions -- /path/to/node /path/to/companion/dist/cli.js mcp
```

Then in Claude Code run `/mcp__tab-intentions__organize-tabs`, or just ask it to organize your tabs.
Re-run `pnpm companion:install` if you move the repo or change Node versions (the paths are baked in).

### How the pieces talk

```
API:  side panel ──HTTPS──► Claude API
MCP:  agent ──stdio/MCP──► companion `mcp` ◄──ws://127.0.0.1:17373-17380── extension background
ACP:  side panel ──native messaging──► companion `native-host` ──stdio/ACP──► agent
                                                                    └─ gets companion `mcp` for the tools
```

- The extension ID is pinned by the public `key` in `wxt.config.ts`, so every unpacked install has the same ID (`anpbbaiepneaddgoldgmapilgiflochg`). The native host manifest and the bridge's origin check rely on it.
- The bridge only accepts WebSocket connections from that extension's origin.
- With several Chrome profiles, each profile's extension connects to the MCP server, and the agent sees all their tabs.
- In ACP mode the agent may only call this project's tools; other tool permission requests are declined.

## Privacy

- URL parameters that look like secrets (`code`, `token`, `sk`, …) and very long values are redacted before anything leaves the browser.
- Mail, chat, cloud consoles, API-key, OAuth and localhost pages are never read (`lib/tabs.ts` → `SENSITIVE_HOSTS`).
- Tab metadata, and snippets of the pages the agent reads, go to whichever model you connect.

## Repository layout

| Path | What |
|---|---|
| `packages/core` | The rewrite's pure domain: schemas, the shared tool kit, URL matching |
| `packages/extension` | The rewrite's MV3 extension (side panel and full page) |
| `packages/companion` | The rewrite's local Node process: MCP server, native-messaging broker |
| `lib/`, `entrypoints/` | Proof-of-concept extension |
| `companion/` | Proof-of-concept companion (its own pnpm workspace) |
| `docs/product/` | Product story, architecture decisions (ADRs) and milestones |
| `docs/research/` | Research notes (Effect v4) |

The proof of concept stays as the reference until the rewrite reaches parity, then it is removed.

## Development

```sh
pnpm install
pnpm typecheck:packages   # rewrite packages
pnpm test:packages
pnpm -C packages/extension build   # rewrite extension (see packages/extension/README.md)
pnpm typecheck            # proof of concept
```

- Effect packages are pinned to exact versions on purpose; don't add `^` ranges.
- Code in `packages/*` imports Effect's unstable modules (`effect/unstable/*`) only from that package's `src/unstable.ts`.

## Contributing

`main` is protected: every change goes through a pull request, and CI (typecheck, tests, build) must pass. PRs are merged with squash or rebase only, so history stays linear. To report a security issue, use GitHub's private vulnerability reporting (the repo's **Security** tab), not a public issue.

## License

[GPL-3.0-or-later](LICENSE)

# Tab Intentions (POC)

Infers *why* each open tab is still open, so you can close tabs with confidence.

An agent gets your tabs (titles + redacted URLs) and decides on its own when to:
- `read_pages` - read page text (PR state, product page, article progress)
- `wake_and_read_pages` - reload sleeping tabs in the background, then read them
- `ask_user` - ask you about tabs that are still unclear (shown in the side panel)
- `submit_intentions` - return intentions covering every tab

Nothing is saved or closed - this POC only proves the intent extraction. Rate each intention 👍/👎 and use **Export JSON** to compare runs.

## Setup

```sh
pnpm install
pnpm build:all        # extension + companion
```

Chrome → `chrome://extensions` → Developer mode → **Load unpacked** → `.output/chrome-mv3`.
Click the toolbar icon to open the side panel and pick a mode.

## Three ways to connect a model

| Mode | Who runs the model | Needs |
|---|---|---|
| **API key** | The side panel calls the Claude API directly | An Anthropic API key (pay per use) |
| **MCP** | Your agent (Claude Code, Claude Desktop, Cursor, …) drives the extension's tools | The companion, registered as an MCP server |
| **ACP agent** | The side panel starts an ACP agent (default: Claude Code via `@agentclientprotocol/claude-agent-acp`) | The companion's native host; the agent's own login |

MCP and ACP use your existing agent subscription - no API key.

### MCP / ACP setup (once per machine)

```sh
pnpm companion:install
```

This registers the native messaging host for Chrome/Chromium/Brave/Edge/Arc (macOS, Linux, Windows)
and prints the MCP command, e.g.:

```sh
claude mcp add --scope user tab-intentions -- /path/to/node /path/to/companion/dist/cli.js mcp
```

Then in Claude Code: `/mcp__tab-intentions__organize-tabs`, or just ask it to organize your tabs.
Re-run `pnpm companion:install` if you move the repo or change Node versions (paths are baked in).

## How the pieces talk

```
API:  side panel ──HTTPS──► Claude API
MCP:  agent ──stdio/MCP──► companion `mcp` ◄──ws://127.0.0.1:17373-17380── extension background
ACP:  side panel ──native messaging──► companion `native-host` ──stdio/ACP──► agent
                                                                    └─ gets companion `mcp` for the tools
```

- The extension ID is pinned by the public `key` in `wxt.config.ts`, so every unpacked install has the same ID
  (`anpbbaiepneaddgoldgmapilgiflochg`), which the native host manifest and the bridge's origin check rely on.
- The bridge only accepts WebSocket connections from that extension's origin.
- With several Chrome profiles, each profile's extension connects to the MCP server, and the agent sees all their tabs.
- In ACP mode the agent may only call this project's tools; other tool permission requests are declined.

## Privacy (POC level)

- URL params that look like secrets (`code`, `token`, `sk`, …) and very long values are redacted.
- Mail, chat, cloud consoles, API-key, OAuth and localhost pages are never read (`lib/tabs.ts` → `SENSITIVE_HOSTS`).
- Tab metadata and snippets of pages the agent reads go to whichever model you connect.

## Layout

- `lib/protocol.ts` - shared prompt, tool schemas, wire types (extension + companion)
- `lib/tabs.ts`, `lib/page.ts` - tab snapshot, redaction, page extraction, waking tabs
- `lib/agent.ts` - API-key mode agent loop
- `entrypoints/background.ts` - MCP bridge: runs tool calls from companion servers
- `entrypoints/sidepanel/` - UI for all modes
- `companion/src/` - `mcp`, `native-host` (ACP client), `install`
- `companion/scripts/smoke-*.mjs` - tests for MCP and ACP without Chrome or a model

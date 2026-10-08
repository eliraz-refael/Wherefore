# Wherefore companion

A small Node program that lets local agents (Claude Code over ACP or MCP) reach your open tabs
through the Wherefore extension. You need it to tidy up with your Claude Code login (no API key);
API-key mode works without it.

Chrome starts it for the extension through
[native messaging](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging).
For each Chrome profile that has the extension, it runs a **broker**: a local socket that agents
call, which forwards their tool calls to the extension. Nothing listens on the network.
See `docs/product/architecture.md` (A3) for the design.

## Install

Requires Node 22 or newer. Run this in a terminal where `claude` and `npx` work:

```sh
npx @eliraz-refael/wherefore install
```

**Without npm's registry**, install the tarball from a
[GitHub Release](https://github.com/eliraz-refael/Wherefore/releases) (tags `companion-v…`):

```sh
npm install -g https://github.com/eliraz-refael/Wherefore/releases/download/companion-v0.1.0/eliraz-refael-wherefore-0.1.0.tgz
wherefore install
```

**From a checkout** (for developing the companion):

```sh
pnpm install
pnpm -C packages/companion build
node packages/companion/dist/cli.js install
```

The commands below say `wherefore`; with `npx`, that is `npx @eliraz-refael/wherefore`, and from a
checkout `node packages/companion/dist/cli.js`.

`install` registers the native messaging host `io.github.eliraz_refael.wherefore`:

- **macOS**: a manifest in `~/Library/Application Support/<browser>/NativeMessagingHosts/` for
  Chrome, and for Chrome Beta, Chromium, Brave, Edge and Arc when they are installed.
- **Linux**: the same under `~/.config/<browser>/NativeMessagingHosts/` (Chrome, Chrome Beta,
  Chromium, Brave, Edge).
- **Windows**: a manifest in `%USERPROFILE%\.wherefore\` and a key under
  `HKCU\Software\<browser>\NativeMessagingHosts\` for Chrome, Chromium, Brave and Edge.

The manifest points at `~/.wherefore/native-host.sh` (`native-host.bat` on Windows), which runs
the companion with the Node that ran `install`. That Node is pinned by a stable `PATH` entry
when one points at it (e.g. `/run/current-system/sw/bin/node` rather than a `/nix/store/...`
path), and if the pinned Node is ever gone the wrapper falls back to `node` on the copied
`PATH`. It also copies `PATH`, proxy settings and a few
other variables from your shell, because Chrome starts it with a minimal environment. It never
copies API keys. Only the Wherefore extension (`chrome-extension://anpbbaiepneaddgoldgmapilgiflochg/`)
may start it.

`install` copies the companion (one file, `cli.js`) to `~/.wherefore/companion/<version>/` and the
wrapper runs that copy, so it keeps working when npm clears `npx`'s cache or a global install is
upgraded. It removes older copies, except the previous one and any a running broker still uses.
A build in a checkout (a `src/` next to its `dist/`) is not copied: the wrapper runs it in place, so a
rebuild takes effect the next time Chrome starts the host, and if you move the checkout you run
`install` again. `install` also writes a launcher, `~/.wherefore/bin/wherefore` (`bin\wherefore.cmd` on
Windows), which runs the current copy (or the checkout's build) with the same Node and passes its
arguments on: `~/.wherefore/bin/wherefore status` works whichever way you installed, and it is what
Claude Code's MCP config names, so that config survives updates. `status` shows which copy Chrome
and the launcher run, and reports a wrapper whose `cli.js` or pinned Node is gone as
`needs install`.

Then reload the extension in `chrome://extensions`, or press **Check again** in its Settings.
Settings → Companion should say "Connected".

Run `install` from a terminal where `claude` and `npx` work (and where `CLAUDE_CONFIG_DIR` is
set, if you use it): the wrapper copies that terminal's `PATH` and `CLAUDE_CONFIG_DIR`, and the
agent the companion starts gets them.

**Updating.** Run `npx @eliraz-refael/wherefore@latest install` (or install the newer tarball, or
pull and rebuild a checkout, then run `install`), and reload the extension: the extension and the
companion refuse each other's older versions (Settings says which one to update). Claude Code's MCP
config (below) needs no change: it runs the launcher, which now runs the new version.

## Check it

```sh
wherefore status
```

lists which copy Chrome runs, where the host is registered, and every live broker (one per
connected Chrome profile):

```
Chrome runs the installed copy of 0.1.0:
  /usr/local/bin/node /Users/you/.wherefore/companion/0.1.0/cli.js
...
Brokers (one per connected Chrome profile), registered in /Users/you/.wherefore/run:
  k3jx...  pid 41235  extension 0.0.0  companion 0.1.0  since 10/6/2026, 9:41:02 PM
```

## Claude Code from the side panel (ACP mode)

With the companion connected, the side panel's **Tidy up** runs Claude Code on your own Claude Code
login: no API key. First run offers it ("Tidy up my N tabs · Uses your Claude Code login"), and
Settings → Connection switches between **Claude Code** and **Anthropic API key**.

What happens when you press Tidy up:

1. The extension creates the tidy-up and shows it at once ("Starting Claude Code…").
2. The profile's broker starts the agent command, by default
   `npx -y @agentclientprotocol/claude-agent-acp@0.81.1` (Claude Code over the
   [Agent Client Protocol](https://agentclientprotocol.com)), in an empty folder,
   `~/.wherefore/agent`. The first run downloads it, which can take a minute.
3. The agent gets one MCP server, this CLI: `wherefore mcp --profile <this profile> --run <run id>`.
   It sees only this profile's tabs, and its tidy-up is the one the panel created. Claude Code is
   also asked for no built-in tools and no other MCP servers.
4. The prompt is the same triage prompt API mode uses. Progress, questions and results show in the
   panel as with any tidy-up.

**What the agent may do.** Only Wherefore's five tools. The companion answers the agent's
permission requests itself: Wherefore's tools are allowed (once), everything else (shell commands,
file edits, web fetches, other MCP tools) is refused. Permission modes are never offered in
Settings, and a session that starts in another mode (e.g. "bypass permissions" from your Claude
Code settings) is put back to "default" first; if it can't be, the tidy-up doesn't start. The
default command pins the agent's version (0.81.1), because the companion relies on its session
options; an agent with no sign of life for 10 minutes fails the tidy-up.

**Model and effort.** Settings shows them as Claude Code offers them, after the first tidy-up
(until then: Sonnet, medium effort). Your picks apply from the next tidy-up, and only while Claude
Code still offers them.

**Stop** cancels Claude Code's turn, then ends its whole process tree (`npx`, Node and Claude Code;
`taskkill /T` on Windows). The tidy-up is stored as stopped.

**Usage.** If Claude Code reports a cost, Settings' usage line shows it (at list prices; on a Claude
plan it is included).

**Another ACP agent.** Settings → Connection → Agent command takes any command that speaks ACP on
stdio (words are split on spaces; quote paths with spaces; no other shell features). It runs with
the companion's environment, and gets the same MCP server and the same permission guard.

## MCP mode (Claude Code)

`wherefore mcp` is an MCP server on stdio. It finds every connected Chrome profile through the
brokers, and gives an MCP client (Claude Code, or any other) Wherefore's five tools: `list_tabs`,
`read_pages`, `wake_and_read_pages`, `ask_user` and `submit_intentions`, plus a `tidy_up` prompt.
`install` prints the command that adds it to Claude Code, through the launcher:

```sh
claude mcp add --scope user wherefore -- /Users/you/.wherefore/bin/wherefore mcp
```

(on Windows, `-- cmd /c C:\Users\you\.wherefore\bin\wherefore.cmd mcp`). The line is the same after
every update, so you add it once. If you added Wherefore to Claude Code with an older companion
(whose line named `node` and a `cli.js`), `install` says so once: run
`claude mcp remove --scope user wherefore`, then add the new line.

Then open the Wherefore side panel and ask Claude Code to tidy up your tabs (or run its
`/mcp__wherefore__tidy_up` prompt). While it works:

- **The side panel follows along.** The tidy-up is stored in the profile as it goes, the panel
  switches to it, and when Claude Code submits, the panel shows the results to save and close,
  exactly like a tidy-up started in the panel. Claude Code never closes tabs.
- **Questions appear in the panel.** `ask_user` shows them in that profile's side panel; the first
  answer from any open panel wins. With no panel open, Claude Code is told so (Chrome doesn't let
  the extension open the panel by itself) and can ask you in the chat instead.
- **Stop in the panel stops Claude Code's tidy-up** and tells it to stop.
- **One tidy-up per profile at a time**, whoever started it: while one runs, starting another (in
  the panel, or from a second agent) is refused with a message saying where the running one came
  from.
- **Several profiles.** Claude Code sees the tabs of every connected profile, with its own tab ids
  (Chrome's can repeat across browsers). Each profile gets its own tidy-up with its own tabs. If a
  profile's Chrome closes midway, its tabs drop out and the rest carries on. A profile that is busy
  with another tidy-up, or whose extension doesn't answer within 10 seconds, is left out, and
  Claude Code is told which one and why.
  `wherefore mcp --profile <id>` (ids from `status`) serves one profile only.
- If Claude Code exits or the profile disconnects before submitting, the tidy-up shows as
  interrupted.

Logs go to stderr (Claude Code shows them with `claude --debug`), and never include page text.

## Uninstall

```sh
wherefore uninstall
```

removes the manifests, the registry keys (Windows), the wrapper script, the launcher and the
copies in `~/.wherefore/companion` (only the version folders it made: `companion/` and `bin/` go only
if nothing else is in them). With a global install, `npm uninstall -g @eliraz-refael/wherefore` then
removes the package itself; `claude mcp remove --scope user wherefore` removes the MCP server. A running broker stops
when Chrome closes its connection: reload the extension or restart Chrome.

## Where things are

| | |
| --- | --- |
| `~/.wherefore/native-host.sh` / `.bat` | What Chrome runs |
| `~/.wherefore/bin/wherefore` / `wherefore.cmd` | The launcher: the current companion, for Claude Code and your terminal |
| `~/.wherefore/companion/<version>/cli.js` | The copy of the companion it starts (`%USERPROFILE%\.wherefore\companion\…` on Windows) |
| `~/.wherefore/run/<profile>.json` | One file per live broker: profile id, pid, socket, versions, access token |
| `~/.wherefore/run/<profile>.<pid>.sock` | The broker's socket (macOS, Linux). On Windows a named pipe, `\\.\pipe\wherefore-…` |

`~/.wherefore/run` is private to your user (mode 0700, entries 0600). Each broker writes a random
access token to its entry, and refuses any request that doesn't carry it, so only your own
processes can call it, even where the socket is visible to others (Windows named pipes). Set
`WHEREFORE_HOME` to use another directory, both when you run `install` (it is copied into the
wrapper and the launcher, so the `claude mcp add` line needs nothing more) and when you run the
CLI some other way.

## Troubleshooting

**Settings says "Not installed".** Chrome found no manifest for the host. Run `install`, check
`status` shows your browser as `installed`, then press **Check again**. On Linux and macOS each
browser has its own manifest directory; for a browser `install` skipped, start it once (so its
config directory exists) and run `install` again.

**"Chrome won't let this extension start the companion."** The manifest doesn't allow this
extension. Run `install` again; `status` reports a manifest that points elsewhere as
`needs install`.

**"The companion didn't start" / "disconnected".** Chrome started the wrapper but it exited.
Run it the way Chrome does to see the error:

```sh
~/.wherefore/native-host.sh chrome-extension://anpbbaiepneaddgoldgmapilgiflochg/
```

It waits for a message from Chrome on stdin; press Ctrl-D to end it. "No Hello from the
extension" means it started fine. A Node or `cli.js` path error means Node, the copy or the
checkout moved: run `install` again. Chrome also prints the host's stderr in its own log when started with
`--enable-logging=stderr`.

**"The socket path is too long."** Unix socket paths are limited to about 100 bytes. Set
`WHEREFORE_HOME` to a shorter directory and run `install` again.

**A broker is listed after Chrome closed.** Chrome normally closes the host's input, and the
broker removes its socket and registry entry. If it was killed (Windows always kills hosts),
the entry stays until the next `status` or broker start notices the process is gone.

**"Claude Code isn't logged in."** Claude Code, started by the companion, found no login. Run
`claude` once in a terminal and log in, then press Start again. If you keep
your Claude Code login in another folder (`CLAUDE_CONFIG_DIR`), the companion must know it: run
`install` again from a terminal where `CLAUDE_CONFIG_DIR` is set (`grep CLAUDE_CONFIG_DIR
~/.wherefore/native-host.sh` shows what the wrapper has), then reload the extension.

**"Wherefore couldn't start Claude Code: npx wasn't found."** The companion runs with the `PATH`
it copied at `install`. Install Node.js (it comes with `npx`), run `install` again from a terminal
where `npx --version` works, and reload the extension. For a custom agent command, the same goes
for its program, or use an absolute path.

**"Claude Code couldn't start the tidy-up: it exited with code …"** The command started but quit
before it spoke ACP; the message ends with its last line of output. Run the command yourself
(`npx -y @agentclientprotocol/claude-agent-acp@0.81.1`) to see the whole error. Behind a proxy, set
`HTTPS_PROXY` before `install`, so npm can download it.

**"Claude Code stopped unexpectedly"** or **"finished without saving the results".** The agent
crashed or ended its turn without submitting. Press Start again. If it keeps happening, run the
agent command in a terminal, or try Claude Code over MCP (below) to watch what it does.

**Claude Code says "Open Chrome with Wherefore".** No broker is running: Chrome is closed, the
extension isn't loaded, or the companion isn't connected (Settings → Companion). After rebuilding
the companion, reload the extension so Chrome starts the new broker; `status` lists the live ones.

**Both the POC and Wherefore companions installed?** That's fine: they use different host
names (`com.tab_intentions.host` and `io.github.eliraz_refael.wherefore`). Only one of the two
extensions can be loaded at a time, because they share an extension ID.

## Development

```sh
pnpm -C packages/companion test       # unit and broker tests
pnpm -C packages/companion build      # bundle dist/cli.js (rolldown)
pnpm -C packages/companion smoke      # drive dist/cli.js like Chrome would, no browser needed
```

ACP mode is tested with a fake ACP agent (`test/fakeAgent.ts`, a real process speaking ACP through
the SDK's agent side); the tests and the smoke script never run the real `claude-agent-acp`.

## Releasing

The package is `@eliraz-refael/wherefore`, on npm and as a tarball on each GitHub Release.
`.github/workflows/release-companion.yml` builds, checks and packs it, attaches the `.tgz` to a
Release for the tag, then publishes the same tarball to npm with provenance.

npm auth is **trusted publishing**: npm trusts this workflow through GitHub's OIDC, with no token
stored anywhere (and provenance comes with it). npm only lets you set that up on a package that
already exists, so the first release uses a short-lived token.

One-time setup, for the first release:

1. An npm account that owns the `eliraz-refael` scope (the npm username `eliraz-refael`, or an
   organization of that name), with two-factor authentication on.
2. A short-lived npm **granular access token** (npmjs.com → Access Tokens → Generate New Token →
   Granular; expiry: a day or a week) with read and write access to the `@eliraz-refael` scope's
   packages and "bypass two-factor authentication" allowed. Save it as the repository secret
   `NPM_TOKEN` (GitHub → Settings → Secrets and variables → Actions).
3. Release (below). The workflow publishes with `NPM_TOKEN` and logs "npm auth: the NPM_TOKEN
   secret".

After the first release:

1. On npmjs.com → `@eliraz-refael/wherefore` → Settings → Trusted Publisher → GitHub Actions:
   organization or user `eliraz-refael`, repository `Wherefore`, workflow filename
   `release-companion.yml`, no environment (the workflow uses none). Save. npm checks the workflow
   file, not the job: the publish runs in its `release` job, and renaming jobs changes nothing
   (only an environment, if one were added, would have to be entered here too).
2. Delete the `NPM_TOKEN` secret, and the token on npmjs.com. Optionally, in the package's
   Settings → Publishing access, require two-factor authentication and disallow tokens.

Later releases need no token: the workflow logs "npm auth: trusted publishing (GitHub OIDC)".

Each release:

1. Bump the version in `package.json` and `src/version.ts` (a test keeps them equal), and merge.
2. Tag the merge commit and push the tag: `git tag companion-v0.1.1 && git push origin companion-v0.1.1`.

The workflow fails if the tag isn't `companion-v<package.json's version>`. A version with a
prerelease part (`0.2.0-rc.1`) is published under npm's `next` tag and marked as a prerelease. A
manual run (Actions → Release companion → Run workflow) is a dry run unless you untick it, and only
releases from a `companion-v…` tag. To try the tarball locally: `pnpm -C packages/companion pack`
(pnpm, not npm: it rewrites the `workspace:*` devDependency), then
`npm install -g --prefix /tmp/wf ./eliraz-refael-wherefore-<version>.tgz`.

import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { EXTENSION_ID, NATIVE_HOST } from '../../lib/protocol';

const BAKED_ENV = [
  'PATH',
  'CLAUDE_CONFIG_DIR',
  'CODEX_HOME',
  'GEMINI_CLI_HOME',
  'XDG_CONFIG_HOME',
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'NO_PROXY',
  'https_proxy',
  'http_proxy',
  'no_proxy',
  'NODE_EXTRA_CA_CERTS',
];

/** Per-OS locations of Chromium-family native messaging host manifests (user level). */
function manifestTargets(): { browser: string; dir?: string; regKey?: string }[] {
  const home = homedir();
  const mac = (p: string) => join(home, 'Library/Application Support', p);
  const linux = (p: string) => join(home, '.config', p);
  switch (platform()) {
    case 'darwin':
      return [
        { browser: 'Chrome', dir: mac('Google/Chrome/NativeMessagingHosts') },
        { browser: 'Chrome Beta', dir: mac('Google/Chrome Beta/NativeMessagingHosts') },
        { browser: 'Chromium', dir: mac('Chromium/NativeMessagingHosts') },
        { browser: 'Brave', dir: mac('BraveSoftware/Brave-Browser/NativeMessagingHosts') },
        { browser: 'Edge', dir: mac('Microsoft Edge/NativeMessagingHosts') },
        { browser: 'Arc', dir: mac('Arc/User Data/NativeMessagingHosts') },
      ];
    case 'win32':
      return [
        { browser: 'Chrome', regKey: 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts' },
        { browser: 'Edge', regKey: 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts' },
        { browser: 'Brave', regKey: 'HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts' },
      ];
    default:
      return [
        { browser: 'Chrome', dir: linux('google-chrome/NativeMessagingHosts') },
        { browser: 'Chromium', dir: linux('chromium/NativeMessagingHosts') },
        { browser: 'Brave', dir: linux('BraveSoftware/Brave-Browser/NativeMessagingHosts') },
        { browser: 'Edge', dir: linux('microsoft-edge/NativeMessagingHosts') },
      ];
  }
}

export function install() {
  const node = process.execPath;
  const cli = realpathSync(process.argv[1]!);
  const home = join(homedir(), '.tab-intentions');
  mkdirSync(home, { recursive: true });

  // Chrome starts native hosts with a minimal environment, so bake in what the ACP agent needs from
  // the user's shell: PATH (for npx), the agent's config location (where its login lives), and
  // corporate proxy / CA settings. API keys are deliberately not copied - the agent should use its login.
  const isWin = platform() === 'win32';
  const env = Object.fromEntries(BAKED_ENV.flatMap((k) => (process.env[k] ? [[k, process.env[k]!]] : [])));
  const shQuote = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const wrapper = join(home, isWin ? 'native-host.bat' : 'native-host.sh');
  writeFileSync(
    wrapper,
    isWin
      ? `@echo off\r\n${Object.entries(env).map(([k, v]) => `set "${k}=${v}"\r\n`).join('')}"${node}" "${cli}" native-host %*\r\n`
      : `#!/bin/sh\n${Object.entries(env).map(([k, v]) => `export ${k}=${shQuote(v)}\n`).join('')}exec ${shQuote(node)} ${shQuote(cli)} native-host "$@"\n`,
  );
  if (!isWin) chmodSync(wrapper, 0o755);

  const manifest = JSON.stringify(
    {
      name: NATIVE_HOST,
      description: 'Tab Intentions companion (runs ACP agents for the extension)',
      path: wrapper,
      type: 'stdio',
      allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
    },
    null,
    2,
  );

  console.log('Native messaging host (ACP mode):');
  for (const t of manifestTargets()) {
    if (t.dir) {
      const browserRoot = dirname(t.dir);
      if (t.browser !== 'Chrome' && !existsSync(browserRoot)) continue;
      mkdirSync(t.dir, { recursive: true });
      writeFileSync(join(t.dir, `${NATIVE_HOST}.json`), manifest);
      console.log(`  ✓ ${t.browser}: ${t.dir}`);
    } else if (t.regKey) {
      const file = join(home, `${NATIVE_HOST}.json`);
      writeFileSync(file, manifest);
      try {
        execFileSync('reg', ['add', `${t.regKey}\\${NATIVE_HOST}`, '/ve', '/t', 'REG_SZ', '/d', file, '/f'], { stdio: 'ignore' });
        console.log(`  ✓ ${t.browser}: registry ${t.regKey}`);
      } catch {
        console.log(`  ✗ ${t.browser}: could not write registry key`);
      }
    }
  }

  const q = (s: string) => (/\s/.test(s) ? `"${s}"` : s);
  console.log(`
MCP mode - add the server to your agent:

  Claude Code:
    claude mcp add --scope user tab-intentions -- ${q(node)} ${q(cli)} mcp

  Any MCP client (JSON config):
    "tab-intentions": { "command": ${JSON.stringify(node)}, "args": [${JSON.stringify(cli)}, "mcp"] }

Then ask your agent to "organize my tabs" (in Claude Code: /mcp__tab-intentions__organize-tabs).
Reload the extension in chrome://extensions if it was already open.`);
}

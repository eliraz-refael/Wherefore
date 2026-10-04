// Smoke test for MCP mode without Chrome: a fake extension answers over the WebSocket bridge,
// and a real MCP client drives the server over stdio.  Run: node scripts/smoke-mcp.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import WebSocket from 'ws';

const EXT_ORIGIN = 'chrome-extension://anpbbaiepneaddgoldgmapilgiflochg';
const tabs = [
  { id: 11, window: 0, index: 0, title: 'fix(rules): bind background by octocat · PR #2270', url: 'https://github.com/x/y/pull/2270' },
  { id: 12, window: 0, index: 1, title: 'Sign in · GitLab', url: 'https://gitlab.com/users/sign_in' },
];

const client = new Client({ name: 'smoke', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: ['dist/cli.js', 'mcp'], stderr: 'inherit' }));

// A web page origin must be rejected.
await new Promise((resolve) => {
  const evil = new WebSocket('ws://127.0.0.1:17373', { origin: 'https://evil.example' });
  evil.on('open', () => { console.log('FAIL: web origin accepted'); process.exitCode = 1; resolve(); });
  evil.on('error', () => { console.log('ok: web origin rejected'); resolve(); });
});

// The fake extension.
const ext = new WebSocket('ws://127.0.0.1:17373', { origin: EXT_ORIGIN });
await new Promise((r) => ext.on('open', r));
ext.send(JSON.stringify({ type: 'hello', profile: 'smoke' }));
ext.on('message', (data) => {
  const msg = JSON.parse(String(data));
  if (msg.type !== 'call') return;
  const reply = (value) => ext.send(JSON.stringify({ type: 'result', id: msg.id, ok: true, value }));
  if (msg.tool === 'list_tabs') reply(tabs);
  else if (msg.tool === 'read_pages') reply(msg.args.tab_ids.map((id) => ({ id, title: 'PR', text: 'Merged' })));
  else if (msg.tool === 'ask_user') reply(msg.args.questions.map((q) => ({ id: q.id, answer: q.options[0] })));
  else if (msg.tool === 'submit_intentions') reply('Saved.');
});

const show = (label, res) => console.log(`${label}:`, res.isError ? 'ERROR' : 'ok', res.content[0].text.slice(0, 160));
console.log('tools:', (await client.listTools()).tools.map((t) => t.name).join(', '));
console.log('prompts:', (await client.listPrompts()).prompts.map((p) => p.name).join(', '));
show('list_tabs', await client.callTool({ name: 'list_tabs', arguments: {} }));
show('read_pages', await client.callTool({ name: 'read_pages', arguments: { tab_ids: [11, 99] } }));
show('ask_user', await client.callTool({ name: 'ask_user', arguments: { questions: [{ id: 'q1', tab_ids: [11], question: 'Why?', options: ['Following', 'Reviewing'] }] } }));
const intention = (ids, kind) => ({ title: 't', why: 'w', kind, tab_ids: ids, confidence: 'high', evidence: 'e' });
show('submit (missing tab)', await client.callTool({ name: 'submit_intentions', arguments: { intentions: [intention([11], 'done')] } }));
show('submit (complete)', await client.callTool({ name: 'submit_intentions', arguments: { intentions: [intention([11], 'done'), intention([12], 'dead')] } }));

ext.close();
await client.close();

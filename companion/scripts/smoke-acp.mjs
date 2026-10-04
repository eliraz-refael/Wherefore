// Smoke test for ACP mode without Chrome or a real model: talks to the native host with Chrome's
// framing and points it at the ACP SDK's mock example agent.  Run: node scripts/smoke-acp.mjs
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const mockAgent = fileURLToPath(new URL('../node_modules/@agentclientprotocol/sdk/dist/examples/agent.js', import.meta.url));

const host = spawn(process.execPath, ['dist/cli.js', 'native-host'], { stdio: ['pipe', 'pipe', 'inherit'] });
const frame = (msg) => {
  const body = Buffer.from(JSON.stringify(msg));
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
};

let buf = Buffer.alloc(0);
host.stdout.on('data', (chunk) => {
  buf = Buffer.concat([buf, chunk]);
  while (buf.length >= 4) {
    const len = buf.readUInt32LE(0);
    if (buf.length < 4 + len) break;
    const msg = JSON.parse(buf.subarray(4, 4 + len).toString());
    buf = buf.subarray(4 + len);
    console.log('panel <-', JSON.stringify(msg).slice(0, 180));
    if (msg.type === 'turn_end' || msg.type === 'fatal') host.stdin.end();
  }
});

host.stdin.write(frame({ type: 'start', command: `"${process.execPath}" "${mockAgent}"`, prompt: 'hello', prefs: {} }));
const timer = setTimeout(() => {
  console.log('FAIL: timeout');
  host.kill();
  process.exit(1);
}, 30_000);
host.on('exit', (code) => {
  clearTimeout(timer);
  console.log('host exited', code);
});

import { spawn, type ChildProcess } from 'node:child_process';
import { homedir } from 'node:os';
import { Readable, Writable } from 'node:stream';
import * as acp from '@agentclientprotocol/sdk';
import { TOOL_NAMES, type AgentSetting, type AgentSettingValues, type HostToPanel, type PanelToHost, type Usage } from '../../lib/protocol';

const debug = (...args: unknown[]) => console.error('[tab-intentions host]', ...args); // stdout is the Chrome channel

// ---------- Chrome native messaging framing: 4-byte little-endian length + UTF-8 JSON ----------

function send(msg: HostToPanel) {
  const body = Buffer.from(JSON.stringify(msg), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

function onMessages(handler: (msg: PanelToHost) => void) {
  let buf = Buffer.alloc(0);
  process.stdin.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (buf.length < 4 + len) break;
      const body = buf.subarray(4, 4 + len).toString('utf8');
      buf = buf.subarray(4 + len);
      try {
        handler(JSON.parse(body) as PanelToHost);
      } catch (e) {
        debug('bad message', e);
      }
    }
  });
}

// ---------- ACP client ----------

/**
 * The kinds of agent settings the panel may change. Permission modes are left out on purpose:
 * "bypass permissions" would skip requestPermission, our guard against the agent's own tools.
 */
const USER_CATEGORIES: (string | null | undefined)[] = ['model', 'thought_level', 'model_config'];

/** Flattens ACP config options (select groups included) into what the panel renders. */
function toSettings(options: acp.SessionConfigOption[] | null | undefined): AgentSetting[] {
  return (options ?? []).filter((o) => USER_CATEGORIES.includes(o.category)).map((o) => {
    const base = { id: o.id, name: o.name, ...(o.description ? { description: o.description } : {}) };
    if (o.type === 'boolean') return { ...base, value: o.currentValue };
    const choices = o.options.flatMap((c) => ('group' in c ? c.options : [c]));
    return {
      ...base,
      value: o.currentValue,
      choices: choices.map((c) => ({ value: c.value, name: c.name, ...(c.description ? { description: c.description } : {}) })),
    };
  });
}

/** Whether `value` is a valid value for `setting` (preferences may be stale or meant for another agent). */
const accepts = (setting: AgentSetting, value: string | boolean) =>
  setting.choices ? typeof value === 'string' && setting.choices.some((c) => c.value === value) : typeof value === 'boolean';

const isOurTool = (title: string) => title.includes('tab-intentions') || TOOL_NAMES.some((n) => title.includes(n));

/** Agent output arrives token by token; collect it and flush as whole lines to the side panel. */
class Buffered {
  private parts: string[] = [];
  constructor(private kind: 'text' | 'thinking') {}
  add(s: string) {
    this.parts.push(s);
  }
  flush() {
    const line = this.parts.join('').trim();
    this.parts = [];
    if (line) send({ type: 'log', kind: this.kind, line });
  }
}

export async function runNativeHost() {
  let child: ChildProcess | null = null;
  let conn: acp.ClientSideConnection | null = null;
  let sessionId: string | null = null;
  let settings: AgentSetting[] = [];
  // Token counts arrive per turn (PromptResponse.usage); the cost arrives in usage_update.
  let usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const text = new Buffered('text');
  const thought = new Buffered('thinking');
  const flush = () => (text.flush(), thought.flush());

  const client: acp.Client = {
    async sessionUpdate({ update }) {
      switch (update.sessionUpdate) {
        case 'agent_message_chunk':
          if (update.content.type === 'text') text.add(update.content.text);
          break;
        case 'agent_thought_chunk':
          if (update.content.type === 'text') thought.add(update.content.text);
          break;
        case 'tool_call':
          flush();
          send({ type: 'log', kind: 'tool', line: update.title });
          break;
        case 'tool_call_update':
          if (update.status === 'failed') send({ type: 'log', kind: 'error', line: `${update.title ?? 'tool call'} failed` });
          break;
        case 'config_option_update':
          settings = toSettings(update.configOptions);
          send({ type: 'settings', settings });
          break;
        case 'usage_update':
          if (update.cost) {
            usage = { ...usage, cost: { amount: update.cost.amount, currency: update.cost.currency } };
            send({ type: 'usage', usage });
          }
          break;
      }
    },
    // Our MCP tools are allowed; the agent's own tools (shell, file edits, ...) are not needed here.
    async requestPermission({ toolCall, options }) {
      const title = toolCall.title ?? '';
      const ours = isOurTool(title);
      const pick = options.find((o) => (ours ? o.kind.startsWith('allow') : o.kind.startsWith('reject')));
      if (!ours) send({ type: 'log', kind: 'info', line: `Declined unrelated tool: ${title}` });
      return pick ? { outcome: { outcome: 'selected', optionId: pick.optionId } } : { outcome: { outcome: 'cancelled' } };
    },
  };

  async function prompt(textToSend: string) {
    if (!conn || !sessionId) return;
    try {
      const response = await conn.prompt({ sessionId, prompt: [{ type: 'text', text: textToSend }] });
      flush();
      if (response.usage) {
        usage = {
          ...usage,
          inputTokens: usage.inputTokens + response.usage.inputTokens,
          outputTokens: usage.outputTokens + response.usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens + (response.usage.cachedReadTokens ?? 0),
          cacheWriteTokens: usage.cacheWriteTokens + (response.usage.cachedWriteTokens ?? 0),
        };
        send({ type: 'usage', usage });
      }
      const { stopReason } = response;
      send({ type: 'turn_end', stopReason });
    } catch (e) {
      flush();
      send({ type: 'fatal', message: e instanceof Error ? e.message : JSON.stringify(e) });
    }
  }

  async function setSetting(id: string, value: string | boolean) {
    const setting = settings.find((s) => s.id === id);
    if (!conn || !sessionId || !setting || !accepts(setting, value) || setting.value === value) return;
    try {
      const request = typeof value === 'boolean' ? { type: 'boolean' as const, value } : { value };
      const { configOptions } = await conn.setSessionConfigOption({ sessionId, configId: id, ...request });
      settings = toSettings(configOptions);
    } catch (e) {
      send({ type: 'log', kind: 'info', line: `Could not set ${setting.name}: ${e instanceof Error ? e.message : JSON.stringify(e)}` });
    }
  }

  async function start(command: string, kickoff: string, prefs: AgentSettingValues) {
    child?.kill();
    usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
    send({ type: 'log', kind: 'info', line: `Starting agent: ${command}` });
    const stderrTail: string[] = [];
    child = spawn(command, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], cwd: homedir() });
    child.stderr?.on('data', (d: Buffer) => {
      stderrTail.push(String(d));
      if (stderrTail.length > 20) stderrTail.shift();
    });
    child.on('exit', (code) => {
      if (code) send({ type: 'fatal', message: `Agent exited with code ${code}.\n${stderrTail.join('').slice(-1500)}` });
    });

    const stream = acp.ndJsonStream(
      Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>,
    );
    conn = new acp.ClientSideConnection(() => client, stream);
    try {
      const init = await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
      const name = init.agentInfo?.title ?? init.agentInfo?.name ?? 'agent';
      send({ type: 'log', kind: 'info', line: `Connected to ${name}` });
      const session = await conn.newSession({
        cwd: homedir(),
        // Give the agent our tools: this same CLI in MCP mode, which talks to the extension.
        mcpServers: [{ name: 'tab-intentions', command: process.execPath, args: [process.argv[1]!, 'mcp'], env: [] }],
      });
      sessionId = session.sessionId;
      settings = toSettings(session.configOptions);
      // In the agent's order: choosing a model can change which efforts exist.
      for (const id of settings.map((s) => s.id)) {
        const value = prefs[id];
        if (value !== undefined) await setSetting(id, value);
      }
      send({ type: 'settings', settings });
    } catch (e) {
      send({ type: 'fatal', message: `Could not start the agent: ${e instanceof Error ? e.message : JSON.stringify(e)}` });
      return;
    }
    await prompt(kickoff);
  }

  onMessages((msg) => {
    if (msg.type === 'start') void start(msg.command, msg.prompt, msg.prefs);
    else if (msg.type === 'prompt') void prompt(msg.text);
    else if (msg.type === 'set_setting') void setSetting(msg.id, msg.value).then(() => send({ type: 'settings', settings }));
    else if (msg.type === 'cancel' && conn && sessionId) void conn.cancel({ sessionId });
  });
  // Chrome closes stdin when the side panel disconnects.
  process.stdin.on('end', () => {
    child?.kill();
    process.exit(0);
  });
}

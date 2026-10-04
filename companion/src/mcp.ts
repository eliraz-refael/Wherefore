import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  BRIDGE_PORTS,
  coverageError,
  EXTENSION_ID,
  KICKOFF,
  SYSTEM_PROMPT,
  TOOLS,
  type BridgeCall,
  type ExtensionToServer,
  type ServerToExtension,
} from '../../lib/protocol';

const log = (...args: unknown[]) => console.error('[tab-intentions mcp]', ...args); // stdout is the MCP channel

type Tab = { id: number; profile?: number } & Record<string, unknown>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Call = DistributiveOmit<BridgeCall, 'type' | 'id'>;

/**
 * The extension connects to us over a localhost WebSocket (one connection per Chrome profile
 * with the extension installed). We forward tool calls to it.
 */
class Bridge {
  private conns = new Map<WebSocket, { profile: string }>();
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private waiters: (() => void)[] = [];
  /** Which connection (profile) owns each tab id, from the last list_tabs. */
  owner = new Map<number, WebSocket>();
  knownTabs: Tab[] = [];

  async listen(): Promise<number> {
    const allowed = new Set([`chrome-extension://${process.env.TAB_INTENTIONS_EXTENSION_ID ?? EXTENSION_ID}`]);
    for (const port of BRIDGE_PORTS) {
      const ok = await new Promise<boolean>((resolve) => {
        const wss = new WebSocketServer({
          host: '127.0.0.1',
          port,
          // Only our extension may connect - web pages can open localhost sockets too.
          verifyClient: ({ origin }: { origin: string }) => allowed.has(origin),
        });
        wss.once('listening', () => {
          wss.on('connection', (ws) => this.accept(ws));
          resolve(true);
        });
        wss.once('error', () => resolve(false));
      });
      if (ok) return port;
    }
    throw new Error(`All bridge ports are busy (${BRIDGE_PORTS[0]}-${BRIDGE_PORTS.at(-1)})`);
  }

  private accept(ws: WebSocket) {
    const ping = setInterval(() => this.send(ws, { type: 'ping' }), 20_000); // keeps the service worker awake
    ws.on('message', (data) => {
      let msg: ExtensionToServer;
      try {
        msg = JSON.parse(String(data)) as ExtensionToServer;
      } catch {
        return;
      }
      if (msg.type === 'hello') {
        this.conns.set(ws, { profile: msg.profile });
        log(`extension connected (profile ${msg.profile})`);
        this.waiters.splice(0).forEach((w) => w());
      } else if (msg.type === 'result') {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.ok) p?.resolve(msg.value);
        else p?.reject(new Error(msg.error));
      }
    });
    ws.on('close', () => {
      clearInterval(ping);
      this.conns.delete(ws);
      log('extension disconnected');
    });
  }

  private send(ws: WebSocket, msg: ServerToExtension) {
    ws.send(JSON.stringify(msg));
  }

  /** The extension's service worker may be asleep; its alarm reconnects within ~30s. */
  async connections(timeoutMs = 40_000): Promise<WebSocket[]> {
    if (this.conns.size === 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (this.conns.size === 0) {
      throw new Error(
        'The Tab Intentions extension is not connected. Make sure it is installed and enabled in Chrome, then try again.',
      );
    }
    return [...this.conns.keys()];
  }

  call(ws: WebSocket, call: Call, timeoutMs = 60_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${call.tool} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.send(ws, { type: 'call', id, ...call } as BridgeCall);
    });
  }
}

const text = (value: unknown) => ({
  content: [{ type: 'text' as const, text: typeof value === 'string' ? value : JSON.stringify(value) }],
});
const error = (message: string) => ({ ...text(message), isError: true });

export async function runMcpServer() {
  const bridge = new Bridge();
  const port = await bridge.listen();
  log(`waiting for the extension on ws://127.0.0.1:${port}`);

  const server = new McpServer(
    { name: 'tab-intentions', version: '0.0.1' },
    {
      instructions: `Tools for understanding the user's open browser tabs (via the Tab Intentions Chrome extension). Use them when the user asks to organize, clean up, triage or understand their tabs.\n\n${SYSTEM_PROMPT}`,
    },
  );

  server.registerPrompt(
    'organize-tabs',
    { description: 'Work out why each open browser tab is open, and which ones are safe to close.' },
    () => ({ messages: [{ role: 'user', content: { type: 'text', text: KICKOFF } }] }),
  );

  server.registerTool('list_tabs', { description: TOOLS.list_tabs.description, inputSchema: TOOLS.list_tabs.input }, async () => {
    try {
      const conns = await bridge.connections();
      const perProfile = await Promise.all(conns.map((ws) => bridge.call(ws, { tool: 'list_tabs', args: {} })));
      bridge.owner.clear();
      bridge.knownTabs = perProfile.flatMap((tabs, profile) =>
        (tabs as Tab[]).map((t) => {
          bridge.owner.set(t.id, conns[profile]!);
          return conns.length > 1 ? { ...t, profile } : t;
        }),
      );
      return text(bridge.knownTabs.map((t) => JSON.stringify(t)).join('\n'));
    } catch (e) {
      return error((e as Error).message);
    }
  });

  for (const tool of ['read_pages', 'wake_and_read_pages'] as const) {
    server.registerTool(tool, { description: TOOLS[tool].description, inputSchema: TOOLS[tool].input }, async (args) => {
      try {
        await bridge.connections();
        const byConn = new Map<WebSocket, number[]>();
        const unknown: unknown[] = [];
        for (const id of args.tab_ids) {
          const ws = bridge.owner.get(id);
          if (ws) byConn.set(ws, [...(byConn.get(ws) ?? []), id]);
          else unknown.push({ id, error: 'unknown tab id - call list_tabs first' });
        }
        const reads = await Promise.all(
          [...byConn].map(([ws, tab_ids]) =>
            bridge.call(ws, { tool, args: { tab_ids, max_chars: args.max_chars } }, 120_000),
          ),
        );
        return text([...reads.flat(), ...unknown]);
      } catch (e) {
        return error((e as Error).message);
      }
    });
  }

  server.registerTool('ask_user', { description: TOOLS.ask_user.description, inputSchema: TOOLS.ask_user.input }, async (args) => {
    let last = 'No extension connected.';
    for (const ws of await bridge.connections().catch(() => [])) {
      try {
        // The user may take a while to answer.
        return text(await bridge.call(ws, { tool: 'ask_user', args }, 30 * 60_000));
      } catch (e) {
        last = (e as Error).message;
      }
    }
    return error(last);
  });

  server.registerTool(
    'submit_intentions',
    { description: TOOLS.submit_intentions.description, inputSchema: TOOLS.submit_intentions.input },
    async ({ intentions }) => {
      const problem = coverageError(
        bridge.knownTabs.map((t) => t.id),
        intentions,
      );
      if (problem) return error(problem);
      try {
        const conns = await bridge.connections();
        await Promise.all(conns.map((ws) => bridge.call(ws, { tool: 'submit_intentions', args: { intentions, tabs: bridge.knownTabs } })));
        const closable = intentions.filter((i) => i.kind === 'done' || i.kind === 'dead').reduce((n, i) => n + i.tab_ids.length, 0);
        return text(
          `Saved ${intentions.length} intentions. ${closable} tabs look safe to close. The user can review them in the Tab Intentions side panel.`,
        );
      } catch (e) {
        return error((e as Error).message);
      }
    },
  );

  await server.connect(new StdioServerTransport());
}

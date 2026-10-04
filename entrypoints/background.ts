import { readPage, wakeAndRead } from '@/lib/page';
import { BRIDGE_PORTS, TOOLS, type BridgeCall, type ExtensionToServer, type ServerToExtension } from '@/lib/protocol';
import { newRun, type BridgeStatus, type PanelMessage, type Run } from '@/lib/run';
import { snapshotTabs, type TabSnapshot } from '@/lib/tabs';

/**
 * The MCP bridge. Companion MCP servers listen on localhost; this service worker connects
 * to each of them and executes their tool calls with chrome.tabs / chrome.scripting.
 */
export default defineBackground(() => {
  browser.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err: unknown) => console.error('setPanelBehavior failed', err));

  const sockets = new Map<number, WebSocket>();
  const connecting = new Set<number>();

  const publishStatus = () =>
    browser.storage.session.set({ bridge: { connections: sockets.size } satisfies BridgeStatus });

  // The run lives in storage, not in a global: the worker can be stopped between tool calls.
  // Updates are read-modify-write, chained so concurrent tool calls don't overwrite each other.
  let runUpdates: Promise<unknown> = Promise.resolve();
  const updateRun = (change: (run: Run | null) => Run | null) => {
    const next = runUpdates.then(async () => {
      const { lastRun } = await browser.storage.local.get('lastRun');
      const run = change((lastRun as Run | undefined) ?? null);
      if (run) await browser.storage.local.set({ lastRun: run });
    });
    runUpdates = next.catch((err: unknown) => console.error('run update failed', err));
    return next;
  };
  // For fire-and-forget updates; failures are already logged by the chain.
  const updateRunLater = (change: (run: Run | null) => Run | null) => void updateRun(change).catch(() => {});
  const log = (line: string) =>
    updateRunLater((run) => {
      run?.log.push({ kind: 'tool', line });
      return run;
    });

  async function profileId(): Promise<string> {
    const { profileId } = await browser.storage.local.get('profileId');
    if (typeof profileId === 'string') return profileId;
    const id = crypto.randomUUID().slice(0, 8);
    await browser.storage.local.set({ profileId: id });
    return id;
  }

  async function execute(call: BridgeCall): Promise<unknown> {
    switch (call.tool) {
      case 'list_tabs': {
        const tabs = await snapshotTabs();
        const { acpRunning, acpLabel } = await browser.storage.session.get(['acpRunning', 'acpLabel']);
        const model = acpRunning ? (typeof acpLabel === 'string' ? acpLabel : 'ACP agent') : 'MCP client';
        await updateRun(() => newRun(acpRunning ? 'acp' : 'mcp', model, tabs));
        log(`Listed ${tabs.length} tabs`);
        return tabs;
      }
      case 'read_pages':
      case 'wake_and_read_pages': {
        const { tab_ids, max_chars } = TOOLS.read_pages.input.parse(call.args);
        const wake = call.tool === 'wake_and_read_pages';
        log(`${wake ? 'Waking' : 'Reading'} ${tab_ids.length} page(s)`);
        return Promise.all(tab_ids.map((id) => (wake ? wakeAndRead : readPage)(id, max_chars ?? 1500)));
      }
      case 'ask_user': {
        const { questions } = TOOLS.ask_user.input.parse(call.args);
        log(`Asking ${questions.length} question(s)`);
        let answers: unknown;
        try {
          answers = await browser.runtime.sendMessage({ type: 'ask', id: crypto.randomUUID(), questions } satisfies PanelMessage);
        } catch {
          throw new Error(
            'The Tab Intentions side panel is not open, so the questions cannot be shown there. Ask the user directly in this conversation instead.',
          );
        }
        updateRunLater((run) => {
          run?.questions.push({ questions, answers: Array.isArray(answers) ? answers : [] });
          return run;
        });
        return answers;
      }
      case 'submit_intentions': {
        // The companion validated coverage across every connected profile.
        const { intentions } = TOOLS.submit_intentions.input.parse({ intentions: call.args.intentions });
        await updateRun((existing) => {
          // Join the run list_tabs started; never append to an earlier, finished one.
          const run = existing && !existing.finishedAt ? existing : newRun('mcp', 'MCP client', []);
          run.tabs = call.args.tabs as TabSnapshot[];
          run.intentions = intentions;
          run.finishedAt = new Date().toISOString();
          run.log.push({ kind: 'tool', line: `Received ${intentions.length} intentions` });
          return run;
        });
        return 'Saved. The intentions are shown in the Tab Intentions side panel.';
      }
    }
  }

  /** Resolves true once connected, false if nothing is listening on the port. */
  function connect(port: number): Promise<boolean> {
    connecting.add(port);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const send = (msg: ExtensionToServer) => ws.send(JSON.stringify(msg));
    let settle: (open: boolean) => void = () => {};
    const settled = new Promise<boolean>((resolve) => (settle = resolve));

    ws.onopen = async () => {
      connecting.delete(port);
      sockets.set(port, ws);
      settle(true);
      void publishStatus();
      send({ type: 'hello', profile: await profileId() });
    };
    ws.onclose = () => {
      connecting.delete(port);
      if (sockets.get(port) === ws) sockets.delete(port);
      settle(false); // a no-op if it had opened
      void publishStatus();
    };
    ws.onmessage = async (event) => {
      let msg: ServerToExtension;
      try {
        msg = JSON.parse(String(event.data)) as ServerToExtension;
      } catch {
        return;
      }
      if (msg.type === 'ping') return send({ type: 'pong' });
      try {
        send({ type: 'result', id: msg.id, ok: true, value: await execute(msg) });
      } catch (err) {
        send({ type: 'result', id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    };
    return settled;
  }

  // Chrome logs every refused connection and nothing can silence it, so probe as few ports as we can:
  // servers take the lowest free port, so stop at the first one where nothing is listening.
  let scanning = false;
  async function scan() {
    if (scanning) return;
    scanning = true;
    try {
      for (const port of BRIDGE_PORTS) {
        if (sockets.has(port) || connecting.has(port)) continue;
        if (!(await connect(port))) break;
      }
    } finally {
      scanning = false;
    }
  }

  // The alarm (30s) wakes the worker within the 40s an MCP server waits; the panel nudges a scan when it needs one sooner.
  browser.alarms.create('bridge-scan', { periodInMinutes: 0.5 });
  browser.alarms.onAlarm.addListener((alarm) => alarm.name === 'bridge-scan' && void scan());
  browser.runtime.onMessage.addListener((msg: unknown) => {
    if (typeof msg === 'object' && msg !== null && (msg as { type?: string }).type === 'scan') void scan();
  });
  void publishStatus();
  void scan();
});

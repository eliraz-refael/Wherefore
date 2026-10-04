import type { Browser } from 'wxt/browser';
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_MODEL, runAgent } from '@/lib/agent';
import {
  DEFAULT_ACP_COMMAND,
  DEFAULT_AGENT_PREFS,
  KICKOFF,
  NATIVE_HOST,
  type AgentSetting,
  type AgentSettingValues,
  type Answer,
  type HostToPanel,
  type Intention,
  type PanelToHost,
  type Question,
} from '@/lib/protocol';
import { newRun, type BridgeStatus, type Mode, type PanelMessage, type Run, type Usage, type Verdict } from '@/lib/run';
import { snapshotTabs } from '@/lib/tabs';
import { closeTabs, reopenTabs, type Closed } from '@/lib/closing';
import { ACTION_FOR_KIND, ITEM_LABEL, ITEM_TYPES, loadItems, toMarkdown, updateItems, type Item, type ItemType, type SavedTab } from '@/lib/tracker';
import { download, favicon, h } from './dom';
import { renderSaved } from './saved';

const KIND_ORDER: Intention['kind'][] = ['work', 'track', 'decide', 'read', 'reference', 'done', 'dead', 'app'];
const KIND_LABEL: Record<Intention['kind'], string> = {
  work: 'Continue working on',
  track: 'Following / waiting on',
  decide: 'Deciding',
  read: 'To read or watch',
  reference: 'Reference',
  done: 'Already done - safe to close',
  dead: 'Dead or duplicate - safe to close',
  app: 'Apps you keep open',
};

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const ui = {
  views: [...document.querySelectorAll<HTMLButtonElement>('#views button')],
  savedCount: $<HTMLSpanElement>('savedCount'),
  setup: $<HTMLDivElement>('setup'),
  analyzeView: $<HTMLDivElement>('analyzeView'),
  savedView: $<HTMLElement>('savedView'),
  savedList: $<HTMLDivElement>('savedList'),
  exportMd: $<HTMLButtonElement>('exportMd'),
  toast: $<HTMLDivElement>('toast'),
  modes: [...document.querySelectorAll<HTMLInputElement>('input[name=mode]')],
  panes: [...document.querySelectorAll<HTMLElement>('.pane')],
  apiSettings: $<HTMLDetailsElement>('apiSettings'),
  apiKey: $<HTMLInputElement>('apiKey'),
  model: $<HTMLInputElement>('model'),
  saveApi: $<HTMLButtonElement>('saveApi'),
  bridgeStatus: $<HTMLSpanElement>('bridgeStatus'),
  rescan: $<HTMLButtonElement>('rescan'),
  acpSettings: $<HTMLDetailsElement>('acpSettings'),
  agentSettings: $<HTMLDivElement>('agentSettings'),
  acpCommand: $<HTMLInputElement>('acpCommand'),
  saveAcp: $<HTMLButtonElement>('saveAcp'),
  analyze: $<HTMLButtonElement>('analyze'),
  stop: $<HTMLButtonElement>('stop'),
  export: $<HTMLButtonElement>('export'),
  status: $<HTMLParagraphElement>('status'),
  usage: $<HTMLParagraphElement>('usage'),
  questions: $<HTMLElement>('questions'),
  reply: $<HTMLFormElement>('reply'),
  replyText: $<HTMLInputElement>('replyText'),
  results: $<HTMLElement>('results'),
  log: $<HTMLOListElement>('log'),
};

let mode: Mode = 'api';
let run: Run | null = null;
let busy = false; // an API-mode or ACP run started from this panel is in progress
let abort: AbortController | null = null;
let acpPort: Browser.runtime.Port | null = null;
let agentLog: { kind: string; line: string }[] = []; // ACP agent output (the tool log lives in `run`)
let agentSettings: AgentSetting[] = []; // as the ACP agent last reported them; cached for the next panel
let agentPrefs: AgentSettingValues = DEFAULT_AGENT_PREFS; // the user's picks, applied when a session starts
let acpUsage: Usage | undefined; // the ACP session's usage; attached to its run at each turn end
let acpStartedAt = '';
let items: Item[] = []; // the tracker, mirrored from storage

let ownWrite = ''; // the last run this panel stored, so its storage echo doesn't re-render (and drop focus)

const persist = () => {
  if (!run) return Promise.resolve();
  ownWrite = JSON.stringify(run);
  return browser.storage.local.set({ lastRun: run });
};
const setStatus = (text: string) => (ui.status.textContent = text);

// ---------- modes & settings ----------

function applyMode(next: Mode) {
  mode = next;
  for (const r of ui.modes) r.checked = r.value === mode;
  for (const p of ui.panes) p.hidden = p.dataset.mode !== mode;
  ui.analyze.hidden = mode === 'mcp';
  if (mode === 'mcp') void browser.runtime.sendMessage({ type: 'scan' }).catch(() => {});
}

for (const r of ui.modes) {
  r.addEventListener('change', () => {
    applyMode(r.value as Mode);
    void browser.storage.local.set({ mode });
  });
}

async function loadSettings() {
  const s = await browser.storage.local.get(['apiKey', 'model', 'acpCommand', 'mode', 'agentSettings', 'agentPrefs']);
  if (Array.isArray(s.agentSettings)) agentSettings = s.agentSettings as AgentSetting[];
  if (s.agentPrefs && typeof s.agentPrefs === 'object') agentPrefs = s.agentPrefs as AgentSettingValues;
  renderAgentSettings();
  ui.apiKey.value = typeof s.apiKey === 'string' ? s.apiKey : '';
  ui.model.value = typeof s.model === 'string' && s.model ? s.model : DEFAULT_MODEL;
  ui.acpCommand.value = typeof s.acpCommand === 'string' && s.acpCommand ? s.acpCommand : DEFAULT_ACP_COMMAND;
  applyMode(s.mode === 'mcp' || s.mode === 'acp' ? s.mode : 'api');
  if (mode === 'api' && !ui.apiKey.value) ui.apiSettings.open = true;
}

ui.saveApi.addEventListener('click', async () => {
  await browser.storage.local.set({ apiKey: ui.apiKey.value.trim(), model: ui.model.value.trim() || DEFAULT_MODEL });
  ui.apiSettings.open = false;
  setStatus('Settings saved.');
});
ui.saveAcp.addEventListener('click', async () => {
  const { acpCommand } = await browser.storage.local.get('acpCommand');
  const command = ui.acpCommand.value.trim() || DEFAULT_ACP_COMMAND;
  // Another agent offers other settings; forget the cached ones until it reports its own.
  if (command !== (acpCommand ?? DEFAULT_ACP_COMMAND)) setAgentSettings([]);
  await browser.storage.local.set({ acpCommand: command });
  ui.acpSettings.open = false;
  setStatus('Settings saved.');
});

// ACP agent settings (model, effort, ...) are whatever the agent offers, rendered generically.
// Until it has run once there is nothing to show; the defaults apply.
function renderAgentSettings() {
  if (agentSettings.length === 0) {
    ui.agentSettings.replaceChildren(h('p', { className: 'muted', text: 'Model and effort choices appear after the first run. Until then: Sonnet, medium effort.' }));
    return;
  }
  ui.agentSettings.replaceChildren(
    ...agentSettings.map((setting) => {
      const change = (value: string | boolean) => {
        agentPrefs = { ...agentPrefs, [setting.id]: value };
        void browser.storage.local.set({ agentPrefs });
        postToHost({ type: 'set_setting', id: setting.id, value }); // a no-op when no agent is running
      };
      if (!setting.choices) {
        const box = h('input', { attrs: { type: 'checkbox' } });
        box.checked = setting.value === true;
        box.addEventListener('change', () => change(box.checked));
        return h('label', { className: 'setting check' }, box, h('span', { text: setting.name }));
      }
      const select = h('select');
      for (const c of setting.choices) {
        const option = h('option', { text: c.name });
        option.value = c.value;
        if (c.description) option.title = c.description;
        select.append(option);
      }
      select.value = String(setting.value);
      select.addEventListener('change', () => change(select.value));
      return h('label', { className: 'setting' }, h('span', { text: setting.name }), select);
    }),
  );
}

/** Takes the agent's reported settings as truth: shows them, caches them, and labels the run with them. */
function setAgentSettings(settings: AgentSetting[]) {
  agentSettings = settings;
  renderAgentSettings();
  const label = ['model', 'effort']
    .map((id) => settings.find((s) => s.id === id))
    .map((s) => s?.choices?.find((c) => c.value === s.value)?.name)
    .filter(Boolean)
    .join(' · ');
  void browser.storage.local.set({ agentSettings });
  void browser.storage.session.set({ acpLabel: label || 'ACP agent' });
}

async function attachAcpUsage() {
  const { lastRun } = await browser.storage.local.get('lastRun');
  const latest = lastRun as Run | undefined;
  // Only the run this session produced; the agent may have answered without analyzing.
  if (!acpUsage || latest?.mode !== 'acp' || latest.startedAt < acpStartedAt) return;
  run = { ...latest, usage: acpUsage };
  await persist();
}

function renderBridge(status: BridgeStatus | undefined) {
  const n = status?.connections ?? 0;
  ui.bridgeStatus.textContent = n ? `Connected to ${n} MCP server${n > 1 ? 's' : ''}` : 'No MCP server running';
  ui.bridgeStatus.classList.toggle('on', n > 0);
}
ui.rescan.addEventListener('click', () => void browser.runtime.sendMessage({ type: 'scan' }).catch(() => {}));

// ---------- rendering ----------

function renderUsage(u: Usage | undefined) {
  if (!u) return void (ui.usage.textContent = '');
  const parts = [
    `${u.inputTokens.toLocaleString()} in (+${u.cacheReadTokens.toLocaleString()} cached, ${u.cacheWriteTokens.toLocaleString()} cache-write)`,
    `${u.outputTokens.toLocaleString()} out`,
  ];
  if (u.requests !== undefined) parts.unshift(`${u.requests} request(s)`);
  if (u.cost) parts.push(u.cost.amount.toLocaleString(undefined, { style: 'currency', currency: u.cost.currency, maximumFractionDigits: 3 }));
  ui.usage.textContent = parts.join(' · ');
}

function appendLog(kind: string, line: string) {
  ui.log.append(h('li', { className: kind, text: line }));
}

function renderLog() {
  ui.log.replaceChildren();
  for (const { kind, line } of run?.log ?? []) appendLog(kind, line);
  for (const { kind, line } of agentLog) appendLog(kind, line);
}

const VERDICTS: { value: Verdict; emoji: string; label: string }[] = [
  { value: 'right', emoji: '👍', label: 'right' },
  { value: 'wrong', emoji: '👎', label: 'wrong' },
];

let renderGeneration = 0;

async function renderResults() {
  const generation = ++renderGeneration;
  ui.export.hidden = !run;
  const shown = run;
  if (!shown || shown.intentions.length === 0) return ui.results.replaceChildren();

  const live = new Map((await browser.tabs.query({})).map((t) => [t.id, t]));
  if (generation !== renderGeneration) return; // a newer render started while we awaited
  ui.results.replaceChildren();
  const snap = new Map(shown.tabs.map((t) => [t.id, t]));
  const tabCount = shown.intentions.reduce((n, i) => n + i.tab_ids.length, 0);
  const isOpen = (id: number) => live.has(id);

  // Tabs whose page is already in an open saved item (from this run or an earlier one) are registered.
  const savedByUrl = new Map(items.filter((i) => i.status === 'open').flatMap((i) => i.tabs.map((t) => [t.url, i] as const)));
  const savedIn = (id: number) => {
    const url = live.get(id)?.url;
    return url ? savedByUrl.get(url) : undefined;
  };
  // Safe to close: done or dead, saved, or registered. Pinned tabs are left alone in bulk.
  const safe = shown.intentions.flatMap((it, idx) =>
    it.tab_ids.filter(
      (id) => isOpen(id) && !live.get(id)?.pinned && (it.kind === 'done' || it.kind === 'dead' || shown.saved?.[idx] !== undefined || savedIn(id)),
    ),
  );

  const verdictSummary = h('p', { className: 'muted' });
  const renderVerdictSummary = () => {
    const judged = Object.values(shown.verdicts);
    const right = judged.filter((v) => v === 'right').length;
    verdictSummary.hidden = judged.length === 0;
    verdictSummary.textContent = `Your verdicts: ${right}/${judged.length} right`;
  };
  renderVerdictSummary();
  ui.results.append(
    verdictSummary,
    h('p', { text: `${tabCount} tabs → ${shown.intentions.length} intentions.` }),
    ...(safe.length
      ? [
          h('button', {
            className: 'primary',
            text: `Close ${plural(safe.length, 'tab')} that are safe to close`,
            attrs: { type: 'button', title: 'Done or dead tabs, and tabs whose intention is saved. Pinned tabs stay.' },
            onClick: () => void closeWithUndo(safe, (n) => `Closed ${plural(n, 'tab')}.`),
          }),
        ]
      : []),
  );

  for (const kind of KIND_ORDER) {
    const items = shown.intentions.map((it, idx) => ({ it, idx })).filter(({ it }) => it.kind === kind);
    if (items.length === 0) continue;
    ui.results.append(h('h2', { text: `${KIND_LABEL[kind]} (${items.length})` }));

    for (const { it, idx } of items) {
      const titleId = `intention-${idx}`;
      const tabsList = h('ul', { className: 'tabs' });
      for (const id of it.tab_ids) {
        const t = live.get(id);
        const title = t?.title ?? snap.get(id)?.title ?? `tab ${id}`;
        // A tab from another Chrome profile (MCP mode) isn't visible from here.
        const suffix = t ? '' : snap.get(id) ? ' (other profile or closed)' : ' (closed)';
        const registered = shown.saved?.[idx] === undefined ? savedIn(id) : undefined;
        tabsList.append(
          h(
            'li',
            {},
            h('button', { attrs: { type: 'button' }, onClick: () => focusTab(id) }, favicon(t?.favIconUrl), h('span', { text: title + suffix })),
            registered ? h('span', { className: 'registered', text: `saved in “${registered.task}”` }) : null,
          ),
        );
      }

      // Toggle in place rather than re-rendering, so keyboard focus stays on the button.
      const buttons = VERDICTS.map(({ value, emoji, label }) => {
        const button = h(
          'button',
          {
            attrs: {
              type: 'button',
              'aria-pressed': String(shown.verdicts[idx] === value),
              'aria-describedby': titleId,
              'data-verdict': value,
            },
            onClick: () => {
              shown.verdicts[idx] = value;
              for (const b of buttons) b.setAttribute('aria-pressed', String(b.dataset.verdict === value));
              renderVerdictSummary();
              void persist();
            },
          },
          h('span', { text: emoji, attrs: { 'aria-hidden': 'true' } }),
          h('span', { text: ` ${label}` }),
        );
        return button;
      });

      ui.results.append(
        h(
          'article',
          { className: 'card', attrs: { 'aria-labelledby': titleId } },
          h(
            'div',
            { className: 'title' },
            h('span', { text: it.title, attrs: { id: titleId } }),
            h('span', { className: `badge ${it.confidence}`, text: it.confidence }),
          ),
          h('div', { className: 'why', text: it.why }),
          it.next_step ? h('div', { className: 'next', text: it.next_step }) : null,
          h('div', { className: 'evidence', text: it.evidence }),
          tabsList,
          cardActions(shown, idx, titleId, it.tab_ids.filter(isOpen)),
          h('div', { className: 'verdict' }, ...buttons),
        ),
      );
    }
  }
}

async function focusTab(id: number) {
  try {
    const tab = await browser.tabs.update(id, { active: true });
    if (tab?.windowId !== undefined) await browser.windows.update(tab.windowId, { focused: true });
  } catch {
    setStatus('That tab is closed or in another Chrome profile.');
  }
}

// ---------- saving and closing ----------

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** What can be done with an intention: save it as an item (and close its tabs), or just close them. */
function cardActions(shown: Run, idx: number, titleId: string, openIds: number[]): HTMLElement | null {
  const it = shown.intentions[idx];
  if (!it) return null;
  const close = (text: string) =>
    openIds.length
      ? h('button', {
          text,
          attrs: { type: 'button', 'aria-describedby': titleId },
          onClick: () => void closeWithUndo(openIds, (n) => `Closed ${plural(n, 'tab')}.`),
        })
      : null;

  const savedId = shown.saved?.[idx];
  if (savedId !== undefined) {
    const item = items.find((i) => i.id === savedId);
    const label = item ? `✓ Saved as ${ITEM_LABEL[item.type]}: ${item.task}` : '✓ Saved';
    return h('div', { className: 'actions' }, h('span', { className: 'saved', text: label }), close('Close tabs'));
  }
  const type = ACTION_FOR_KIND[it.kind];
  if (!type) return it.kind === 'app' ? null : h('div', { className: 'actions' }, close(openIds.length > 1 ? `Close ${openIds.length} tabs` : 'Close tab'));

  // The model proposes the type and the task; the user can change both before saving.
  const select = h('select');
  for (const t of ITEM_TYPES) {
    const option = h('option', { text: t.label });
    option.value = t.value;
    select.append(option);
  }
  select.value = type;
  const task = h('input', { attrs: { type: 'text', 'aria-label': 'Task', autocomplete: 'off' } });
  task.value = it.next_step ?? it.title;
  const save = (andClose: boolean) => void saveIntention(shown, idx, select.value as ItemType, task.value, andClose);

  const form = h(
    'form',
    { className: 'save' },
    h('div', { className: 'row' }, h('label', {}, h('span', { text: 'Save as' }), select), task),
    h(
      'div',
      { className: 'actions' },
      h('button', { className: 'primary', text: openIds.length ? 'Save & close' : 'Save', attrs: { type: 'submit', 'aria-describedby': titleId } }),
      openIds.length ? h('button', { text: 'Save, keep open', attrs: { type: 'button', 'aria-describedby': titleId }, onClick: () => save(false) }) : null,
    ),
  );
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    save(openIds.length > 0);
  });
  return form;
}

async function saveIntention(shown: Run, idx: number, type: ItemType, task: string, andClose: boolean) {
  const it = shown.intentions[idx];
  if (!it) return;
  const snap = new Map(shown.tabs.map((t) => [t.id, t]));
  const found = await Promise.all(
    it.tab_ids.map(async (id): Promise<SavedTab | null> => {
      const t = await browser.tabs.get(id).catch(() => undefined);
      // The real URL from the live tab; the redacted snapshot is only a fallback for tabs not visible here.
      const url = t?.url ?? snap.get(id)?.url;
      if (!url) return null;
      return { url, title: t?.title ?? snap.get(id)?.title ?? url, ...(t?.favIconUrl ? { favIconUrl: t.favIconUrl } : {}) };
    }),
  );
  const item: Item = {
    id: crypto.randomUUID(),
    type,
    task: task.trim() || it.title,
    intention: it.title,
    why: it.why,
    tabs: found.filter((t) => t !== null),
    status: 'open',
    savedAt: new Date().toISOString(),
  };
  items = await updateItems((list) => [...list, item]);
  shown.saved = { ...shown.saved, [idx]: item.id };
  await persist();
  renderTracker();

  const unsave = async () => {
    items = await updateItems((list) => list.filter((i) => i.id !== item.id));
    if (shown.saved) delete shown.saved[idx];
    await persist();
    renderTracker();
  };
  if (andClose) await closeWithUndo(it.tab_ids, (n) => `Saved “${item.task}” and closed ${plural(n, 'tab')}.`, unsave);
  else {
    showToast(`Saved “${item.task}”.`, unsave);
    void renderResults();
  }
}

async function closeWithUndo(ids: number[], message: (closed: number) => string, alsoUndo?: () => Promise<void>) {
  let closed: Closed;
  try {
    closed = await closeTabs(ids);
  } catch (err) {
    showToast(`Could not close the tabs: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  const note = closed.missing ? ` ${plural(closed.missing, 'tab')} weren't open here (already closed, or in another Chrome profile).` : '';
  showToast(message(closed.count) + note, async () => {
    remapTabIds(await closed.undo());
    await alsoUndo?.();
  });
  void renderResults();
}

/** Restored tabs come back with new ids; point the run at them so its cards find the tabs again. */
function remapTabIds(newIds: Map<number, number>) {
  if (!run || newIds.size === 0) return;
  const map = (id: number) => newIds.get(id) ?? id;
  run.tabs = run.tabs.map((t) => ({ ...t, id: map(t.id) }));
  run.intentions = run.intentions.map((i) => ({ ...i, tab_ids: i.tab_ids.map(map) }));
  void persist();
}

/** One toast at a time; it stays until replaced or dismissed (no timer, so there's time to reach Undo). */
function showToast(message: string, undo?: () => Promise<void>) {
  const dismiss = () => ui.toast.replaceChildren();
  const undoButton = h('button', {
    text: 'Undo',
    attrs: { type: 'button' },
    onClick: () => {
      dismiss();
      void undo?.().then(() => renderResults());
    },
  });
  ui.toast.replaceChildren(
    h('span', { text: message }),
    ...(undo ? [undoButton] : []),
    h('button', { text: '✕', attrs: { type: 'button', 'aria-label': 'Dismiss' }, onClick: dismiss }),
  );
}

// ---------- views & the tracker ----------

function showView(view: 'analyze' | 'saved') {
  for (const b of ui.views) b.setAttribute('aria-pressed', String(b.dataset.view === view));
  ui.setup.hidden = ui.analyzeView.hidden = view !== 'analyze';
  ui.savedView.hidden = view !== 'saved';
}
for (const b of ui.views) b.addEventListener('click', () => showView(b.dataset.view === 'saved' ? 'saved' : 'analyze'));

function renderTracker() {
  const open = items.filter((i) => i.status === 'open').length;
  ui.savedCount.textContent = open ? `(${open})` : '';
  ui.exportMd.disabled = open === 0;
  renderSaved(ui.savedList, items, {
    reopen: (item) =>
      void reopenTabs(item.task, item.tabs).catch((err: unknown) => showToast(`Could not reopen: ${err instanceof Error ? err.message : String(err)}`)),
    setStatus: (item, status) =>
      void updateItems((list) =>
        list.map((i) => (i.id === item.id ? { ...i, status, finishedAt: status === 'open' ? undefined : new Date().toISOString() } : i)),
      ).then((next) => {
        items = next;
        renderTracker();
      }),
  });
}

ui.exportMd.addEventListener('click', () =>
  download(`tab-intentions-${new Date().toISOString().slice(0, 10)}.md`, 'text/markdown', toMarkdown(items)),
);

// ---------- questions (all modes) ----------

/** Shows the questions and resolves with the answers. Aborting `signal` takes them down and rejects. */
function askUser(questions: Question[], signal?: AbortSignal): Promise<Answer[]> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const titleOf = new Map(run?.tabs.map((t) => [t.id, t.title]) ?? []);
    const form = h('form');
    const readers: { id: string; read: () => string }[] = [];

    for (const [i, q] of questions.entries()) {
      const radios = q.options.map((o) => {
        const radio = h('input', { attrs: { type: 'radio', name: `q${i}` } });
        radio.value = o;
        return radio;
      });
      const own = h('input', { attrs: { type: 'text', autocomplete: 'off' } });
      // An option and a typed answer are exclusive: choosing one clears the other.
      own.addEventListener('input', () => own.value && radios.forEach((r) => (r.checked = false)));
      radios.forEach((r) => r.addEventListener('change', () => (own.value = '')));
      readers.push({ id: q.id, read: () => own.value.trim() || radios.find((r) => r.checked)?.value || '' });

      const about = q.tab_ids.map((id) => titleOf.get(id) ?? `tab ${id}`).join(' · ');
      form.append(
        h(
          'fieldset',
          { className: 'question' },
          h('legend', { text: q.question }),
          h('div', { className: 'about', text: about }),
          h('div', { className: 'opts' }, ...radios.map((r) => h('label', {}, r, h('span', { text: r.value })))),
          h('label', { className: 'own' }, h('span', { text: 'Or your own answer' }), own),
        ),
      );
    }
    form.append(h('button', { className: 'primary', text: 'Send answers', attrs: { type: 'submit' } }));

    const dismiss = () => {
      ui.questions.hidden = true;
      ui.questions.replaceChildren();
    };
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const answers = readers.map(({ id, read }) => ({ id, answer: read() || '(skipped - use your best guess)' }));
      dismiss();
      setStatus('Thanks - continuing…');
      resolve(answers);
    });
    signal?.addEventListener(
      'abort',
      () => {
        dismiss();
        reject(signal.reason);
      },
      { once: true },
    );

    ui.questions.replaceChildren(h('h2', { text: 'A few tabs are unclear' }), form);
    ui.questions.hidden = false;
    setStatus('Waiting for your answers.');
    ui.questions.scrollIntoView({ behavior: 'smooth' });
  });
}

// MCP and ACP modes: the background sends ask_user calls to every open panel (one per window).
// The first to answer wins and tells the others to drop the questions.
const pendingAsks = new Map<string, AbortController>();
browser.runtime.onMessage.addListener((msg: unknown, _sender, sendResponse) => {
  const m = msg as PanelMessage | undefined;
  if (m?.type === 'answered') return void pendingAsks.get(m.id)?.abort();
  if (m?.type !== 'ask') return;
  const controller = new AbortController();
  pendingAsks.set(m.id, controller);
  askUser(m.questions, controller.signal)
    .then(
      (answers) => {
        sendResponse(answers);
        void browser.runtime.sendMessage({ type: 'answered', id: m.id } satisfies PanelMessage).catch(() => {});
      },
      () => setStatus('Answered in another window - continuing…'),
    )
    .finally(() => pendingAsks.delete(m.id));
  return true; // respond asynchronously
});

// MCP and ACP modes: the background writes the run as tool calls arrive.
browser.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.bridge) renderBridge(changes.bridge.newValue as BridgeStatus | undefined);
  // Items change here or in another window's panel; registered tabs on the cards follow them.
  if (area === 'local' && changes.items) {
    items = (changes.items.newValue as Item[] | undefined) ?? [];
    renderTracker();
    void renderResults();
  }
  if (area === 'local' && changes.lastRun && !(busy && mode === 'api')) {
    if (JSON.stringify(changes.lastRun.newValue) === ownWrite) return;
    run = (changes.lastRun.newValue as Run | undefined) ?? null;
    renderLog();
    renderUsage(run?.usage ?? (busy ? acpUsage : undefined)); // an ACP run gets its usage at turn end
    void renderResults();
  }
});

// ---------- API-key mode ----------

async function analyzeWithApi() {
  const { apiKey, model } = await browser.storage.local.get(['apiKey', 'model']);
  if (typeof apiKey !== 'string' || !apiKey) {
    ui.apiSettings.open = true;
    setStatus('Add your Anthropic API key first.');
    return;
  }
  const tabs = await snapshotTabs();
  const modelId = typeof model === 'string' && model ? model : DEFAULT_MODEL;
  run = newRun('api', modelId, tabs);
  agentLog = [];
  startBusy(`Analyzing ${tabs.length} tabs…`);
  abort = new AbortController();
  const { signal } = abort;
  const started = performance.now();

  try {
    await runAgent({
      apiKey,
      model: modelId,
      tabs,
      signal,
      events: {
        log: (kind, line) => {
          run?.log.push({ kind, line });
          appendLog(kind, line);
          if (kind === 'tool') setStatus(`${line}…`);
        },
        ask: async (questions) => {
          const answers = await askUser(questions, signal); // Stop also takes down open questions
          run?.questions.push({ questions, answers });
          return answers;
        },
        result: (intentions) => {
          if (!run) return;
          run.intentions = intentions;
          void renderResults();
        },
        usage: (u) => {
          if (run) run.usage = u;
          renderUsage(u);
        },
      },
    });
    setStatus(`Done in ${Math.round((performance.now() - started) / 1000)}s.`);
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) setStatus('Invalid API key.');
    else if (err instanceof Anthropic.RateLimitError) setStatus('Rate limited - try again in a minute.');
    else if (err instanceof Anthropic.APIUserAbortError) setStatus('Stopped.');
    else if (err instanceof Anthropic.APIError) setStatus(`API error ${err.status}: ${err.message}`);
    else setStatus(`Failed: ${err instanceof Error ? err.message : String(err)}`);
    appendLog('error', String(err));
  } finally {
    if (run) run.finishedAt = new Date().toISOString();
    await persist();
    endBusy();
  }
}

// ---------- ACP mode: side panel -> native host -> ACP agent ----------

function postToHost(msg: PanelToHost) {
  acpPort?.postMessage(msg);
}

function connectHost(): Browser.runtime.Port {
  const port = browser.runtime.connectNative(NATIVE_HOST);
  port.onMessage.addListener((raw: unknown) => {
    const msg = raw as HostToPanel;
    if (msg.type === 'log') {
      agentLog.push({ kind: msg.kind, line: msg.line });
      appendLog(msg.kind, msg.line);
      if (msg.kind === 'tool' || msg.kind === 'info') setStatus(msg.line);
    } else if (msg.type === 'settings') {
      setAgentSettings(msg.settings);
    } else if (msg.type === 'usage') {
      acpUsage = msg.usage;
      renderUsage(acpUsage);
    } else if (msg.type === 'turn_end') {
      void attachAcpUsage();
      endBusy();
      ui.reply.hidden = false;
      setStatus(msg.stopReason === 'end_turn' ? 'The agent is done. Reply below if it asked you something.' : `Agent stopped: ${msg.stopReason}`);
    } else if (msg.type === 'fatal') {
      endBusy();
      setStatus('The agent failed - see the log.');
      appendLog('error', msg.message);
    }
  });
  port.onDisconnect.addListener(() => {
    const err = browser.runtime.lastError?.message;
    if (err && busy) {
      setStatus('Could not start the companion. Run `node companion/dist/cli.js install`, then reload the extension.');
      appendLog('error', err);
    }
    acpPort = null;
    endBusy();
    ui.reply.hidden = true;
  });
  return port;
}

async function analyzeWithAcp() {
  const { acpCommand } = await browser.storage.local.get('acpCommand');
  const command = typeof acpCommand === 'string' && acpCommand ? acpCommand : DEFAULT_ACP_COMMAND;
  agentLog = [];
  acpUsage = undefined;
  acpStartedAt = new Date().toISOString();
  ui.log.replaceChildren();
  ui.reply.hidden = true;
  startBusy('Starting the agent… (the first run may take a minute to download it)');
  acpPort ??= connectHost();
  postToHost({ type: 'start', command, prompt: KICKOFF, prefs: agentPrefs });
  // The agent starts its own MCP server; nudge the background to find it instead of waiting for its alarm.
  let nudges = 0;
  const nudge = setInterval(() => {
    void browser.runtime.sendMessage({ type: 'scan' }).catch(() => {});
    if (++nudges >= 20) clearInterval(nudge);
  }, 2_000);
}

ui.reply.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = ui.replyText.value.trim();
  if (!text || !acpPort) return;
  ui.replyText.value = '';
  ui.reply.hidden = true;
  agentLog.push({ kind: 'text', line: `You: ${text}` });
  appendLog('text', `You: ${text}`);
  startBusy('Sent - the agent is working…');
  postToHost({ type: 'prompt', text });
});

// ---------- controls ----------

function startBusy(status: string) {
  busy = true;
  ui.analyze.disabled = true;
  ui.stop.hidden = false;
  ui.results.replaceChildren();
  renderUsage(undefined);
  setStatus(status);
  if (mode === 'acp') void browser.storage.session.set({ acpRunning: true });
}

function endBusy() {
  busy = false;
  ui.analyze.disabled = false;
  ui.stop.hidden = true;
  ui.questions.hidden = true;
  void browser.storage.session.set({ acpRunning: false });
  void renderResults();
}

ui.analyze.addEventListener('click', async () => {
  try {
    await (mode === 'acp' ? analyzeWithAcp() : analyzeWithApi());
  } catch (err) {
    // e.g. connectNative missing because the loaded extension predates the nativeMessaging permission.
    const message = err instanceof Error ? err.message : String(err);
    appendLog('error', message);
    endBusy();
    setStatus(
      mode === 'acp' && !browser.runtime.connectNative
        ? 'This copy of the extension lacks the native messaging permission. Remove it in chrome://extensions and load .output/chrome-mv3 again.'
        : `Failed: ${message}`,
    );
  }
});
ui.stop.addEventListener('click', () => {
  if (mode === 'acp') {
    if (acpPort) postToHost({ type: 'cancel' });
    else endBusy(); // nothing is running - just reset the panel
    setStatus('Stopped.');
  } else abort?.abort();
});

ui.export.addEventListener('click', () => {
  if (!run) return;
  const data = agentLog.length ? { ...run, agentLog } : run;
  download(`tab-intentions-${run.mode}-${run.startedAt.slice(0, 16).replace(/[:T]/g, '-')}.json`, 'application/json', JSON.stringify(data, null, 2));
});

// ---------- boot ----------

void (async () => {
  await loadSettings();
  items = await loadItems();
  renderTracker();
  const { bridge } = await browser.storage.session.get('bridge');
  renderBridge(bridge as BridgeStatus | undefined);
  const { lastRun } = await browser.storage.local.get('lastRun');
  if (lastRun && typeof lastRun === 'object') {
    run = lastRun as Run;
    renderUsage(run.usage);
    renderLog();
    setStatus(`Last run (${run.mode}): ${new Date(run.startedAt).toLocaleString()}`);
    await renderResults();
  }
})();

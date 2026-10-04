import type { Browser } from 'wxt/browser';

/** What the model sees about a tab before it reads any page content. */
export interface TabSnapshot {
  id: number;
  window: number;
  index: number;
  title: string;
  url: string; // redacted
  group?: string;
  pinned?: true;
  active?: true;
  asleep?: true; // discarded by Chrome's memory saver
  audible?: true;
  openedFrom?: number; // openerTabId
  lastUsed?: string; // "3d ago"
  duplicateOf?: number;
  sensitive?: true; // never read this page
}

// Hosts whose content we never read (mail, chat, cloud consoles, banking-like).
const SENSITIVE_HOSTS = [
  'mail.google.com',
  'mail.proton.me',
  'outlook.live.com',
  'outlook.office.com',
  'web.whatsapp.com',
  'web.telegram.org',
  'discord.com',
  'app.slack.com',
  'console.aws.amazon.com',
  'signin.aws.amazon.com',
  'accounts.google.com',
  'dashboard.workos.com',
  'signin.workos.com',
];
const SENSITIVE_PATH = /api[-_]?keys|\/billing|\/password|\/oauth|\/callback/i;

// Query params that tend to carry secrets or tracking noise.
const SECRET_PARAM = /^(code|token|access_token|refresh_token|id_token|key|api_key|apikey|secret|sk|sig|signature|auth|session|sessionid|password|state|_gl|mcid)$/i;

export function redactUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw.slice(0, 200);
  }
  for (const [name, value] of [...url.searchParams]) {
    if (SECRET_PARAM.test(name) || value.length > 64) url.searchParams.set(name, 'REDACTED');
  }
  if (url.hash.length > 64) url.hash = '#…';
  return url.toString().slice(0, 300);
}

export function isSensitive(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return true;
    return SENSITIVE_HOSTS.includes(url.hostname) || SENSITIVE_PATH.test(url.pathname);
  } catch {
    return true;
  }
}

function ago(ms: number | undefined): string | undefined {
  if (!ms) return undefined;
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

const dedupeKey = (raw: string): string => raw.split('#')[0] ?? raw;

export async function snapshotTabs(): Promise<TabSnapshot[]> {
  const [tabs, groups] = await Promise.all([browser.tabs.query({}), browser.tabGroups.query({})]);
  const groupTitle = new Map(groups.map((g) => [g.id, g.title || `(${g.color} group)`]));
  const windowIndex = new Map<number, number>();
  const firstByUrl = new Map<string, number>();

  return tabs
    .filter((t): t is Browser.tabs.Tab & { id: number } => t.id !== undefined)
    .map((t) => {
      const url = t.url ?? t.pendingUrl ?? '';
      if (!windowIndex.has(t.windowId)) windowIndex.set(t.windowId, windowIndex.size);
      const key = dedupeKey(url);
      const duplicateOf = firstByUrl.get(key);
      if (duplicateOf === undefined) firstByUrl.set(key, t.id);

      const snap: TabSnapshot = {
        id: t.id,
        window: windowIndex.get(t.windowId) ?? 0,
        index: t.index,
        title: (t.title ?? '').slice(0, 160),
        url: redactUrl(url),
      };
      const group = t.groupId > -1 ? groupTitle.get(t.groupId) : undefined;
      if (group) snap.group = group;
      if (t.pinned) snap.pinned = true;
      if (t.active) snap.active = true;
      if (t.discarded) snap.asleep = true;
      if (t.audible) snap.audible = true;
      if (t.openerTabId !== undefined) snap.openedFrom = t.openerTabId;
      const lastUsed = ago(t.lastAccessed);
      if (lastUsed) snap.lastUsed = lastUsed;
      if (duplicateOf !== undefined) snap.duplicateOf = duplicateOf;
      if (isSensitive(url)) snap.sensitive = true;
      return snap;
    });
}

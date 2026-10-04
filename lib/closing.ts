import type { Browser } from 'wxt/browser';
import type { SavedTab } from './tracker';

type Tab = Browser.tabs.Tab & { id: number };

export interface Closed {
  count: number;
  /** Tabs that couldn't be closed from here: already closed, or open in another Chrome profile. */
  missing: number;
  /** Brings the tabs back. Restored tabs get new ids: returns old id -> new id. */
  undo: () => Promise<Map<number, number>>;
}

/**
 * Closes tabs. Undo prefers Chrome's recently-closed list, which brings tabs back with their
 * history and scroll position; anything it no longer holds (it keeps 25 entries) is reopened by URL.
 */
export async function closeTabs(ids: number[]): Promise<Closed> {
  const found = await Promise.all(ids.map((id) => browser.tabs.get(id).catch(() => undefined)));
  const tabs = found.filter((t): t is Tab => t?.id !== undefined);

  // Closing every tab in this panel's window would close the window, and the panel (and its undo) with it.
  const here = await browser.windows.getCurrent({ populate: true });
  const closing = new Set(tabs.map((t) => t.id));
  if (here.tabs?.length && here.tabs.every((t) => t.id !== undefined && closing.has(t.id))) {
    await browser.tabs.create({ windowId: here.id, active: true });
  }

  await browser.tabs.remove(tabs.map((t) => t.id));
  return { count: tabs.length, missing: ids.length - tabs.length, undo: () => restore(tabs) };
}

async function restore(tabs: Tab[]): Promise<Map<number, number>> {
  const newIds = new Map<number, number>();
  const pending = new Map<string, Tab[]>();
  for (const t of tabs) pending.set(t.url ?? '', [...(pending.get(t.url ?? '') ?? []), t]);
  const has = (url: string | undefined) => (pending.get(url ?? '')?.length ?? 0) > 0;
  const take = (url: string | undefined) => pending.get(url ?? '')?.shift();

  for (const { tab, window } of await browser.sessions.getRecentlyClosed()) {
    if (tab?.sessionId && has(tab.url)) {
      const old = take(tab.url);
      const restored = await browser.sessions.restore(tab.sessionId).catch(() => undefined);
      if (old && restored?.tab?.id !== undefined) newIds.set(old.id, restored.tab.id);
    } else if (window?.sessionId && window.tabs?.length && window.tabs.every((t) => has(t.url))) {
      // A whole window shows up here when we closed all of its tabs; only restore it if they are all ours.
      const olds = window.tabs.map((t) => take(t.url));
      const restored = await browser.sessions.restore(window.sessionId).catch(() => undefined);
      restored?.window?.tabs?.forEach((t, i) => {
        const old = olds[i];
        if (old && t.id !== undefined) newIds.set(old.id, t.id);
      });
    }
  }

  // Whatever the recently-closed list no longer had: reopen by URL where it was.
  const windows = new Set((await browser.windows.getAll()).map((w) => w.id));
  for (const t of [...pending.values()].flat()) {
    if (!t.url) continue;
    const created = await browser.tabs.create({ url: t.url, active: false, ...(windows.has(t.windowId) ? { windowId: t.windowId, index: t.index } : {}) });
    if (created.id !== undefined) newIds.set(t.id, created.id);
  }
  return newIds;
}

/** Reopens a saved item's tabs in this window, as a tab group named after it. */
export async function reopenTabs(title: string, tabs: SavedTab[]) {
  const created = await Promise.all(tabs.map((t, i) => browser.tabs.create({ url: t.url, active: i === 0 })));
  const tabIds = created.flatMap((t) => (t.id === undefined ? [] : [t.id]));
  if (tabIds.length === 0) return;
  const groupId = await browser.tabs.group({ tabIds: tabIds as [number, ...number[]] });
  await browser.tabGroups.update(groupId, { title: title.slice(0, 40) });
}

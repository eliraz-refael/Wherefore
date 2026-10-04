import type { Intention } from './protocol';

/**
 * The tracker: intentions the user saved as actionable items, so their tabs can be closed.
 * Stored as `items` in storage.local, per Chrome profile.
 */

export type ItemType = 'todo' | 'follow_up' | 'read' | 'keep';
export type ItemStatus = 'open' | 'done' | 'dropped';

export const ITEM_TYPES: { value: ItemType; label: string }[] = [
  { value: 'todo', label: 'To do' },
  { value: 'follow_up', label: 'Follow up' },
  { value: 'read', label: 'Read' },
  { value: 'keep', label: 'Keep' },
];
export const ITEM_LABEL = Object.fromEntries(ITEM_TYPES.map((t) => [t.value, t.label])) as Record<ItemType, string>;

/** What an intention becomes when saved. Null: nothing to save - done and dead tabs are just closed, apps stay open. */
export const ACTION_FOR_KIND: Record<Intention['kind'], ItemType | null> = {
  work: 'todo',
  decide: 'todo',
  track: 'follow_up',
  read: 'read',
  reference: 'keep',
  done: null,
  dead: null,
  app: null,
};

/** A tab as it was when saved. The URL is the real one (the model only ever saw a redacted copy). */
export interface SavedTab {
  url: string;
  title: string;
  favIconUrl?: string;
}

export interface Item {
  id: string;
  type: ItemType;
  task: string;
  intention: string; // the intention's title
  why: string;
  tabs: SavedTab[];
  status: ItemStatus;
  savedAt: string;
  finishedAt?: string;
}

export async function loadItems(): Promise<Item[]> {
  const { items } = await browser.storage.local.get('items');
  return Array.isArray(items) ? (items as Item[]) : [];
}

export async function updateItems(change: (items: Item[]) => Item[]): Promise<Item[]> {
  const items = change(await loadItems());
  await browser.storage.local.set({ items });
  return items;
}

/** Links are only made for web pages; anything else (chrome://, file:, ...) is shown as text. */
export const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

const mdText = (s: string) => s.replace(/([\\[\]*_`<>])/g, '\\$1');
const mdUrl = (s: string) => s.replace(/\(/g, '%28').replace(/\)/g, '%29').replace(/\s/g, '%20');

/** Open items as a Markdown checklist, grouped by type. */
export function toMarkdown(items: Item[]): string {
  const lines = ['# Tab Intentions', ''];
  for (const { value, label } of ITEM_TYPES) {
    const open = items.filter((i) => i.status === 'open' && i.type === value);
    if (open.length === 0) continue;
    lines.push(`## ${label}`, '');
    for (const item of open) {
      lines.push(`${value === 'keep' ? '-' : '- [ ]'} ${mdText(item.task)}`);
      if (item.why) lines.push(`  ${mdText(item.why)}`);
      for (const t of item.tabs) lines.push(isWebUrl(t.url) ? `  - [${mdText(t.title)}](${mdUrl(t.url)})` : `  - ${mdText(t.title)}: ${t.url}`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

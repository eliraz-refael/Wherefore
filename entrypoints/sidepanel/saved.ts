import { ITEM_LABEL, ITEM_TYPES, isWebUrl, type Item, type ItemStatus } from '@/lib/tracker';
import { favicon, h } from './dom';

export interface SavedActions {
  reopen(item: Item): void;
  setStatus(item: Item, status: ItemStatus): void;
}

/** The Saved view: open items grouped by type, newest first, and the finished ones folded away. */
export function renderSaved(container: HTMLElement, items: Item[], actions: SavedActions) {
  const newestFirst = [...items].sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  const open = newestFirst.filter((i) => i.status === 'open');
  const finished = newestFirst.filter((i) => i.status !== 'open');

  const parts: Node[] = [];
  if (open.length === 0) {
    parts.push(h('p', { className: 'muted', text: 'Nothing saved yet. Analyze your tabs, then save the intentions you want to keep.' }));
  }
  for (const { value, label } of ITEM_TYPES) {
    const group = open.filter((i) => i.type === value);
    if (group.length) parts.push(h('h2', { text: `${label} (${group.length})` }), ...group.map((item) => itemCard(item, actions)));
  }
  if (finished.length) {
    parts.push(
      h(
        'details',
        { className: 'finished' },
        h('summary', { text: `Finished (${finished.length})` }),
        h('ul', {}, ...finished.map((item) => finishedRow(item, actions))),
      ),
    );
  }
  container.replaceChildren(...parts);
}

function itemCard(item: Item, actions: SavedActions): HTMLElement {
  const titleId = `item-${item.id}`;
  const tabs = h(
    'ul',
    { className: 'tabs' },
    ...item.tabs.map((t) => {
      const name = h('span', { text: t.title });
      const link = isWebUrl(t.url) ? h('a', { attrs: { href: t.url, target: '_blank', rel: 'noreferrer' } }, favicon(t.favIconUrl), name) : null;
      return h('li', {}, link ?? h('span', { className: 'tab' }, favicon(t.favIconUrl), name));
    }),
  );
  const button = (text: string, onClick: () => void) => h('button', { text, attrs: { type: 'button', 'aria-describedby': titleId }, onClick });

  return h(
    'article',
    { className: 'card', attrs: { 'aria-labelledby': titleId } },
    h('div', { className: 'title' }, h('span', { text: item.task, attrs: { id: titleId } }), h('span', { className: 'badge', text: ITEM_LABEL[item.type] })),
    h('div', { className: 'why', text: item.why }),
    tabs,
    h(
      'div',
      { className: 'actions' },
      button(item.tabs.length > 1 ? `Reopen ${item.tabs.length} tabs` : 'Reopen tab', () => actions.reopen(item)),
      button('Done', () => actions.setStatus(item, 'done')),
      button('Drop', () => actions.setStatus(item, 'dropped')),
    ),
  );
}

function finishedRow(item: Item, actions: SavedActions): HTMLElement {
  return h(
    'li',
    {},
    h('span', { text: `${item.task} · ${item.status === 'done' ? 'done' : 'dropped'}` }),
    h('button', { text: 'Move back', attrs: { type: 'button', 'aria-label': `Move back: ${item.task}` }, onClick: () => actions.setStatus(item, 'open') }),
  );
}

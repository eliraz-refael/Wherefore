import { isSensitive, redactUrl } from './tabs';

export type PageRead =
  | {
      id: number;
      title: string;
      url: string;
      headings: string[];
      description: string;
      text: string;
      scrollPct: number | null;
      media: { currentSec: number; durationSec: number } | null;
      selection: string;
    }
  | { id: number; error: string };

/** Runs inside the page. Must be self-contained: it is serialized and injected. */
function extractPage(maxChars: number) {
  const meta = (sel: string) => document.querySelector<HTMLMetaElement>(sel)?.content ?? '';
  const root = document.querySelector<HTMLElement>('main, [role=main], article') ?? document.body;
  const scrollable = document.documentElement.scrollHeight - window.innerHeight;
  const video = document.querySelector('video');
  return {
    title: document.title,
    url: location.href,
    headings: [...document.querySelectorAll<HTMLElement>('h1, h2')]
      .slice(0, 8)
      .map((h) => h.innerText.trim())
      .filter(Boolean),
    description: meta('meta[name=description]') || meta('meta[property="og:description"]'),
    text: (root?.innerText ?? '').replace(/\s+/g, ' ').slice(0, maxChars),
    scrollPct: scrollable > 200 ? Math.round((window.scrollY / scrollable) * 100) : null,
    media:
      video && video.duration > 0
        ? { currentSec: Math.round(video.currentTime), durationSec: Math.round(video.duration) }
        : null,
    selection: (window.getSelection()?.toString() ?? '').slice(0, 500),
  };
}

export async function readPage(id: number, maxChars: number): Promise<PageRead> {
  let tab;
  try {
    tab = await browser.tabs.get(id);
  } catch {
    return { id, error: 'tab no longer exists' };
  }
  if (isSensitive(tab.url ?? '')) return { id, error: 'sensitive page - not read by policy' };
  if (tab.discarded) return { id, error: 'asleep (discarded by memory saver) - use wake_and_read_pages' };
  try {
    const [res] = await browser.scripting.executeScript({
      target: { tabId: id },
      func: extractPage,
      args: [maxChars],
    });
    if (!res?.result) return { id, error: 'no result (page may still be loading)' };
    return { id, ...res.result, url: redactUrl(res.result.url) };
  } catch (err) {
    return { id, error: `cannot read: ${err instanceof Error ? err.message : String(err)}` };
  }
}

function waitForLoad(id: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      browser.tabs.onUpdated.removeListener(listener);
      resolve();
    };
    const listener = (tabId: number, info: { status?: string }) => {
      if (tabId === id && info.status === 'complete') done();
    };
    const timer = setTimeout(done, timeoutMs);
    browser.tabs.onUpdated.addListener(listener);
  });
}

/** Reloads a sleeping tab in the background (without focusing it), then reads it. */
export async function wakeAndRead(id: number, maxChars: number): Promise<PageRead> {
  let tab;
  try {
    tab = await browser.tabs.get(id);
  } catch {
    return { id, error: 'tab no longer exists' };
  }
  if (isSensitive(tab.url ?? '')) return { id, error: 'sensitive page - not woken by policy' };
  const before = tab.url ?? '';
  const loaded = waitForLoad(id, 15_000);
  await browser.tabs.reload(id);
  await loaded;
  const read = await readPage(id, maxChars);
  if ('error' in read || read.url === redactUrl(before)) return read;
  // Reloading can redirect (expired session -> login page). Tell the model.
  return { ...read, description: `[redirected on reload from ${redactUrl(before)}] ${read.description}` };
}

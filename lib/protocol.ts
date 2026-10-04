/**
 * Shared by the extension and the companion: the prompt, tool schemas, result types,
 * and the wire protocol between the companion and the extension.
 * No browser or Node APIs here.
 */
import { z } from 'zod';

// ---------- intentions ----------

export const IntentionKind = z.enum([
  'work', // an active task to continue
  'track', // waiting on something external to change
  'decide', // comparing options / considering a purchase or tool
  'read', // something to read, watch or learn
  'reference', // keep for lookup, no action implied
  'app', // an everyday tool or inbox - keep open, not an intention
  'done', // the underlying thing is finished - safe to close
  'dead', // duplicate, expired login, error or callback page - safe to close
]);

export const Intention = z.object({
  title: z.string().describe('Action-oriented, specific. "Decide which cat litter to buy", not "Shopping".'),
  why: z.string().describe("The user's reason for keeping these tabs open, in one sentence."),
  next_step: z
    .string()
    .optional()
    .describe(
      'The one-line task the person would write on their own to-do list, e.g. "Reply to Dana about the API limits". Give one for work, track, decide and read; omit it otherwise.',
    ),
  kind: IntentionKind,
  tab_ids: z.array(z.number().int()).min(1),
  confidence: z.enum(['high', 'medium', 'low']),
  evidence: z.string().describe('Short: which signals led to this (titles, page content, PR state, user answer).'),
});
export type Intention = z.infer<typeof Intention>;

export const Question = z.object({
  id: z.string(),
  tab_ids: z.array(z.number().int()).min(1),
  question: z.string(),
  options: z.array(z.string()).max(4).describe('2-4 likely answers the user can click.'),
});
export type Question = z.infer<typeof Question>;
export interface Answer {
  id: string;
  answer: string;
}

/** Every known tab must be in exactly one intention. Returns an error message, or null when valid. */
export function coverageError(known: Iterable<number>, intentions: Intention[]): string | null {
  const knownSet = new Set(known);
  const seen = new Map<number, number>();
  for (const i of intentions) for (const id of i.tab_ids) seen.set(id, (seen.get(id) ?? 0) + 1);
  const missing = [...knownSet].filter((id) => !seen.has(id));
  const repeated = [...seen].filter(([, n]) => n > 1).map(([id]) => id);
  const unknown = [...seen.keys()].filter((id) => !knownSet.has(id));
  if (!missing.length && !repeated.length && !unknown.length) return null;
  return `Fix and resubmit all intentions. Missing tab ids: [${missing.join(', ')}]. In more than one intention: [${repeated.join(', ')}]. Unknown ids: [${unknown.join(', ')}].`;
}

// ---------- prompt ----------

export const SYSTEM_PROMPT = `You help someone close browser tabs with confidence. People keep tabs open because a tab stands in for an intention: something to finish, follow, decide, read, or come back to. Your job is to recover those intentions from their open tabs so the tabs can be closed without losing the reason they were open.

How to work:
- Group tabs into intentions. One intention usually spans several tabs, often across windows. A tab belongs to exactly one intention.
- Use every signal: titles, URLs, tab groups, which tab opened which (openedFrom), last used time, duplicates, and the shape of a URL (a search results page plus several product pages is one decision).
- Infer what the person meant, but do not manufacture commitments. A GitHub issue might be followed, not owned. A product page is a consideration, not a purchase.
- Check whether the thing behind a tab is already finished. A merged PR, a closed issue or a completed order means "done", which is the easiest close.
- Login pages, OAuth callbacks, error pages, VPN redirects and exact duplicates are "dead". Inboxes and everyday tools (mail, chat, calendars, dashboards used daily) are "app".
- When title and URL are not enough, read the page (read_pages). For GitHub PRs and issues, read the page to learn state and author. Sleeping tabs need wake_and_read_pages; waking reloads the tab, so use it only when reading would change your answer.
- If an intention is still unclear after reading, ask the user. Batch your questions into one ask_user call, ask only what matters, and offer likely answers as options.
- Finish by calling submit_intentions once with every tab covered.

Write titles the way the person would say them to themselves. Prefer few, meaningful intentions over many thin ones.`;

/** The kickoff message for agents that fetch tabs themselves (MCP and ACP modes). */
export const KICKOFF = `${SYSTEM_PROMPT}

Start by calling list_tabs, then work through my tabs and finish with submit_intentions.`;

// ---------- tools ----------

const MaxChars = z.number().int().min(300).max(6000).optional();

export const TOOLS = {
  list_tabs: {
    description: 'List every open tab: id, window, title, redacted URL, group, asleep, last used, opener, duplicates. Call this first.',
    input: z.object({}),
  },
  read_pages: {
    description:
      'Read the visible text, headings, scroll position, media progress and selected text of open tabs. Returns an error entry for sleeping, sensitive or unreadable tabs.',
    input: z.object({ tab_ids: z.array(z.number().int()).min(1).max(20), max_chars: MaxChars }),
  },
  wake_and_read_pages: {
    description:
      'Reload sleeping tabs in the background, then read them. Reloading can lose page state or redirect to a login page, so only wake tabs whose content would change your answer.',
    input: z.object({ tab_ids: z.array(z.number().int()).min(1).max(10), max_chars: MaxChars }),
  },
  ask_user: {
    description:
      "Ask the user about tabs whose intention is still unclear after reading them. Batch all questions into one call. The questions appear in the extension's side panel.",
    input: z.object({ questions: z.array(Question).min(1).max(10) }),
  },
  submit_intentions: {
    description: 'Submit the final intentions. Every tab id from list_tabs must appear in exactly one intention.',
    input: z.object({ intentions: z.array(Intention).min(1) }),
  },
} as const;
export type ToolName = keyof typeof TOOLS;
export type ToolInput<N extends ToolName> = z.infer<(typeof TOOLS)[N]['input']>;
export const TOOL_NAMES = Object.keys(TOOLS) as ToolName[];

// ---------- companion <-> extension bridge (WebSocket on localhost) ----------

/** The MCP server listens on the first free port in this range; the extension connects to all of them. */
export const BRIDGE_PORTS = Array.from({ length: 8 }, (_, i) => 17373 + i);

export type BridgeCall =
  | { type: 'call'; id: number; tool: 'list_tabs'; args: Record<string, never> }
  | { type: 'call'; id: number; tool: 'read_pages' | 'wake_and_read_pages'; args: ToolInput<'read_pages'> }
  | { type: 'call'; id: number; tool: 'ask_user'; args: ToolInput<'ask_user'> }
  | { type: 'call'; id: number; tool: 'submit_intentions'; args: { intentions: Intention[]; tabs: unknown[] } };

export type ServerToExtension = BridgeCall | { type: 'ping' };
export type ExtensionToServer =
  | { type: 'hello'; profile: string }
  | { type: 'result'; id: number; ok: true; value: unknown }
  | { type: 'result'; id: number; ok: false; error: string }
  | { type: 'pong' };

// ---------- side panel <-> native host (ACP mode) ----------

export const NATIVE_HOST = 'com.tab_intentions.host';
export const DEFAULT_ACP_COMMAND = 'npx -y @agentclientprotocol/claude-agent-acp';

/** Token usage of a run, whichever mode produced it. */
export interface Usage {
  requests?: number; // API mode; an ACP agent doesn't report its requests
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost?: { amount: number; currency: string }; // as reported by an ACP agent
}

/** An agent setting (an ACP session config option such as model or effort), flattened for the panel. */
export interface AgentSetting {
  id: string;
  name: string;
  description?: string;
  value: string | boolean;
  /** The choices of a select; absent for an on/off setting. */
  choices?: { value: string; name: string; description?: string }[];
}
export type AgentSettingValues = Record<string, string | boolean>;

/** Applied when the user hasn't picked, and only if the agent offers these values. */
export const DEFAULT_AGENT_PREFS: AgentSettingValues = { model: 'sonnet', effort: 'medium' };

export type PanelToHost =
  | { type: 'start'; command: string; prompt: string; prefs: AgentSettingValues }
  | { type: 'prompt'; text: string }
  | { type: 'set_setting'; id: string; value: string | boolean }
  | { type: 'cancel' };
export type HostToPanel =
  | { type: 'log'; kind: 'text' | 'thinking' | 'tool' | 'info' | 'error'; line: string }
  | { type: 'settings'; settings: AgentSetting[] }
  | { type: 'usage'; usage: Usage }
  | { type: 'turn_end'; stopReason: string }
  | { type: 'fatal'; message: string };

/** Pinned by the public `key` in wxt.config.ts. */
export const EXTENSION_ID = 'anpbbaiepneaddgoldgmapilgiflochg';

import type { Answer, Intention, Question, Usage } from './protocol';

export type { Usage };
import type { TabSnapshot } from './tabs';

export type Mode = 'api' | 'mcp' | 'acp';
export type Verdict = 'right' | 'wrong';

/** One analysis, whichever mode produced it. Stored as `lastRun` in storage.local. */
export interface Run {
  mode: Mode;
  startedAt: string;
  finishedAt?: string;
  model: string;
  tabs: TabSnapshot[];
  intentions: Intention[];
  verdicts: Record<number, Verdict>; // by intention index
  saved?: Record<number, string>; // intention index -> tracker item id
  questions: { questions: Question[]; answers: Answer[] }[];
  log: { kind: string; line: string }[];
  usage?: Usage;
}

export const newRun = (mode: Mode, model: string, tabs: TabSnapshot[]): Run => ({
  mode,
  model,
  tabs,
  startedAt: new Date().toISOString(),
  intentions: [],
  verdicts: {},
  questions: [],
  log: [],
});

/**
 * Messages to side panels. The background sends `ask` to every open panel (one per window);
 * the panel that answers first broadcasts `answered` so the others drop the questions.
 */
export type PanelMessage = { type: 'ask'; id: string; questions: Question[] } | { type: 'answered'; id: string };

/** Bridge status the background publishes in storage.session. */
export interface BridgeStatus {
  connections: number;
}

import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { ToolError } from '@anthropic-ai/sdk/lib/tools/ToolError';
import { readPage, wakeAndRead } from './page';
import { coverageError, SYSTEM_PROMPT, TOOLS, type Answer, type Intention, type Question } from './protocol';
import type { Usage } from './run';
import type { TabSnapshot } from './tabs';

export const DEFAULT_MODEL = 'claude-opus-5-5';

export interface AgentEvents {
  log(kind: 'tool' | 'thinking' | 'text' | 'info' | 'error', line: string): void;
  ask(questions: Question[]): Promise<Answer[]>;
  result(intentions: Intention[]): void;
  usage(usage: Usage): void;
}

/** API-key mode: the side panel runs the agent loop against the Claude API directly. */
export async function runAgent(opts: {
  apiKey: string;
  model: string;
  tabs: TabSnapshot[];
  events: AgentEvents;
  signal: AbortSignal;
}): Promise<void> {
  const { apiKey, model, tabs, events, signal } = opts;
  const client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  let submitted = false;

  const readPages = betaZodTool({
    name: 'read_pages',
    description: TOOLS.read_pages.description,
    inputSchema: TOOLS.read_pages.input,
    run: async ({ tab_ids, max_chars }) => {
      events.log('tool', `Reading ${tab_ids.length} page(s)`);
      return JSON.stringify(await Promise.all(tab_ids.map((id) => readPage(id, max_chars ?? 1500))));
    },
  });

  const wakeAndReadPages = betaZodTool({
    name: 'wake_and_read_pages',
    description: TOOLS.wake_and_read_pages.description,
    inputSchema: TOOLS.wake_and_read_pages.input,
    run: async ({ tab_ids, max_chars }) => {
      events.log('tool', `Waking ${tab_ids.length} sleeping tab(s)`);
      return JSON.stringify(await Promise.all(tab_ids.map((id) => wakeAndRead(id, max_chars ?? 1500))));
    },
  });

  const askUser = betaZodTool({
    name: 'ask_user',
    description: TOOLS.ask_user.description,
    inputSchema: TOOLS.ask_user.input,
    run: async ({ questions }) => {
      events.log('tool', `Asking you ${questions.length} question(s)`);
      return JSON.stringify(await events.ask(questions));
    },
  });

  const submitIntentions = betaZodTool({
    name: 'submit_intentions',
    description: TOOLS.submit_intentions.description,
    inputSchema: TOOLS.submit_intentions.input,
    run: async ({ intentions }) => {
      const error = coverageError(
        tabs.map((t) => t.id),
        intentions,
      );
      if (error) {
        events.log('info', 'Submission rejected: not every tab covered exactly once');
        throw new ToolError(error);
      }
      submitted = true;
      events.result(intentions);
      return 'Saved.';
    },
  });

  const usage = { requests: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } satisfies Usage;
  const tabLines = tabs.map((t) => JSON.stringify(t)).join('\n');

  const runner = client.beta.messages.toolRunner(
    {
      model,
      max_tokens: 32000,
      max_iterations: 15,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { effort: 'medium' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      cache_control: { type: 'ephemeral' },
      system: SYSTEM_PROMPT,
      tools: [readPages, wakeAndReadPages, askUser, submitIntentions],
      messages: [
        {
          role: 'user',
          content: `Today is ${new Date().toDateString()}. These are my ${tabs.length} open tabs, one JSON object per line:\n\n${tabLines}`,
        },
      ],
    },
    { signal },
  );

  for await (const message of runner) {
    usage.requests += 1;
    usage.inputTokens += message.usage.input_tokens;
    usage.outputTokens += message.usage.output_tokens;
    usage.cacheReadTokens += message.usage.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += message.usage.cache_creation_input_tokens ?? 0;
    events.usage({ ...usage });

    for (const block of message.content) {
      if (block.type === 'thinking' && block.thinking) events.log('thinking', block.thinking);
      if (block.type === 'text' && block.text) events.log('text', block.text);
    }
    if (message.stop_reason === 'refusal') events.log('error', 'The model declined this request.');
    if (message.stop_reason === 'max_tokens') events.log('error', 'Response hit max_tokens.');
  }

  if (!submitted) events.log('error', 'The agent finished without submitting intentions.');
}

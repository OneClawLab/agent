import { mkdir, writeFile } from '../repo-utils/fs.js';
import { path } from '../repo-utils/path.js';
import { invokeLlm } from './llm.js';
import {
  estimateTokens,
  estimateMessageTokens,
  loadSessionMessages,
  writeSessionMessages,
  splitMessages,
  buildTranscript,
  compactStatePath,
  loadCompactState,
  saveCompactState,
  type SessionMessage,
} from './session.js';
import type { Logger } from '../repo-utils/logger.js';

const RECENT_RAW_TOKEN_BUDGET = 4096;
const COMPACT_INTERVAL_TURNS = 10;
const CONTEXT_USAGE_THRESHOLD = 0.8;
const SAFETY_MARGIN = 512;

/** Marker prefix used to identify synthetic summary messages injected by compaction. */
const SUMMARY_MARKER = '[Memory Summary]\n';

/** Returns true if a message is a synthetic summary injected by a previous compaction. */
function isSyntheticSummary(msg: SessionMessage): boolean {
  return msg.role === 'assistant' && typeof msg.content === 'string' && msg.content.startsWith(SUMMARY_MARKER);
}

export interface CompactOptions {
  agentDir: string;
  threadId: string;
  sessionFile: string;
  systemPrompt: string;
  userMessage: string;
  provider: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
  logger: Logger;
}

/**
 * Check whether compaction should be triggered.
 *
 * Triggers if EITHER:
 *   1. Total estimated input tokens > 80% of inputBudget
 *   2. turnCount - lastCompactedAt >= COMPACT_INTERVAL_TURNS
 */
export function shouldCompact(
  totalTokens: number,
  inputBudget: number,
  state: { turnCount: number; lastCompactedAt: number },
): boolean {
  const overContext = totalTokens > inputBudget * CONTEXT_USAGE_THRESHOLD;
  const overInterval = (state.turnCount - state.lastCompactedAt) >= COMPACT_INTERVAL_TURNS;
  return overContext || overInterval;
}

/**
 * Estimate total input tokens for an LLM call:
 * system prompt + all session messages + current user message.
 */
export function estimateTotalTokens(
  systemPrompt: string,
  sessionMessages: SessionMessage[],
  userMessage: string,
): number {
  const systemTokens = estimateTokens(systemPrompt);
  const sessionTokens = sessionMessages.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
  const userTokens = estimateTokens(userMessage) + 4;
  return systemTokens + sessionTokens + userTokens;
}

/**
 * Run session compaction for a thread.
 *
 * Flow:
 *   1. Load session + compact state
 *   2. Check trigger conditions
 *   3. If triggered: split → summarize → rewrite session → update state
 *   4. If summarization fails: fall back to truncation-only
 */
export async function compactSession(opts: CompactOptions): Promise<void> {
  const {
    agentDir, threadId, sessionFile, systemPrompt, userMessage,
    provider, model, contextWindow, maxOutputTokens, logger,
  } = opts;

  const inputBudget = contextWindow - maxOutputTokens - SAFETY_MARGIN;
  const statePath = compactStatePath(agentDir, threadId);
  const state = await loadCompactState(statePath);

  // Increment turn count
  state.turnCount += 1;

  const messages = await loadSessionMessages(sessionFile);
  const totalTokens = estimateTotalTokens(systemPrompt, messages, userMessage);

  if (!shouldCompact(totalTokens, inputBudget, state)) {
    await saveCompactState(statePath, state);
    return;
  }

  logger.info(`Compacting session for thread ${threadId} (tokens≈${totalTokens}, budget=${inputBudget}, turn=${state.turnCount})`);

  // Separate system messages and synthetic summary messages (injected by previous compactions).
  // Synthetic summaries are excluded from splitMessages — the actual summary text is read
  // from the memory file and passed to generateSummary as existingSummary for incremental merge.
  const systemMessages = messages.filter((m) => m.role === 'system');
  const conversationMessages = messages.filter(
    (m) => m.role !== 'system' && !isSyntheticSummary(m),
  );
  const { toSummarize, recentRaw } = splitMessages(conversationMessages, RECENT_RAW_TOKEN_BUDGET);

  if (toSummarize.length === 0) {
    // Nothing old enough to summarize — reset interval so we don't re-trigger immediately
    logger.info(`Nothing to summarize for thread ${threadId}, skipping compaction`);
    state.lastCompactedAt = state.turnCount;
    await saveCompactState(statePath, state);
    return;
  }

  // Try to generate summary
  let summaryText: string | null = null;
  try {
    summaryText = await generateSummary(agentDir, threadId, toSummarize, provider, model, logger);
  } catch (err) {
    logger.error(`Summarization failed for thread ${threadId}: ${(err as Error).message} — falling back to truncation`);
  }

  // Rewrite session file
  const newMessages: SessionMessage[] = [
    ...systemMessages,
    ...(summaryText
      ? [{ role: 'assistant' as const, content: `[Memory Summary]\n${summaryText}`, timestamp: new Date().toISOString() }]
      : []),
    ...recentRaw,
  ];

  // If still over budget after compaction (e.g. summary itself is large), halve recentRaw
  const rewrittenTokens = estimateTotalTokens(systemPrompt, newMessages, userMessage);
  if (rewrittenTokens > inputBudget) {
    logger.info(`Post-compaction still over budget (${rewrittenTokens}), trimming recentRaw further`);
    const halvedBudget = Math.floor(RECENT_RAW_TOKEN_BUDGET / 2);
    // Use conversationMessages (already stripped of system + synthetic summaries)
    const { recentRaw: trimmed } = splitMessages(conversationMessages, halvedBudget);
    newMessages.splice(systemMessages.length + (summaryText ? 1 : 0));
    newMessages.push(...trimmed);
  }

  await writeSessionMessages(sessionFile, newMessages);

  // Persist summary to memory file
  if (summaryText) {
    const memoryDir = path.join(agentDir, 'memory');
    await mkdir(memoryDir, { recursive: true });
    await writeFile(path.join(memoryDir, `thread-${threadId}.md`), summaryText, 'utf8');
    logger.info(`Thread memory updated for ${threadId}`);
  }

  state.lastCompactedAt = state.turnCount;
  await saveCompactState(statePath, state);
  logger.info(`Session compaction complete for thread ${threadId}`);
}

/**
 * Call the LLM to summarize old conversation turns.
 * Uses a dedicated session file so it doesn't pollute the main thread session.
 * If a previous summary exists, passes it to the model for incremental update.
 */
async function generateSummary(
  agentDir: string,
  threadId: string,
  toSummarize: SessionMessage[],
  provider: string,
  model: string,
  logger: Logger,
): Promise<string> {
  const sessionsDir = path.join(agentDir, 'sessions');
  await mkdir(sessionsDir, { recursive: true });

  const summarySessionFile = path.join(sessionsDir, `compact-${threadId}.jsonl`);
  const systemPromptFile = path.join(sessionsDir, `system-compact.md`);

  const systemPromptContent = `You are compressing the memory of an AI agent. The summary you produce will be injected into the agent's system prompt for future conversations. Write in second person ("You previously...") so the agent can read it as its own memory.

Produce a structured markdown summary with these sections (omit sections with no relevant content):
## Key Facts
Established facts, user preferences, confirmed information.
## Decisions Made
Choices agreed upon or actions taken.
## Open Questions
Unresolved issues or pending tasks.
## Tool Outputs
Important results from tool calls worth remembering.
## Context
Any other context needed to continue the conversation naturally.

Be concise. Omit small talk and redundant exchanges.`;

  await writeFile(systemPromptFile, systemPromptContent, 'utf8');

  // Load existing summary for incremental update
  const memoryPath = path.join(agentDir, 'memory', `thread-${threadId}.md`);
  let existingSummary: string | null = null;
  try {
    const { readFile } = await import('../repo-utils/fs.js');
    existingSummary = await readFile(memoryPath, 'utf8');
  } catch {
    // No existing summary — first compaction
  }

  const transcript = buildTranscript(toSummarize);
  const turnCount = toSummarize.filter((m) => m.role === 'user').length;

  let userMessage: string;
  if (existingSummary) {
    userMessage = `You have an existing memory summary from earlier in this conversation:

--- EXISTING SUMMARY ---
${existingSummary}
--- END SUMMARY ---

Now compress the following NEW conversation turns (${turnCount} user turn(s)) and merge them into an updated summary:

--- NEW CONVERSATION ---
${transcript}
--- END CONVERSATION ---

Produce a single updated summary that incorporates both the existing summary and the new turns.`;
  } else {
    userMessage = `Compress the following conversation (${turnCount} user turn(s)) into a structured memory summary:

--- CONVERSATION ---
${transcript}
--- END CONVERSATION ---`;
  }

  logger.info(`Requesting summary for ${toSummarize.length} messages in thread ${threadId}${existingSummary ? ' (incremental)' : ''}`);

  const result = await invokeLlm({
    sessionFile: summarySessionFile,
    systemPromptFile,
    provider,
    model,
    userMessage,
  });

  return result.reply;
}

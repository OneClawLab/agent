import { readFile, writeFile } from '../repo-utils/fs.js';
import { path } from '../repo-utils/path.js';
import { existsSync } from '../repo-utils/fs.js';

/**
 * A single message in a pai chat session JSONL file.
 * Mirrors pai's Message type (role + content required, rest optional).
 */
export interface SessionMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  timestamp?: string;
  name?: string;
  tool_call_id?: string;
  tool_calls?: unknown[];
}

/**
 * Language-aware token estimator.
 *
 * Uses per-character codepoint weights to handle mixed CJK/Latin/ASCII content:
 *   - CJK, fullwidth, emoji (cp > 0x2E7F): ~1.5 tokens/char
 *   - Latin extended, accented (cp > 0x007F): ~0.7 tokens/char
 *   - ASCII (cp ≤ 0x007F): ~0.25 tokens/char (i.e. 4 chars per token)
 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp > 0x2E7F) {
      tokens += 1.5;
    } else if (cp > 0x007F) {
      tokens += 0.7;
    } else {
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}

/**
 * Estimate tokens for a single session message (role + content + metadata).
 */
export function estimateMessageTokens(msg: SessionMessage): number {
  const contentStr = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
  // Add ~4 tokens overhead per message for role/formatting
  return estimateTokens(contentStr) + 4;
}

/**
 * Load session messages from a JSONL file.
 * Returns empty array if file does not exist.
 * Skips empty lines; throws on malformed JSON.
 */
export async function loadSessionMessages(sessionFile: string): Promise<SessionMessage[]> {
  if (!existsSync(sessionFile)) {
    return [];
  }

  const raw = await readFile(sessionFile, 'utf8');
  const messages: SessionMessage[] = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const msg = JSON.parse(trimmed) as SessionMessage;
    messages.push(msg);
  }

  return messages;
}

/**
 * Write session messages to a JSONL file (overwrites existing content).
 */
export async function writeSessionMessages(sessionFile: string, messages: SessionMessage[]): Promise<void> {
  const lines = messages.map((m) => JSON.stringify(m)).join('\n') + '\n';
  await writeFile(sessionFile, lines, 'utf8');
}

/**
 * Split messages into two groups:
 *   - recentRaw: newest messages whose cumulative token count ≤ recentTokenBudget
 *   - toSummarize: all older messages
 *
 * System messages are always excluded from both groups (handled separately).
 * Messages are processed newest-first to fill recentRaw.
 */
export function splitMessages(
  messages: SessionMessage[],
  recentTokenBudget: number,
): { toSummarize: SessionMessage[]; recentRaw: SessionMessage[] } {
  // Separate system messages
  const nonSystem = messages.filter((m) => m.role !== 'system');

  // Fill recentRaw from the end (newest first)
  const recentRaw: SessionMessage[] = [];
  let accumulated = 0;

  for (let i = nonSystem.length - 1; i >= 0; i--) {
    const msg = nonSystem[i]!;
    const t = estimateMessageTokens(msg);
    if (accumulated + t <= recentTokenBudget) {
      recentRaw.unshift(msg);
      accumulated += t;
    } else {
      break;
    }
  }

  // Everything not in recentRaw goes to toSummarize
  const recentSet = new Set(recentRaw);
  const toSummarize = nonSystem.filter((m) => !recentSet.has(m));

  return { toSummarize, recentRaw };
}

/**
 * Build a structured transcript from messages for use as summarizer input.
 * Groups turns and distinguishes tool calls from regular messages.
 */
export function buildTranscript(messages: SessionMessage[]): string {
  const lines: string[] = [];
  let turnIndex = 0;
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i]!;

    if (msg.role === 'user') {
      turnIndex++;
      lines.push(`[Turn ${turnIndex}]`);
      lines.push(`User: ${msg.content}`);
      i++;
      continue;
    }

    if (msg.role === 'assistant') {
      const toolCalls = msg.tool_calls as Array<{ name?: string; arguments?: unknown }> | undefined;
      if (toolCalls?.length) {
        // Collect tool call + result pairs that follow
        lines.push(`Assistant called tool \`${toolCalls[0]?.name ?? '?'}\` with: ${JSON.stringify(toolCalls[0]?.arguments ?? {})}`);
      } else {
        lines.push(`Assistant: ${msg.content}`);
      }
      i++;
      continue;
    }

    if (msg.role === 'tool') {
      lines.push(`Tool result (${msg.name ?? '?'}): ${msg.content}`);
      i++;
      continue;
    }

    i++;
  }

  return lines.join('\n');
}

/**
 * Compact state sidecar file: tracks turn count and last compaction turn.
 */
export interface CompactState {
  turnCount: number;
  lastCompactedAt: number;
}

export function compactStatePath(agentDir: string, threadId: string): string {
  return path.join(agentDir, 'sessions', `compact-state-${threadId}.json`);
}

export async function loadCompactState(statePath: string): Promise<CompactState> {
  if (!existsSync(statePath)) {
    return { turnCount: 0, lastCompactedAt: 0 };
  }
  const raw = await readFile(statePath, 'utf8');
  return JSON.parse(raw) as CompactState;
}

export async function saveCompactState(statePath: string, state: CompactState): Promise<void> {
  await writeFile(statePath, JSON.stringify(state), 'utf8');
}

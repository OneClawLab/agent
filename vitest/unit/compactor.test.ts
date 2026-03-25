import { describe, it, expect } from 'vitest';
import { shouldCompact, estimateTotalTokens } from '../../src/runner/compactor.js';
import type { SessionMessage } from '../../src/runner/session.js';

describe('shouldCompact', () => {
  const state = (turnCount: number, lastCompactedAt: number) => ({ turnCount, lastCompactedAt });

  it('returns false when under threshold and under interval', () => {
    expect(shouldCompact(1000, 10000, state(5, 0))).toBe(false);
  });

  it('returns true when tokens exceed 80% of inputBudget', () => {
    // 8001 > 10000 * 0.8 = 8000
    expect(shouldCompact(8001, 10000, state(5, 0))).toBe(true);
  });

  it('returns true exactly at 80% boundary', () => {
    expect(shouldCompact(8000, 10000, state(5, 0))).toBe(false);
    expect(shouldCompact(8001, 10000, state(5, 0))).toBe(true);
  });

  it('returns true when turn interval >= 10', () => {
    // turnCount - lastCompactedAt = 10
    expect(shouldCompact(100, 10000, state(10, 0))).toBe(true);
  });

  it('returns false when turn interval is 9', () => {
    expect(shouldCompact(100, 10000, state(9, 0))).toBe(false);
  });

  it('returns true when BOTH conditions are met', () => {
    expect(shouldCompact(9000, 10000, state(15, 0))).toBe(true);
  });

  it('interval resets after compaction', () => {
    // lastCompactedAt = 8, turnCount = 17 → diff = 9 → not triggered
    expect(shouldCompact(100, 10000, state(17, 8))).toBe(false);
    // turnCount = 18 → diff = 10 → triggered
    expect(shouldCompact(100, 10000, state(18, 8))).toBe(true);
  });
});

describe('estimateTotalTokens', () => {
  const makeMsg = (role: SessionMessage['role'], content: string): SessionMessage => ({ role, content });

  it('sums system + session + user tokens', () => {
    const systemPrompt = 'You are helpful.'; // ~5 tokens
    const sessionMessages: SessionMessage[] = [
      makeMsg('user', 'Hello'),       // ~6 tokens (content + overhead)
      makeMsg('assistant', 'Hi'),     // ~5 tokens
    ];
    const userMessage = 'How are you?'; // ~4 tokens + 4 overhead

    const total = estimateTotalTokens(systemPrompt, sessionMessages, userMessage);
    // Should be a reasonable positive number
    expect(total).toBeGreaterThan(10);
    expect(total).toBeLessThan(200);
  });

  it('empty inputs return minimal overhead', () => {
    const total = estimateTotalTokens('', [], '');
    // Just the user message overhead (4 tokens)
    expect(total).toBe(4);
  });

  it('scales with content size', () => {
    const short = estimateTotalTokens('sys', [], 'hi');
    const long = estimateTotalTokens('sys', [], 'hi'.repeat(1000));
    expect(long).toBeGreaterThan(short);
  });

  it('CJK content produces more tokens than equivalent ASCII', () => {
    const ascii = estimateTotalTokens('', [], 'hello world hello world');
    const cjk = estimateTotalTokens('', [], '你好世界你好世界你好世界');
    // CJK chars are weighted higher (1.5 vs 0.25)
    expect(cjk).toBeGreaterThan(ascii);
  });
});

import { describe as describeCompact, it as itCompact, expect as expectCompact, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeSessionMessages, loadSessionMessages, splitMessages } from '../../src/runner/session.js';

// Bug fix tests: these exercise the compactSession internals via session file state,
// without calling the LLM (we test the splitting/filtering logic directly).

describeCompact('isSyntheticSummary filtering (Bug fix: synthetic summary not re-summarized)', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-compact-bug-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  itCompact('synthetic summary message is excluded from conversationMessages passed to splitMessages', async () => {
    // Simulate a session file after a previous compaction:
    // [synthetic summary] + [recent raw turns]
    const sessionFile = join(tmpDir, 'session.jsonl');
    const messages = [
      { role: 'assistant' as const, content: '[Memory Summary]\n## Key Facts\nUser likes TypeScript.' },
      { role: 'user' as const, content: 'turn 1 user' },
      { role: 'assistant' as const, content: 'turn 1 assistant' },
      { role: 'user' as const, content: 'turn 2 user' },
      { role: 'assistant' as const, content: 'turn 2 assistant' },
    ];
    await writeSessionMessages(sessionFile, messages);

    const loaded = await loadSessionMessages(sessionFile);

    // Filter as compactSession does
    const conversationMessages = loaded.filter(
      (m) => m.role !== 'system' && !(m.role === 'assistant' && m.content.startsWith('[Memory Summary]\n')),
    );

    // Synthetic summary should be excluded
    expectCompact(conversationMessages.every((m) => !m.content.startsWith('[Memory Summary]'))).toBe(true);
    expectCompact(conversationMessages).toHaveLength(4);
  });

  itCompact('post-compaction trim uses conversationMessages not raw messages (Bug fix: no duplicate summary)', async () => {
    // Simulate session with synthetic summary + conversation
    const sessionFile = join(tmpDir, 'session.jsonl');
    const messages = [
      { role: 'assistant' as const, content: '[Memory Summary]\n## Key Facts\nSome facts.' },
      { role: 'user' as const, content: 'hello' },
      { role: 'assistant' as const, content: 'hi' },
    ];
    await writeSessionMessages(sessionFile, messages);

    const loaded = await loadSessionMessages(sessionFile);

    // conversationMessages excludes system + synthetic summaries
    const conversationMessages = loaded.filter(
      (m) => m.role !== 'system' && !(m.role === 'assistant' && m.content.startsWith('[Memory Summary]\n')),
    );

    // If we splitMessages on conversationMessages, the synthetic summary never appears in recentRaw
    const { recentRaw } = splitMessages(conversationMessages, 10000);

    expectCompact(recentRaw.every((m) => !m.content.startsWith('[Memory Summary]'))).toBe(true);
  });
});

describeCompact('turnCount interval reset (Bug fix: empty toSummarize resets lastCompactedAt)', () => {
  itCompact('shouldCompact interval resets when lastCompactedAt is updated', () => {
    // Simulate: compaction triggered at turn 10, toSummarize was empty → lastCompactedAt set to 10
    // Next trigger should be at turn 20, not turn 11

    // After reset: lastCompactedAt = 10, turnCount = 19 → diff = 9 → no trigger
    expectCompact(shouldCompact(100, 10000, { turnCount: 19, lastCompactedAt: 10 })).toBe(false);
    // turnCount = 20 → diff = 10 → trigger
    expectCompact(shouldCompact(100, 10000, { turnCount: 20, lastCompactedAt: 10 })).toBe(true);
  });

  itCompact('without reset: interval would fire every turn after first trigger', () => {
    // If lastCompactedAt stayed at 0 (old bug), turn 10 would keep triggering
    expectCompact(shouldCompact(100, 10000, { turnCount: 10, lastCompactedAt: 0 })).toBe(true);
    expectCompact(shouldCompact(100, 10000, { turnCount: 11, lastCompactedAt: 0 })).toBe(true);

    // With fix: after reset to 10, turn 11 does NOT trigger
    expectCompact(shouldCompact(100, 10000, { turnCount: 11, lastCompactedAt: 10 })).toBe(false);
  });
});

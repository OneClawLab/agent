import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  estimateTokens,
  estimateMessageTokens,
  loadSessionMessages,
  writeSessionMessages,
  splitMessages,
  buildTranscript,
  loadCompactState,
  saveCompactState,
  compactStatePath,
  type SessionMessage,
} from '../../src/runner/session.js';

describe('estimateTokens', () => {
  it('ASCII text: ~4 chars per token', () => {
    // 40 ASCII chars → ceil(40 * 0.25) = 10
    expect(estimateTokens('hello world hello world hello world hell')).toBe(10);
  });

  it('empty string returns 0', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('CJK text: ~1.5 tokens per char', () => {
    // 4 CJK chars → ceil(4 * 1.5) = 6
    expect(estimateTokens('你好世界')).toBe(6);
  });

  it('mixed CJK + ASCII', () => {
    // '你好' = 2 CJK = 3 tokens, ' world' = 6 ASCII = 2 tokens → ceil(3+1.5) = 5
    const result = estimateTokens('你好 world');
    expect(result).toBeGreaterThan(3);
    expect(result).toBeLessThan(12);
  });

  it('Latin extended chars (accented)', () => {
    // 'café' = 3 ASCII + 1 extended → ceil(3*0.25 + 1*0.7) = ceil(1.45) = 2
    expect(estimateTokens('café')).toBe(2);
  });
});

describe('estimateMessageTokens', () => {
  it('adds ~4 token overhead per message', () => {
    const msg: SessionMessage = { role: 'user', content: '' };
    expect(estimateMessageTokens(msg)).toBe(4);
  });

  it('includes content tokens', () => {
    const msg: SessionMessage = { role: 'user', content: 'hello' };
    // 'hello' = 5 ASCII = ceil(1.25) = 2 tokens + 4 overhead = 6
    expect(estimateMessageTokens(msg)).toBe(6);
  });
});

describe('loadSessionMessages / writeSessionMessages', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-session-test-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array for non-existent file', async () => {
    const result = await loadSessionMessages(join(tmpDir, 'nonexistent.jsonl'));
    expect(result).toEqual([]);
  });

  it('round-trips messages through write/load', async () => {
    const sessionFile = join(tmpDir, 'session.jsonl');
    const messages: SessionMessage[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ];

    await writeSessionMessages(sessionFile, messages);
    const loaded = await loadSessionMessages(sessionFile);

    expect(loaded).toHaveLength(3);
    expect(loaded[0]!.role).toBe('system');
    expect(loaded[1]!.content).toBe('Hello');
    expect(loaded[2]!.role).toBe('assistant');
  });

  it('skips empty lines', async () => {
    const sessionFile = join(tmpDir, 'session.jsonl');
    await writeFile(sessionFile, '{"role":"user","content":"hi"}\n\n{"role":"assistant","content":"hello"}\n', 'utf8');

    const loaded = await loadSessionMessages(sessionFile);
    expect(loaded).toHaveLength(2);
  });

  it('preserves tool messages with name and tool_call_id', async () => {
    const sessionFile = join(tmpDir, 'session.jsonl');
    const messages: SessionMessage[] = [
      { role: 'tool', content: 'result', name: 'bash_exec', tool_call_id: 'call_1' },
    ];
    await writeSessionMessages(sessionFile, messages);
    const loaded = await loadSessionMessages(sessionFile);

    expect(loaded[0]!.name).toBe('bash_exec');
    expect(loaded[0]!.tool_call_id).toBe('call_1');
  });
});

describe('splitMessages', () => {
  const makeMsg = (role: SessionMessage['role'], content: string): SessionMessage => ({ role, content });

  it('puts all messages in recentRaw when total tokens fit budget', () => {
    const messages = [
      makeMsg('user', 'hi'),
      makeMsg('assistant', 'hello'),
    ];
    const { toSummarize, recentRaw } = splitMessages(messages, 10000);
    expect(toSummarize).toHaveLength(0);
    expect(recentRaw).toHaveLength(2);
  });

  it('excludes system messages from both groups', () => {
    const messages = [
      makeMsg('system', 'You are helpful.'),
      makeMsg('user', 'hi'),
      makeMsg('assistant', 'hello'),
    ];
    const { toSummarize, recentRaw } = splitMessages(messages, 10000);
    expect(toSummarize.every((m) => m.role !== 'system')).toBe(true);
    expect(recentRaw.every((m) => m.role !== 'system')).toBe(true);
  });

  it('keeps newest messages in recentRaw when budget is tight', () => {
    // Create many messages; only the last few should fit in a small budget
    const messages: SessionMessage[] = Array.from({ length: 20 }, (_, i) =>
      makeMsg(i % 2 === 0 ? 'user' : 'assistant', `message number ${i}`)
    );

    const { toSummarize, recentRaw } = splitMessages(messages, 20); // very tight budget

    expect(recentRaw.length).toBeGreaterThan(0);
    expect(toSummarize.length).toBeGreaterThan(0);
    expect(toSummarize.length + recentRaw.length).toBe(20);

    // recentRaw should be the tail of the original array
    const lastRecentId = recentRaw[0]!.content;
    const firstSummarizeId = toSummarize[toSummarize.length - 1]!.content;
    const lastSummarizeIdx = messages.findIndex((m) => m.content === firstSummarizeId);
    const firstRecentIdx = messages.findIndex((m) => m.content === lastRecentId);
    expect(firstRecentIdx).toBeGreaterThan(lastSummarizeIdx);
  });

  it('toSummarize + recentRaw covers all non-system messages', () => {
    const messages: SessionMessage[] = [
      makeMsg('system', 'sys'),
      makeMsg('user', 'a'),
      makeMsg('assistant', 'b'),
      makeMsg('user', 'c'),
      makeMsg('assistant', 'd'),
    ];
    const { toSummarize, recentRaw } = splitMessages(messages, 15);
    const allNonSystem = messages.filter((m) => m.role !== 'system');
    expect(toSummarize.length + recentRaw.length).toBe(allNonSystem.length);
  });
});

describe('buildTranscript', () => {
  it('formats messages with role prefix', () => {
    const messages: SessionMessage[] = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi' },
    ];
    const transcript = buildTranscript(messages);
    expect(transcript).toContain('User: Hello');
    expect(transcript).toContain('Assistant: Hi');
    expect(transcript).toContain('[Turn 1]');
  });

  it('formats tool messages with tool name', () => {
    const messages: SessionMessage[] = [
      { role: 'tool', content: 'output', name: 'bash_exec' },
    ];
    const transcript = buildTranscript(messages);
    expect(transcript).toContain('Tool result (bash_exec): output');
  });

  it('uses ? for tool messages without name', () => {
    const messages: SessionMessage[] = [
      { role: 'tool', content: 'output' },
    ];
    const transcript = buildTranscript(messages);
    expect(transcript).toContain('Tool result (?): output');
  });

  it('increments turn index per user message', () => {
    const messages: SessionMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply1' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply2' },
    ];
    const transcript = buildTranscript(messages);
    expect(transcript).toContain('[Turn 1]');
    expect(transcript).toContain('[Turn 2]');
  });

  it('formats assistant tool_calls with name and arguments', () => {
    const messages: SessionMessage[] = [
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ name: 'bash_exec', arguments: { cmd: 'ls' } }],
      },
    ];
    const transcript = buildTranscript(messages);
    expect(transcript).toContain('bash_exec');
    expect(transcript).toContain('ls');
  });
});

describe('CompactState persistence', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'agent-compact-state-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('returns zero state for non-existent file', async () => {
    const statePath = join(tmpDir, 'compact-state-thread1.json');
    const state = await loadCompactState(statePath);
    expect(state).toEqual({ turnCount: 0, lastCompactedAt: 0 });
  });

  it('round-trips state through save/load', async () => {
    const statePath = join(tmpDir, 'compact-state-thread1.json');
    await saveCompactState(statePath, { turnCount: 15, lastCompactedAt: 10 });
    const loaded = await loadCompactState(statePath);
    expect(loaded).toEqual({ turnCount: 15, lastCompactedAt: 10 });
  });

  it('compactStatePath returns correct path', () => {
    const p = compactStatePath('/agents/myagent', 'thread-abc');
    expect(p).toContain('sessions');
    expect(p).toContain('compact-state-thread-abc.json');
  });
});

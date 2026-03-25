import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { invokeLlm, buildSessionFilePath } from '../../src/runner/llm.js';

// ── Mock node:child_process spawn ────────────────────────────────────────────

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: vi.fn() };
});

import { spawn } from 'node:child_process';
const mockSpawn = vi.mocked(spawn);

// ── Fake process factory ──────────────────────────────────────────────────────

interface FakeProc {
  stdout: EventEmitter;
  stderr: EventEmitter;
  proc: EventEmitter & { pid?: number };
}

/**
 * Build a fake ChildProcess-like object and schedule stdout/stderr/close
 * events on the next tick so the promise has time to set up listeners.
 */
function fakeProcess(opts: {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}): FakeProc {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const proc = new EventEmitter() as EventEmitter & { pid?: number };
  proc.pid = 12345;
  // Attach streams so llm.ts can call proc.stdout!.on(...)
  (proc as unknown as Record<string, unknown>)['stdout'] = stdout;
  (proc as unknown as Record<string, unknown>)['stderr'] = stderr;

  // Emit events asynchronously
  setImmediate(() => {
    if (opts.stderr) {
      stderr.emit('data', Buffer.from(opts.stderr));
    }
    if (opts.stdout) {
      stdout.emit('data', Buffer.from(opts.stdout));
    }
    proc.emit('close', opts.exitCode ?? 0);
  });

  return { stdout, stderr, proc };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const BASE_PARAMS = {
  sessionFile: '/agents/bot/sessions/thread-1.jsonl',
  systemPromptFile: '/agents/bot/system-prompt.md',
  provider: 'openai',
  model: 'gpt-4o',
  userMessage: 'Hello!',
};

beforeEach(() => {
  mockSpawn.mockClear();
});

// ── buildSessionFilePath ──────────────────────────────────────────────────────

describe('buildSessionFilePath', () => {
  it('builds correct path from agentDir and threadId', () => {
    expect(buildSessionFilePath('/agents/bot', 'thread-1')).toBe('/agents/bot/sessions/thread-1.jsonl');
  });

  it('handles nested agentDir', () => {
    expect(buildSessionFilePath('/home/user/.theclaw/agents/mybot', 'abc123')).toBe(
      '/home/user/.theclaw/agents/mybot/sessions/abc123.jsonl'
    );
  });
});

// ── invokeLlm ─────────────────────────────────────────────────────────────────

describe('invokeLlm', () => {
  it('calls pai chat with --stream --json and correct arguments', async () => {
    const { proc } = fakeProcess({ stdout: 'Hello back!' });
    mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

    await invokeLlm(BASE_PARAMS);

    expect(mockSpawn).toHaveBeenCalledOnce();
    const [cmd, args] = mockSpawn.mock.calls[0]!;

    // On Windows spawn wraps via sh -c; on other platforms calls pai directly.
    // Either way the pai args must be present somewhere.
    const fullCmd = [cmd, ...(args ?? [])].join(' ');
    expect(fullCmd).toContain('pai');
    expect(fullCmd).toContain('chat');
    expect(fullCmd).toContain('--stream');
    expect(fullCmd).toContain('--json');
    expect(fullCmd).toContain('--session');
    expect(fullCmd).toContain('--system-file');
    expect(fullCmd).toContain('--provider');
    expect(fullCmd).toContain('--model');
  });

  it('returns plain text reply when stdout is not JSON', async () => {
    const { proc } = fakeProcess({ stdout: 'Hello back!' });
    mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

    const result = await invokeLlm(BASE_PARAMS);

    expect(result.reply).toBe('Hello back!');
    expect(result.toolCalls).toBeUndefined();
  });

  it('trims whitespace from stdout', async () => {
    const { proc } = fakeProcess({ stdout: '  trimmed reply  \n' });
    mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

    const result = await invokeLlm(BASE_PARAMS);

    expect(result.reply).toBe('trimmed reply');
  });

  it('parses JSON reply with toolCalls', async () => {
    const structured = {
      reply: 'I will call a tool.',
      toolCalls: [{ name: 'search', arguments: { query: 'test' } }],
    };
    const { proc } = fakeProcess({ stdout: JSON.stringify(structured) });
    mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

    const result = await invokeLlm(BASE_PARAMS);

    expect(result.reply).toBe('I will call a tool.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0]!.name).toBe('search');
  });

  it('parses JSON reply without toolCalls', async () => {
    const structured = { reply: 'Just a reply.' };
    const { proc } = fakeProcess({ stdout: JSON.stringify(structured) });
    mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

    const result = await invokeLlm(BASE_PARAMS);

    expect(result.reply).toBe('Just a reply.');
    expect(result.toolCalls).toBeUndefined();
  });

  it('treats JSON without reply field as plain text', async () => {
    const notAReply = JSON.stringify({ something: 'else' });
    const { proc } = fakeProcess({ stdout: notAReply });
    mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

    const result = await invokeLlm(BASE_PARAMS);

    expect(result.reply).toBe(notAReply);
    expect(result.toolCalls).toBeUndefined();
  });

  it('handles empty toolCalls array — omits the field', async () => {
    const structured = { reply: 'No tools.', toolCalls: [] };
    const { proc } = fakeProcess({ stdout: JSON.stringify(structured) });
    mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

    const result = await invokeLlm(BASE_PARAMS);

    expect(result.reply).toBe('No tools.');
    expect(result.toolCalls).toBeUndefined();
  });

  it('rejects when process exits with non-zero code', async () => {
    const { proc } = fakeProcess({ stdout: '', exitCode: 1 });
    mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

    await expect(invokeLlm(BASE_PARAMS)).rejects.toThrow('pai chat exited with code 1');
  });

  it('calls onProgress for each NDJSON stderr line', async () => {
    const events = [
      { type: 'start', data: { provider: 'openai', model: 'gpt-4o' } },
      { type: 'tool_call', data: { name: 'bash_exec', arguments: { command: 'ls', comment: 'list files' } } },
      { type: 'complete', data: { finishReason: 'stop' } },
    ];
    const stderrPayload = events.map(e => JSON.stringify(e)).join('\n') + '\n';

    const { proc } = fakeProcess({ stdout: 'done', stderr: stderrPayload });
    mockSpawn.mockReturnValue(proc as ReturnType<typeof spawn>);

    const received: unknown[] = [];
    await invokeLlm({ ...BASE_PARAMS, onProgress: (e) => received.push(e) });

    expect(received).toHaveLength(3);
    expect((received[0] as { type: string }).type).toBe('start');
    expect((received[1] as { type: string }).type).toBe('tool_call');
    expect((received[2] as { type: string }).type).toBe('complete');
  });
});

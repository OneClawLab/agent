/**
 * Integration tests: init → start → run → deliver full flow
 * Tests status and list output as well.
 * Requirements: 1.1-1.6, 2.1-2.3, 4.1-4.10, 7.1-7.6, 10.1-10.3
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ── Mocks ─────────────────────────────────────────────────────────────────────

vi.mock('../../src/os-utils.js', () => ({
  execCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

vi.mock('../../src/runner/inbox.js', () => ({
  consumeMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/runner/router.js', () => ({
  routeMessage: vi.fn().mockResolvedValue({ threadPath: '/tmp/thread', isNew: false }),
}));

vi.mock('../../src/runner/llm.js', () => ({
  invokeLlm: vi.fn().mockResolvedValue({ reply: 'Hello from agent!' }),
  buildSessionFilePath: vi.fn((agentDir: string, threadId: string) =>
    `${agentDir}/sessions/${threadId}.jsonl`
  ),
}));

vi.mock('../../src/runner/recorder.js', () => ({
  pushMessage: vi.fn().mockResolvedValue('evt-msg-1'),
  pushReply: vi.fn().mockResolvedValue('evt-reply-1'),
  pushRecord: vi.fn().mockResolvedValue('evt-rec-1'),
}));

vi.mock('../../src/identity.js', () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue('# Agent\nYou are a test agent.'),
}));

vi.mock('../../src/errors.js', () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

const mockLogInfo = vi.fn();
const mockLogError = vi.fn();
vi.mock('../../src/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: mockLogInfo, error: mockLogError, debug: vi.fn() })),
}));

let tmpBase: string;
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => tmpBase };
});

// Suppress command stdout during tests
let stdoutSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true); });
afterEach(() => { stdoutSpy.mockRestore(); });

// ── Import mocked modules ─────────────────────────────────────────────────────

import { execCommand } from '../../src/os-utils.js';
import { consumeMessages } from '../../src/runner/inbox.js';
import { routeMessage } from '../../src/runner/router.js';
import { invokeLlm } from '../../src/runner/llm.js';
import { pushMessage, pushReply } from '../../src/runner/recorder.js';

const mockExecCommand = vi.mocked(execCommand);
const mockConsumeMessages = vi.mocked(consumeMessages);
const mockRouteMessage = vi.mocked(routeMessage);
const mockInvokeLlm = vi.mocked(invokeLlm);
const mockPushMessage = vi.mocked(pushMessage);
const mockPushReply = vi.mocked(pushReply);

// Import commands AFTER mocks
const { initCmd } = await import('../../src/commands/init.js');
const { startCmd } = await import('../../src/commands/start.js');
const { stopCmd } = await import('../../src/commands/stop.js');
const { runCmd } = await import('../../src/commands/run.js');
const { deliverCmd } = await import('../../src/commands/deliver.js');
const { statusCmd } = await import('../../src/commands/status.js');
const { listCmd } = await import('../../src/commands/status.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function agentDir(id: string) {
  return join(tmpBase, '.theclaw', 'agents', id);
}

function makeInboxMessage(overrides: Record<string, unknown> = {}) {
  return {
    eventId: 'evt-inbox-1',
    type: 'message' as const,
    source: 'xgw:telegram:user42',
    content: {
      text: 'Hello agent',
      reply_context: {
        channel_type: 'external' as const,
        channel_id: 'telegram',
        peer_id: 'user42',
      },
    },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(async () => {
  tmpBase = await mkdtemp(join(tmpdir(), 'agent-integration-test-'));
  vi.clearAllMocks();
  mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' });
  mockConsumeMessages.mockResolvedValue([]);
  mockRouteMessage.mockResolvedValue({ threadPath: join(tmpBase, 'thread'), isNew: false });
  mockInvokeLlm.mockResolvedValue({ reply: 'Hello from agent!' });
  mockPushMessage.mockResolvedValue('evt-msg-1');
  mockPushReply.mockResolvedValue('evt-reply-1');
});

afterEach(async () => {
  await rm(tmpBase, { recursive: true, force: true });
});

// ── init → start → run → deliver flow ────────────────────────────────────────

describe('Integration: init → start → run → deliver', () => {
  it('init creates agent directory structure', async () => {
    await initCmd('bot', { kind: 'user' });
    const dir = agentDir('bot');

    // Core directories exist
    for (const sub of ['inbox', 'sessions', 'memory', 'logs', 'workdir']) {
      expect(existsSync(join(dir, sub))).toBe(true);
    }
    // Thread subdirs
    for (const sub of ['peers', 'channels', 'main']) {
      expect(existsSync(join(dir, 'threads', sub))).toBe(true);
    }
  });

  it('init generates valid config.yaml', async () => {
    await initCmd('bot', { kind: 'user' });
    const config = await readFile(join(agentDir('bot'), 'config.yaml'), 'utf8');
    expect(config).toContain('agent_id: bot');
    expect(config).toContain('kind: user');
    expect(config).toContain('provider: openai');
    expect(config).toContain('default: per-peer');
  });

  it('init calls thread init for inbox', async () => {
    await initCmd('bot', { kind: 'user' });
    expect(mockExecCommand).toHaveBeenCalledWith('thread', [
      'init', '--thread', join(agentDir('bot'), 'inbox'),
    ]);
  });

  it('start subscribes inbox after init', async () => {
    await initCmd('bot', { kind: 'user' });
    mockExecCommand.mockClear();

    await startCmd('bot');

    // config.yaml stores inbox path as ~/.theclaw/agents/bot/inbox (literal tilde)
    expect(mockExecCommand).toHaveBeenCalledWith('thread', expect.arrayContaining([
      'subscribe',
      '--consumer', 'inbox',
      '--handler', 'agent run bot',
    ]));
    const subscribeCall = mockExecCommand.mock.calls.find(
      ([, args]) => (args as string[]).includes('subscribe')
    );
    expect(subscribeCall).toBeDefined();
    expect((subscribeCall![1] as string[]).join(' ')).toContain('bot/inbox');
  });

  it('run processes inbox messages after start', async () => {
    await initCmd('bot', { kind: 'user' });
    await startCmd('bot');
    mockExecCommand.mockClear();

    const msg = makeInboxMessage();
    mockConsumeMessages.mockResolvedValue([msg]);

    await runCmd('bot');

    expect(mockPushMessage).toHaveBeenCalledWith(
      expect.any(String),
      'xgw:telegram:user42',
      msg.content
    );
    expect(mockInvokeLlm).toHaveBeenCalledOnce();
    expect(mockPushReply).toHaveBeenCalledWith(
      expect.any(String),
      'Hello from agent!',
      expect.objectContaining({ channel_id: 'telegram', peer_id: 'user42' })
    );
  });

  it('run cleans up lock file after processing', async () => {
    await initCmd('bot', { kind: 'user' });
    await startCmd('bot');

    mockConsumeMessages.mockResolvedValue([makeInboxMessage()]);
    await runCmd('bot');

    expect(existsSync(join(agentDir('bot'), 'run.lock'))).toBe(false);
  });

  it('deliver pops and routes outbound events', async () => {
    await initCmd('bot', { kind: 'user' });
    await startCmd('bot');

    const threadPath = join(agentDir('bot'), 'threads', 'peers', 'telegram-user42');
    const events = [{
      eventId: 'out-1',
      content: {
        text: 'Hello from agent!',
        reply_context: {
          channel_type: 'external',
          channel_id: 'telegram',
          peer_id: 'user42',
        },
      },
    }];

    mockExecCommand
      .mockResolvedValueOnce({ stdout: JSON.stringify(events), stderr: '' }) // pop
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                      // xgw send
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                     // ack

    await deliverCmd({ thread: threadPath, consumer: 'outbound' });

    const xgwCall = mockExecCommand.mock.calls.find(([cmd]) => cmd === 'xgw');
    expect(xgwCall).toBeDefined();
    expect(xgwCall![1]).toContain('send');
  });

  it('stop unsubscribes inbox', async () => {
    await initCmd('bot', { kind: 'user' });
    await startCmd('bot');
    mockExecCommand.mockClear();

    await stopCmd('bot');

    // config.yaml stores inbox path as ~/.theclaw/agents/bot/inbox (literal tilde)
    expect(mockExecCommand).toHaveBeenCalledWith('thread', expect.arrayContaining([
      'unsubscribe',
      '--consumer', 'inbox',
    ]));
    const unsubCall = mockExecCommand.mock.calls.find(
      ([, args]) => (args as string[]).includes('unsubscribe')
    );
    expect(unsubCall).toBeDefined();
    expect((unsubCall![1] as string[]).join(' ')).toContain('bot/inbox');
  });
});

// ── status output ─────────────────────────────────────────────────────────────

describe('Integration: status output', () => {
  it('status shows agent info in human mode', async () => {
    await initCmd('bot', { kind: 'user' });
    stdoutSpy.mockClear();
    await statusCmd('bot', {});
    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('bot');
    expect(output).toContain('user');
  });

  it('status shows started=no before run', async () => {
    await initCmd('bot', { kind: 'user' });
    stdoutSpy.mockClear();
    await statusCmd('bot', {});
    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('no');
  });

  it('status shows started=yes while run.lock exists', async () => {
    await initCmd('bot', { kind: 'user' });
    await writeFile(join(agentDir('bot'), 'run.lock'), '');
    stdoutSpy.mockClear();
    await statusCmd('bot', {});
    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('yes');
  });

  it('status --json returns valid JSON with required fields', async () => {
    await initCmd('bot', { kind: 'system' });
    stdoutSpy.mockClear();
    await statusCmd('bot', { json: true });
    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({
      agent_id: 'bot',
      kind: 'system',
      started: false,
    });
    expect(parsed).toHaveProperty('last_activity');
  });

  it('status exits 1 for unknown agent', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await expect(statusCmd('ghost', {})).rejects.toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// ── list output ───────────────────────────────────────────────────────────────

describe('Integration: list output', () => {
  it('list shows all initialized agents', async () => {
    await initCmd('alpha', { kind: 'user' });
    await initCmd('beta', { kind: 'system' });
    stdoutSpy.mockClear();
    await listCmd({});
    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    expect(output).toContain('alpha');
    expect(output).toContain('beta');
  });

  it('list --json returns array of agents', async () => {
    await initCmd('alpha', { kind: 'user' });
    await initCmd('beta', { kind: 'system' });
    stdoutSpy.mockClear();
    await listCmd({ json: true });
    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    const ids = parsed.map((a: { agent_id: string }) => a.agent_id);
    expect(ids).toContain('alpha');
    expect(ids).toContain('beta');
  });

  it('list shows empty when no agents exist', async () => {
    stdoutSpy.mockClear();
    await listCmd({});
    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    // Should not throw, output can be empty or show "no agents"
    expect(typeof output).toBe('string');
  });

  it('list --json returns empty array when no agents', async () => {
    stdoutSpy.mockClear();
    await listCmd({ json: true });
    const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
    const parsed = JSON.parse(output);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(0);
  });
});

// ── Error scenarios ───────────────────────────────────────────────────────────

describe('Integration: error scenarios', () => {
  it('start fails with exit 1 when agent not initialized', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await expect(startCmd('ghost')).rejects.toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('run fails with exit 1 when agent not initialized', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await expect(runCmd('ghost')).rejects.toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('init fails with exit 1 when agent already exists', async () => {
    await initCmd('bot', { kind: 'user' });
    mockExecCommand.mockClear();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await expect(initCmd('bot', { kind: 'user' })).rejects.toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });

  it('run handles LLM failure gracefully and continues', async () => {
    await initCmd('bot', { kind: 'user' });
    await startCmd('bot');

    const { withRetry } = await import('../../src/errors.js');
    const mockWithRetry = vi.mocked(withRetry);

    const msgs = [makeInboxMessage({ eventId: 'e1' }), makeInboxMessage({ eventId: 'e2' })];
    mockConsumeMessages.mockResolvedValue(msgs);
    mockWithRetry
      .mockRejectedValueOnce(new Error('LLM auth failed'))
      .mockImplementationOnce(async (fn) => fn());

    // Should not throw — errors are caught per-message
    await runCmd('bot');

    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('LLM'));
    // Second message still processed
    expect(mockPushReply).toHaveBeenCalledTimes(1);
  });
});

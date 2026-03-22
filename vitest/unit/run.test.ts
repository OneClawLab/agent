import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { path } from '../../src/repo-utils/path.js';

// ── Mocks (must be hoisted before any imports of the mocked modules) ──────────

vi.mock('../../src/repo-utils/os.js', () => ({
  execCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

vi.mock('../../src/runner/inbox.js', () => ({
  consumeMessages: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../src/runner/router.js', () => ({
  routeMessage: vi.fn().mockResolvedValue({ threadPath: '/tmp/thread', isNew: false }),
}));

vi.mock('../../src/runner/llm.js', () => ({
  invokeLlm: vi.fn().mockResolvedValue({ reply: 'Hello!' }),
  buildSessionFilePath: vi.fn((agentDir: string, threadId: string) => `${agentDir}/sessions/${threadId}.jsonl`),
}));

vi.mock('../../src/runner/recorder.js', () => ({
  pushMessage: vi.fn().mockResolvedValue('evt-1'),
  pushReply: vi.fn().mockResolvedValue('evt-2'),
  pushRecord: vi.fn().mockResolvedValue('evt-3'),
}));

const mockLogInfo = vi.fn();
const mockLogError = vi.fn();
vi.mock('../../src/repo-utils/logger.js', () => ({
  createFireAndForgetLogger: vi.fn(() => ({ info: mockLogInfo, error: mockLogError, debug: vi.fn(), warn: vi.fn(), close: vi.fn().mockResolvedValue(undefined) })),
}));

vi.mock('../../src/identity.js', () => ({
  buildSystemPrompt: vi.fn().mockResolvedValue('# Identity\nYou are a test agent.'),
}));

vi.mock('../../src/errors.js', () => ({
  withRetry: vi.fn(async (fn: () => Promise<unknown>) => fn()),
}));

// Mock homedir so agent dirs land in a tmp directory
let tmpBase: string;
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => tmpBase };
});

let stdoutSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true); });
afterEach(() => { stdoutSpy.mockRestore(); });

// ── Import mocked modules ─────────────────────────────────────────────────────

import { execCommand } from '../../src/repo-utils/os.js';
import { consumeMessages } from '../../src/runner/inbox.js';
import { routeMessage } from '../../src/runner/router.js';
import { invokeLlm } from '../../src/runner/llm.js';
import { pushMessage, pushReply, pushRecord } from '../../src/runner/recorder.js';
import { buildSystemPrompt } from '../../src/identity.js';
import { withRetry } from '../../src/errors.js';

const mockExecCommand = vi.mocked(execCommand);
const mockConsumeMessages = vi.mocked(consumeMessages);
const mockRouteMessage = vi.mocked(routeMessage);
const mockInvokeLlm = vi.mocked(invokeLlm);
const mockPushMessage = vi.mocked(pushMessage);
const mockPushReply = vi.mocked(pushReply);
const mockPushRecord = vi.mocked(pushRecord);
const mockBuildSystemPrompt = vi.mocked(buildSystemPrompt);
const mockWithRetry = vi.mocked(withRetry);

// Import AFTER mocks
const { runCmd } = await import('../../src/commands/run.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function agentDir(id: string) {
  return path.join(tmpBase, '.theclaw', 'agents', id);
}

async function createAgent(id: string) {
  const dir = agentDir(id);
  await mkdir(path.join(dir, 'logs'), { recursive: true });
  await mkdir(path.join(dir, 'sessions'), { recursive: true });
  await mkdir(path.join(dir, 'memory'), { recursive: true });
  await writeFile(path.join(dir, 'IDENTITY.md'), `# ${id}\nYou are ${id}.\n`);
  await writeFile(
    path.join(dir, 'config.yaml'),
    `agent_id: ${id}\nkind: user\npai:\n  provider: openai\n  model: gpt-4o\ninbox:\n  path: ${path.join(dir, 'inbox')}\nrouting:\n  default: per-peer\noutbound: []\nretry:\n  max_attempts: 3\n`
  );
  return dir;
}

function makeMessage(overrides: Record<string, unknown> = {}) {
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
  tmpBase = path.resolve(await mkdtemp(path.join(path.resolve(tmpdir()), 'agent-run-test-')));
  vi.clearAllMocks();
  // Restore default mock implementations after clearAllMocks
  mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' });
  mockConsumeMessages.mockResolvedValue([]);
  mockRouteMessage.mockResolvedValue({ threadPath: path.join(tmpBase, 'thread'), isNew: false });
  mockInvokeLlm.mockResolvedValue({ reply: 'Hello!' });
  mockPushMessage.mockResolvedValue('evt-1');
  mockPushReply.mockResolvedValue('evt-2');
  mockPushRecord.mockResolvedValue('evt-3');
  mockBuildSystemPrompt.mockResolvedValue('# Identity\nYou are a test agent.');
  mockWithRetry.mockImplementation(async (fn) => fn());
});

afterEach(async () => {
  await rm(tmpBase, { recursive: true, force: true });
});

// ── Agent not found ───────────────────────────────────────────────────────────

describe('runCmd - agent not found', () => {
  it('exits with code 1 when agent directory does not exist', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await expect(runCmd('ghost')).rejects.toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('ghost'));
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

// ── File lock ─────────────────────────────────────────────────────────────────

describe('runCmd - file lock', () => {
  it('exits with code 1 when run.lock already exists', async () => {
    const dir = await createAgent('myagent');
    await writeFile(path.join(dir, 'run.lock'), '9999');

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await expect(runCmd('myagent')).rejects.toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('already running'));
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('creates run.lock during execution', async () => {
    const dir = await createAgent('myagent');
    let lockExistedDuringRun = false;

    mockConsumeMessages.mockImplementation(async () => {
      lockExistedDuringRun = existsSync(path.join(dir, 'run.lock'));
      return [];
    });

    await runCmd('myagent');

    expect(lockExistedDuringRun).toBe(true);
  });

  it('removes run.lock after successful run', async () => {
    const dir = await createAgent('myagent');
    mockConsumeMessages.mockResolvedValue([]);

    await runCmd('myagent');

    expect(existsSync(path.join(dir, 'run.lock'))).toBe(false);
  });

  it('removes run.lock even when an error occurs', async () => {
    const dir = await createAgent('myagent');
    mockConsumeMessages.mockRejectedValue(new Error('inbox error'));

    await expect(runCmd('myagent')).rejects.toThrow('inbox error');

    expect(existsSync(path.join(dir, 'run.lock'))).toBe(false);
  });
});

// ── No messages ───────────────────────────────────────────────────────────────

describe('runCmd - no messages', () => {
  it('exits cleanly with no processing when inbox is empty', async () => {
    await createAgent('myagent');
    mockConsumeMessages.mockResolvedValue([]);

    await runCmd('myagent');

    expect(mockInvokeLlm).not.toHaveBeenCalled();
    expect(mockPushMessage).not.toHaveBeenCalled();
  });

  it('logs that no messages were found', async () => {
    await createAgent('myagent');
    mockConsumeMessages.mockResolvedValue([]);

    await runCmd('myagent');

    expect(mockLogInfo).toHaveBeenCalledWith(expect.stringContaining('No new'));
  });
});

// ── Message processing ────────────────────────────────────────────────────────

describe('runCmd - message processing', () => {
  it('calls consumeMessages with inbox path and consumer id', async () => {
    const dir = await createAgent('myagent');
    await runCmd('myagent');

    expect(mockConsumeMessages).toHaveBeenCalledWith(
      path.join(dir, 'inbox'),
      'inbox'
    );
  });

  it('routes each message via routeMessage', async () => {
    await createAgent('myagent');
    mockConsumeMessages.mockResolvedValue([makeMessage()]);

    await runCmd('myagent');

    expect(mockRouteMessage).toHaveBeenCalledWith(
      expect.any(String),
      'per-peer',
      'telegram',
      'user42'
    );
  });

  it('pushes inbound message to thread preserving original source', async () => {
    await createAgent('myagent');
    const msg = makeMessage();
    mockConsumeMessages.mockResolvedValue([msg]);

    await runCmd('myagent');

    expect(mockPushMessage).toHaveBeenCalledWith(
      expect.any(String),
      'xgw:telegram:user42',
      msg.content
    );
  });

  it('builds system prompt with peerId and threadId', async () => {
    await createAgent('myagent');
    mockConsumeMessages.mockResolvedValue([makeMessage()]);
    mockRouteMessage.mockResolvedValue({ threadPath: path.join(tmpBase, 'threads', 'peers', 'telegram-user42'), isNew: false });

    await runCmd('myagent');

    expect(mockBuildSystemPrompt).toHaveBeenCalledWith(
      expect.any(String),
      'user42',
      'telegram-user42'
    );
  });

  it('invokes LLM with correct params', async () => {
    const dir = await createAgent('myagent');
    const threadPath = path.join(dir, 'threads', 'peers', 'telegram-user42');
    mockConsumeMessages.mockResolvedValue([makeMessage()]);
    mockRouteMessage.mockResolvedValue({ threadPath, isNew: false });

    await runCmd('myagent');

    expect(mockWithRetry).toHaveBeenCalled();
    expect(mockInvokeLlm).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'openai',
      model: 'gpt-4o',
      userMessage: 'Hello agent',
    }));
  });

  it('pushes reply with reply_context', async () => {
    await createAgent('myagent');
    mockConsumeMessages.mockResolvedValue([makeMessage()]);
    mockInvokeLlm.mockResolvedValue({ reply: 'Hi there!' });

    await runCmd('myagent');

    expect(mockPushReply).toHaveBeenCalledWith(
      expect.any(String),
      'Hi there!',
      expect.objectContaining({ channel_id: 'telegram', peer_id: 'user42' })
    );
  });

  it('processes multiple messages in sequence', async () => {
    await createAgent('myagent');
    const msgs = [makeMessage(), makeMessage({ eventId: 'evt-2' })];
    mockConsumeMessages.mockResolvedValue(msgs);

    await runCmd('myagent');

    expect(mockInvokeLlm).toHaveBeenCalledTimes(2);
    expect(mockPushReply).toHaveBeenCalledTimes(2);
  });
});

// ── Toolcalls ─────────────────────────────────────────────────────────────────

describe('runCmd - toolcalls', () => {
  it('pushes toolcall records when LLM returns toolCalls', async () => {
    await createAgent('myagent');
    mockConsumeMessages.mockResolvedValue([makeMessage()]);
    mockInvokeLlm.mockResolvedValue({
      reply: 'Using tool',
      toolCalls: [{ name: 'search', arguments: { q: 'test' } }],
    });

    await runCmd('myagent');

    expect(mockPushRecord).toHaveBeenCalledWith(
      expect.any(String),
      'toolcall',
      'self',
      expect.objectContaining({ name: 'search' })
    );
  });

  it('pushes one record per toolcall', async () => {
    await createAgent('myagent');
    mockConsumeMessages.mockResolvedValue([makeMessage()]);
    mockInvokeLlm.mockResolvedValue({
      reply: 'Using tools',
      toolCalls: [
        { name: 'search', arguments: { q: 'a' } },
        { name: 'fetch', arguments: { url: 'http://x' } },
      ],
    });

    await runCmd('myagent');

    const toolcallCalls = mockPushRecord.mock.calls.filter(([, subtype]) => subtype === 'toolcall');
    expect(toolcallCalls).toHaveLength(2);
  });

  it('does not push toolcall records when LLM returns no toolCalls', async () => {
    await createAgent('myagent');
    mockConsumeMessages.mockResolvedValue([makeMessage()]);
    mockInvokeLlm.mockResolvedValue({ reply: 'Plain reply' });

    await runCmd('myagent');

    const toolcallCalls = mockPushRecord.mock.calls.filter(([, subtype]) => subtype === 'toolcall');
    expect(toolcallCalls).toHaveLength(0);
  });
});

// ── New thread outbound consumer ──────────────────────────────────────────────

describe('runCmd - outbound consumer registration', () => {
  it('registers outbound consumer when thread is new', async () => {
    await createAgent('myagent');
    const threadPath = path.join(tmpBase, 'threads', 'peers', 'telegram-user42');
    mockConsumeMessages.mockResolvedValue([makeMessage()]);
    mockRouteMessage.mockResolvedValue({ threadPath, isNew: true });

    await runCmd('myagent');

    expect(mockExecCommand).toHaveBeenCalledWith('thread', expect.arrayContaining([
      'subscribe',
      '--thread', threadPath,
      '--consumer', 'outbound',
    ]));
  });

  it('does NOT register outbound consumer for existing thread', async () => {
    await createAgent('myagent');
    const threadPath = path.join(tmpBase, 'threads', 'peers', 'telegram-user42');
    mockConsumeMessages.mockResolvedValue([makeMessage()]);
    mockRouteMessage.mockResolvedValue({ threadPath, isNew: false });

    await runCmd('myagent');

    const subscribeCalls = mockExecCommand.mock.calls.filter(
      ([, args]) => (args as string[]).includes('subscribe')
    );
    expect(subscribeCalls).toHaveLength(0);
  });

  it('outbound consumer handler includes thread path', async () => {
    await createAgent('myagent');
    const threadPath = path.join(tmpBase, 'threads', 'peers', 'telegram-user42');
    mockConsumeMessages.mockResolvedValue([makeMessage()]);
    mockRouteMessage.mockResolvedValue({ threadPath, isNew: true });

    await runCmd('myagent');

    const subscribeCall = mockExecCommand.mock.calls.find(
      ([, args]) => (args as string[]).includes('subscribe')
    );
    expect(subscribeCall).toBeDefined();
    const args = subscribeCall![1] as string[];
    const handlerIdx = args.indexOf('--handler');
    expect(args[handlerIdx + 1]).toContain(threadPath);
  });

  it('outbound consumer uses filter for self messages only', async () => {
    await createAgent('myagent');
    const threadPath = path.join(tmpBase, 'threads', 'peers', 'telegram-user42');
    mockConsumeMessages.mockResolvedValue([makeMessage()]);
    mockRouteMessage.mockResolvedValue({ threadPath, isNew: true });

    await runCmd('myagent');

    const subscribeCall = mockExecCommand.mock.calls.find(
      ([, args]) => (args as string[]).includes('subscribe')
    );
    const args = subscribeCall![1] as string[];
    const filterIdx = args.indexOf('--filter');
    expect(args[filterIdx + 1]).toContain('source=self');
  });
});

// ── Error handling ────────────────────────────────────────────────────────────

describe('runCmd - error handling', () => {
  it('writes error record and continues when LLM fails non-recoverably', async () => {
    await createAgent('myagent');
    const msgs = [makeMessage({ eventId: 'e1' }), makeMessage({ eventId: 'e2' })];
    mockConsumeMessages.mockResolvedValue(msgs);

    // withRetry re-throws the error
    mockWithRetry.mockRejectedValueOnce(new Error('auth failed'));
    // second message succeeds
    mockWithRetry.mockImplementationOnce(async (fn) => fn());

    await runCmd('myagent');

    // Error record pushed for first message
    const errorCalls = mockPushRecord.mock.calls.filter(([, subtype]) => subtype === 'error');
    expect(errorCalls).toHaveLength(1);

    // Second message still processed
    expect(mockPushReply).toHaveBeenCalledTimes(1);
  });

  it('logs LLM errors', async () => {
    await createAgent('myagent');
    mockConsumeMessages.mockResolvedValue([makeMessage()]);
    mockWithRetry.mockRejectedValue(new Error('LLM down'));

    await runCmd('myagent');

    expect(mockLogError).toHaveBeenCalledWith(expect.stringContaining('LLM'));
  });
});

// ── Logging ───────────────────────────────────────────────────────────────────

describe('runCmd - logging', () => {
  it('logs run start', async () => {
    await createAgent('myagent');
    await runCmd('myagent');
    expect(mockLogInfo).toHaveBeenCalledWith(expect.stringContaining('run started'));
  });

  it('logs run completion with message count', async () => {
    await createAgent('myagent');
    mockConsumeMessages.mockResolvedValue([makeMessage()]);

    await runCmd('myagent');

    expect(mockLogInfo).toHaveBeenCalledWith(expect.stringContaining('completed'));
  });

  it('logs routing decision', async () => {
    await createAgent('myagent');
    mockConsumeMessages.mockResolvedValue([makeMessage()]);

    await runCmd('myagent');

    expect(mockLogInfo).toHaveBeenCalledWith(expect.stringContaining('Routed'));
  });
});

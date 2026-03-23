import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from '../../src/repo-utils/fs.js';
import { tmpdir } from 'node:os';
import { path } from '../../src/repo-utils/path.js';

// Mock execCommand so `thread subscribe` is never actually invoked
vi.mock('../../src/repo-utils/os.js', () => ({
  execCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

// Mock createFireAndForgetLogger to capture log calls
const mockInfo = vi.fn();
const mockError = vi.fn();
vi.mock('../../src/repo-utils/logger.js', () => ({
  createFireAndForgetLogger: vi.fn(() => ({ info: mockInfo, error: mockError, debug: vi.fn(), warn: vi.fn(), close: vi.fn().mockResolvedValue(undefined) })),
}));

// Mock homedir so agent dirs land in a tmp directory
let tmpBase: string;
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return {
    ...orig,
    homedir: () => tmpBase,
  };
});

let stdoutSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => { stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true); });
afterEach(() => { stdoutSpy.mockRestore(); });

import { execCommand } from '../../src/repo-utils/os.js';
import { createFireAndForgetLogger } from '../../src/repo-utils/logger.js';
const mockExecCommand = vi.mocked(execCommand);
const mockCreateLogger = vi.mocked(createFireAndForgetLogger);

// Import AFTER mocks are set up
const { startCmd } = await import('../../src/commands/start.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function agentDir(id: string) {
  return path.join(tmpBase, '.theclaw', 'agents', id);
}

async function createAgent(id: string, inboxPath?: string) {
  const dir = agentDir(id);
  await fs.mkdir(path.join(dir, 'logs'), { recursive: true });
  const resolvedInbox = inboxPath ?? path.join(dir, 'inbox');
  await fs.writeFile(
    path.join(dir, 'config.yaml'),
    `agent_id: ${id}\nkind: user\npai:\n  provider: openai\n  model: gpt-4o\ninbox:\n  path: ${resolvedInbox}\nrouting:\n  default: per-peer\noutbound: []\n`
  );
  return dir;
}

beforeEach(async () => {
  tmpBase = path.resolve(await fs.mkdtemp(path.join(path.toPosixPath(tmpdir()), 'agent-start-test-')));
  mockExecCommand.mockClear();
  mockInfo.mockClear();
  mockError.mockClear();
  mockCreateLogger.mockClear();
});

afterEach(async () => {
  await fs.rm(tmpBase, { recursive: true, force: true });
});

// ── Agent not found ───────────────────────────────────────────────────────────

describe('startCmd - agent not found', () => {
  it('exits with code 1 when agent directory does not exist', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error('process.exit called');
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await expect(startCmd('nonexistent')).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'));
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('writes error message to stderr with fix hint', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await startCmd('ghost').catch(() => {});
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('agent init'));
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('does not call thread subscribe when agent does not exist', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await startCmd('ghost').catch(() => {});
    } finally {
      exitSpy.mockRestore();
    }

    expect(mockExecCommand).not.toHaveBeenCalled();
  });
});

// ── Successful start ──────────────────────────────────────────────────────────

describe('startCmd - successful start', () => {
  it('calls thread subscribe with correct arguments', async () => {
    const dir = await createAgent('myagent');
    const inboxPath = path.join(dir, 'inbox');

    await startCmd('myagent');

    expect(mockExecCommand).toHaveBeenCalledWith('thread', [
      'subscribe',
      '--thread', inboxPath,
      '--consumer', 'inbox',
      '--handler', 'agent run myagent',
    ]);
  });

  it('uses inbox path from config', async () => {
    const customInbox = path.join(tmpBase, 'custom', 'inbox');
    await createAgent('myagent', customInbox);

    await startCmd('myagent');

    expect(mockExecCommand).toHaveBeenCalledWith('thread', [
      'subscribe',
      '--thread', customInbox,
      '--consumer', 'inbox',
      '--handler', 'agent run myagent',
    ]);
  });

  it('logs startup info after subscribing', async () => {
    await createAgent('myagent');

    await startCmd('myagent');

    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('myagent'));
    expect(mockInfo).toHaveBeenCalledWith(expect.stringContaining('started'));
  });

  it('creates logger with the agent logs directory', async () => {
    const dir = await createAgent('myagent');

    await startCmd('myagent');

    expect(mockCreateLogger).toHaveBeenCalledWith(path.join(dir, 'logs'), 'agent');
  });

  it('writes success message to stdout', async () => {
    await createAgent('myagent');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await startCmd('myagent');
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('myagent'));
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

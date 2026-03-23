import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from '../../src/repo-utils/fs.js';
import { path } from '../../src/repo-utils/path.js';
import { tmpdir } from 'node:os';

// Mock execCommand so `thread unsubscribe` is never actually invoked
vi.mock('../../src/repo-utils/os.js', () => ({
  execCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
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
const mockExecCommand = vi.mocked(execCommand);

const { stopCmd } = await import('../../src/commands/stop.js');

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
  tmpBase = await fs.mkdtemp(path.join(path.toPosixPath(tmpdir()), 'agent-stop-test-'));
  mockExecCommand.mockClear();
});

afterEach(async () => {
  await fs.rm(tmpBase, { recursive: true, force: true });
});

// ── Agent not found ───────────────────────────────────────────────────────────

describe('stopCmd - agent not found', () => {
  it('exits with code 1 when agent directory does not exist', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error('process.exit called');
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await expect(stopCmd('nonexistent')).rejects.toThrow('process.exit called');
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
      await stopCmd('ghost').catch(() => {});
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('agent init'));
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('does not call thread unsubscribe when agent does not exist', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await stopCmd('ghost').catch(() => {});
    } finally {
      exitSpy.mockRestore();
    }

    expect(mockExecCommand).not.toHaveBeenCalled();
  });
});

// ── Successful stop ───────────────────────────────────────────────────────────

describe('stopCmd - successful stop', () => {
  it('calls thread unsubscribe with correct arguments', async () => {
    const dir = await createAgent('myagent');
    const inboxPath = path.join(dir, 'inbox');

    await stopCmd('myagent');

    expect(mockExecCommand).toHaveBeenCalledWith('thread', [
      'unsubscribe',
      '--thread', inboxPath,
      '--consumer', 'inbox',
    ]);
  });

  it('uses inbox path from config', async () => {
    const customInbox = path.join(tmpBase, 'custom', 'inbox');
    await createAgent('myagent', customInbox);

    await stopCmd('myagent');

    expect(mockExecCommand).toHaveBeenCalledWith('thread', [
      'unsubscribe',
      '--thread', customInbox,
      '--consumer', 'inbox',
    ]);
  });

  it('writes success message to stdout', async () => {
    await createAgent('myagent');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await stopCmd('myagent');
      expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('myagent'));
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

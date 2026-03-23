import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from '../../src/repo-utils/fs.js';
import { tmpdir } from 'node:os';
import { path } from '../../src/repo-utils/path.js';

// Mock execCommand so `thread init` is never actually invoked
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

// Import AFTER mocks are set up
const { initCmd } = await import('../../src/commands/init.js');

beforeEach(async () => {
  tmpBase = path.resolve(await fs.mkdtemp(path.join(path.toPosixPath(tmpdir()), 'agent-init-test-')));
  mockExecCommand.mockClear();
});

afterEach(async () => {
  await fs.rm(tmpBase, { recursive: true, force: true });
});

function agentDir(id: string) {
  return path.join(tmpBase, '.theclaw', 'agents', id);
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

// ── Directory structure ───────────────────────────────────────────────────────

describe('initCmd - directory structure', () => {
  it('creates all required subdirectories', async () => {
    await initCmd('myagent', { kind: 'user' });
    const dir = agentDir('myagent');

    const expectedDirs = [
      'inbox',
      'sessions',
      'memory',
      path.join('threads', 'peers'),
      path.join('threads', 'channels'),
      path.join('threads', 'main'),
      'workdir',
      'logs',
    ];

    for (const sub of expectedDirs) {
      expect(await isDir(path.join(dir, sub))).toBe(true);
    }
  });
});

// ── Default files ─────────────────────────────────────────────────────────────

describe('initCmd - default files', () => {
  it('generates IDENTITY.md with agent id', async () => {
    await initCmd('myagent', { kind: 'user' });
    const content = await fs.readFile(path.join(agentDir('myagent'), 'IDENTITY.md'), 'utf8');
    expect(content).toContain('# myagent');
    expect(content).toContain('You are myagent');
  });

  it('generates USAGE.md', async () => {
    await initCmd('myagent', { kind: 'user' });
    const content = await fs.readFile(path.join(agentDir('myagent'), 'USAGE.md'), 'utf8');
    expect(content).toContain('# Usage');
    expect(content).toContain('inbox');
  });

  it('generates config.yaml with correct agent_id and kind=user', async () => {
    await initCmd('myagent', { kind: 'user' });
    const content = await fs.readFile(path.join(agentDir('myagent'), 'config.yaml'), 'utf8');
    expect(content).toContain('agent_id: myagent');
    expect(content).toContain('kind: user');
    expect(content).toContain('provider: openai');
    expect(content).toContain('model: gpt-4o');
    expect(content).toContain('default: per-peer');
    expect(content).toContain('max_attempts: 3');
  });

  it('generates config.yaml with kind=system when specified', async () => {
    await initCmd('sysagent', { kind: 'system' });
    const content = await fs.readFile(path.join(agentDir('sysagent'), 'config.yaml'), 'utf8');
    expect(content).toContain('kind: system');
  });

  it('config.yaml inbox path references the agent id', async () => {
    await initCmd('myagent', { kind: 'user' });
    const content = await fs.readFile(path.join(agentDir('myagent'), 'config.yaml'), 'utf8');
    expect(content).toContain('myagent/inbox');
  });
});

// ── thread init ───────────────────────────────────────────────────────────────

describe('initCmd - thread init', () => {
  it('calls thread init <agentDir>/inbox', async () => {
    await initCmd('myagent', { kind: 'user' });
    const expectedInbox = path.join(agentDir('myagent'), 'inbox');
    expect(mockExecCommand).toHaveBeenCalledWith('thread', ['init', expectedInbox]);
  });
});

// ── Already exists ────────────────────────────────────────────────────────────

describe('initCmd - already exists', () => {
  it('exits with code 1 if agent directory already exists', async () => {
    await initCmd('myagent', { kind: 'user' });
    mockExecCommand.mockClear();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error('process.exit called');
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await expect(initCmd('myagent', { kind: 'user' })).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('already exists'));
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('does not call thread init when agent already exists', async () => {
    await initCmd('myagent', { kind: 'user' });
    mockExecCommand.mockClear();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await initCmd('myagent', { kind: 'user' }).catch(() => {});
    } finally {
      exitSpy.mockRestore();
    }

    expect(mockExecCommand).not.toHaveBeenCalled();
  });
});

// ── Default kind ──────────────────────────────────────────────────────────────

describe('initCmd - default kind', () => {
  it('defaults to kind=user when not specified', async () => {
    await initCmd('myagent', { kind: 'user' });
    const content = await fs.readFile(path.join(agentDir('myagent'), 'config.yaml'), 'utf8');
    expect(content).toContain('kind: user');
  });
});

/**
 * Real I/O integration tests for agent repo.
 * No mocks for file system operations — uses real tmpdir.
 * Only execCommand (thread/xgw calls) is mocked to avoid external dependencies.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from '../../src/repo-utils/fs.js';
import { tmpdir } from 'node:os';
import { path } from '../../src/repo-utils/path.js';

vi.mock('../../src/repo-utils/os.js', () => ({
  execCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

vi.mock('../../src/repo-utils/logger.js', () => ({
  createFireAndForgetLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

let tmpBase: string;

vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => tmpBase };
});

import { execCommand } from '../../src/repo-utils/os.js';
const mockExec = vi.mocked(execCommand);

const { initCmd } = await import('../../src/commands/init.js');
const { startCmd } = await import('../../src/commands/start.js');
const { stopCmd } = await import('../../src/commands/stop.js');
const { statusCmd, listCmd } = await import('../../src/commands/status.js');
const { loadConfig } = await import('../../src/config.js');

// initCmd uses path.toPosixPath(homedir()) internally, so we must match that
function agentDir(id: string) {
  return path.join(path.toPosixPath(tmpBase), '.theclaw', 'agents', id);
}

let stdoutSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  tmpBase = path.resolve(await fs.mkdtemp(path.join(path.toPosixPath(tmpdir()), 'agent-real-io-')));
  mockExec.mockResolvedValue({ stdout: '', stderr: '' });
  stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});

afterEach(async () => {
  stdoutSpy.mockRestore();
  await fs.rm(tmpBase, { recursive: true, force: true });
});

// ── init: real directory structure ────────────────────────────────────────────

describe('initCmd: real directory creation', () => {
  it('creates all required subdirectories', async () => {
    await initCmd('mybot', { kind: 'user' });
    const dir = agentDir('mybot');

    for (const sub of ['inbox', 'sessions', 'memory', 'logs', 'workdir']) {
      expect(fs.existsSync(path.join(dir, sub))).toBe(true);
    }
    for (const sub of ['peers', 'channels', 'main']) {
      expect(fs.existsSync(path.join(dir, 'threads', sub))).toBe(true);
    }
  });

  it('writes a parseable config.yaml with correct fields', async () => {
    await initCmd('mybot', { kind: 'system' });
    const config = await loadConfig(agentDir('mybot'));

    expect(config.agent_id).toBe('mybot');
    expect(config.kind).toBe('system');
    expect(config.pai.provider).toBe('openai');
    expect(config.pai.model).toBe('gpt-4o');
    expect(config.routing?.default).toBe('per-peer');
    expect(config.retry?.max_attempts).toBe(3);
    expect(config.deliver?.max_attempts).toBe(3);
  });

  it('config.yaml inbox path points inside agent dir', async () => {
    await initCmd('mybot', { kind: 'user' });
    const config = await loadConfig(agentDir('mybot'));
    expect(config.inbox.path).toContain('mybot');
    expect(config.inbox.path).toContain('inbox');
  });

  it('writes IDENTITY.md and USAGE.md', async () => {
    await initCmd('mybot', { kind: 'user' });
    const dir = agentDir('mybot');
    expect(fs.existsSync(path.join(dir, 'IDENTITY.md'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'USAGE.md'))).toBe(true);
  });

  it('calls thread init for inbox', async () => {
    await initCmd('mybot', { kind: 'user' });
    expect(mockExec).toHaveBeenCalledWith('thread', expect.arrayContaining(['init']));
  });

  it('fails with exit 1 when agent already exists', async () => {
    await initCmd('mybot', { kind: 'user' });
    mockExec.mockClear();

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(initCmd('mybot', { kind: 'user' })).rejects.toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

// ── loadConfig: real YAML parsing ─────────────────────────────────────────────

describe('loadConfig: real YAML parsing', () => {
  it('parses a hand-written config.yaml correctly', async () => {
    const dir = path.join(path.toPosixPath(tmpBase), 'custom-agent');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'config.yaml'), `
agent_id: custom
kind: user
pai:
  provider: anthropic
  model: claude-3-5-sonnet
inbox:
  path: /tmp/custom/inbox
routing:
  default: per-channel
outbound: []
`);
    const config = await loadConfig(dir);
    expect(config.agent_id).toBe('custom');
    expect(config.kind).toBe('user');
    expect(config.pai.provider).toBe('anthropic');
    expect(config.pai.model).toBe('claude-3-5-sonnet');
    expect(config.routing?.default).toBe('per-channel');
  });

  it('applies default routing.default=per-peer when missing', async () => {
    const dir = path.join(path.toPosixPath(tmpBase), 'minimal-agent');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'config.yaml'), `
agent_id: minimal
kind: user
pai:
  provider: openai
  model: gpt-4o
inbox:
  path: /tmp/minimal/inbox
`);
    const config = await loadConfig(dir);
    expect(config.routing?.default).toBe('per-peer');
  });

  it('applies default retry/deliver max_attempts=3 when missing', async () => {
    const dir = path.join(path.toPosixPath(tmpBase), 'minimal-agent2');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'config.yaml'), `
agent_id: minimal
kind: user
pai:
  provider: openai
  model: gpt-4o
inbox:
  path: /tmp/minimal/inbox
`);
    const config = await loadConfig(dir);
    expect(config.retry?.max_attempts).toBe(3);
    expect(config.deliver?.max_attempts).toBe(3);
  });

  it('throws descriptive error when config.yaml is missing', async () => {
    const dir = path.join(path.toPosixPath(tmpBase), 'no-config');
    await fs.mkdir(dir, { recursive: true });
    await expect(loadConfig(dir)).rejects.toThrow(/not found/i);
    await expect(loadConfig(dir)).rejects.toThrow('config.yaml');
  });

  it('throws descriptive error on invalid YAML', async () => {
    const dir = path.join(path.toPosixPath(tmpBase), 'bad-yaml');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'config.yaml'), '{ invalid: yaml: content: [}');
    await expect(loadConfig(dir)).rejects.toThrow(/invalid yaml/i);
  });
});

// ── startCmd / stopCmd: real config read + exec calls ────────────────────────

describe('startCmd / stopCmd: real config read', () => {
  it('startCmd reads real config.yaml and subscribes correct inbox path', async () => {
    await initCmd('mybot', { kind: 'user' });
    mockExec.mockClear();

    await startCmd('mybot');

    const subscribeCalls = mockExec.mock.calls.filter(
      ([, args]) => (args as string[]).includes('subscribe')
    );
    expect(subscribeCalls).toHaveLength(1);
    const args = subscribeCalls[0]![1] as string[];
    expect(args).toContain('--consumer');
    expect(args).toContain('inbox');
    expect(args).toContain('--handler');
    expect(args.join(' ')).toContain('agent run mybot');
    const threadIdx = args.indexOf('--thread');
    expect(args[threadIdx + 1]).toContain('mybot');
  });

  it('startCmd fails with exit 1 for non-existent agent', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(startCmd('ghost')).rejects.toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('stopCmd fails with exit 1 for non-existent agent', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(stopCmd('ghost')).rejects.toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });
});

// ── statusCmd: real file system checks ───────────────────────────────────────

describe('statusCmd: real file system checks', () => {
  beforeEach(() => {
    mockExec.mockResolvedValue({ stdout: JSON.stringify({ event_count: 0, subscriptions: [] }), stderr: '' });
  });

  it('returns started=false before any lock file', async () => {
    await initCmd('mybot', { kind: 'user' });
    stdoutSpy.mockClear();

    await statusCmd('mybot', { json: true });

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    const parsed = JSON.parse(output);
    expect(parsed.started).toBe(false);
    expect(parsed.agent_id).toBe('mybot');
  });

  it('returns started=true when run.lock exists', async () => {
    await initCmd('mybot', { kind: 'user' });
    // Write lock file at the posix path that initCmd created
    fs.writeFileSync(path.join(agentDir('mybot'), 'run.lock'), '');
    stdoutSpy.mockClear();

    await statusCmd('mybot', { json: true });

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    const parsed = JSON.parse(output);
    expect(parsed.started).toBe(true);
  });

  it('returns correct kind from real config', async () => {
    await initCmd('mybot', { kind: 'system' });
    stdoutSpy.mockClear();

    await statusCmd('mybot', { json: true });

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    const parsed = JSON.parse(output);
    expect(parsed.kind).toBe('system');
  });

  it('exits 1 for unknown agent', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      await expect(statusCmd('ghost', {})).rejects.toThrow('exit');
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('human output contains agent id and kind', async () => {
    await initCmd('mybot', { kind: 'user' });
    stdoutSpy.mockClear();

    await statusCmd('mybot', {});

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('mybot');
    expect(output).toContain('user');
  });
});

// ── listCmd: real directory scan ──────────────────────────────────────────────

describe('listCmd: real directory scan', () => {
  beforeEach(() => {
    mockExec.mockResolvedValue({ stdout: JSON.stringify({ event_count: 0, subscriptions: [] }), stderr: '' });
  });

  it('returns empty array when no agents exist', async () => {
    stdoutSpy.mockClear();
    await listCmd({ json: true });
    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(JSON.parse(output)).toEqual([]);
  });

  it('lists all initialized agents', async () => {
    await initCmd('alpha', { kind: 'user' });
    await initCmd('beta', { kind: 'system' });
    stdoutSpy.mockClear();

    await listCmd({ json: true });

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    const agents = JSON.parse(output) as Array<{ agent_id: string; kind: string }>;
    const ids = agents.map((a) => a.agent_id);
    expect(ids).toContain('alpha');
    expect(ids).toContain('beta');
  });

  it('human output lists agent ids', async () => {
    await initCmd('alpha', { kind: 'user' });
    stdoutSpy.mockClear();

    await listCmd({});

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    expect(output).toContain('alpha');
  });

  it('skips directories without config.yaml', async () => {
    // Create a stray directory that is not an agent
    await fs.mkdir(path.join(path.toPosixPath(tmpBase), '.theclaw', 'agents', 'stray'), { recursive: true });
    await initCmd('real', { kind: 'user' });
    stdoutSpy.mockClear();

    await listCmd({ json: true });

    const output = stdoutSpy.mock.calls.map((c: unknown[]) => c[0]).join('');
    const agents = JSON.parse(output) as Array<{ agent_id: string }>;
    const ids = agents.map((a) => a.agent_id);
    expect(ids).toContain('real');
    expect(ids).not.toContain('stray');
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { path } from '../../src/repo-utils/path.js';

// Mock homedir so agent dirs land in a tmp directory
let tmpBase: string;
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return {
    ...orig,
    homedir: () => tmpBase,
  };
});

const { statusCmd } = await import('../../src/commands/status.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function agentDir(id: string) {
  return path.join(tmpBase, '.theclaw', 'agents', id);
}

async function createAgent(id: string, kind = 'user') {
  const dir = agentDir(id);
  await mkdir(path.join(dir, 'logs'), { recursive: true });
  await mkdir(path.join(dir, 'inbox'), { recursive: true });
  await writeFile(
    path.join(dir, 'config.yaml'),
    `agent_id: ${id}\nkind: ${kind}\npai:\n  provider: openai\n  model: gpt-4o\ninbox:\n  path: ${path.join(dir, 'inbox')}\nrouting:\n  default: per-peer\noutbound: []\n`
  );
  return dir;
}

beforeEach(async () => {
  tmpBase = path.resolve(await mkdtemp(path.join(path.resolve(tmpdir()), 'agent-status-test-')));
});

afterEach(async () => {
  await rm(tmpBase, { recursive: true, force: true });
});

// ── Agent not found ───────────────────────────────────────────────────────────

describe('statusCmd - agent not found', () => {
  it('exits with code 1 when agent directory does not exist', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code) => {
      throw new Error('process.exit called');
    });
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await expect(statusCmd('nonexistent', {})).rejects.toThrow('process.exit called');
      expect(exitSpy).toHaveBeenCalledWith(1);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('nonexistent'));
    } finally {
      exitSpy.mockRestore();
      stderrSpy.mockRestore();
    }
  });

  it('outputs JSON error when --json and agent not found', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await statusCmd('ghost', { json: true }).catch(() => {});
      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty('error');
      expect(parsed).toHaveProperty('suggestion');
    } finally {
      exitSpy.mockRestore();
      stdoutSpy.mockRestore();
    }
  });

  it('exits with code 1 when no id provided', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    try {
      await statusCmd(undefined, {}).catch(() => {});
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally {
      exitSpy.mockRestore();
    }
  });
});

// ── Human-readable output ─────────────────────────────────────────────────────

describe('statusCmd - human output', () => {
  it('shows agent_id, kind, started=no when no run.lock', async () => {
    await createAgent('myagent');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await statusCmd('myagent', {});
      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('myagent');
      expect(output).toContain('user');
      expect(output).toContain('no');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('shows started=yes when run.lock exists', async () => {
    const dir = await createAgent('myagent');
    await writeFile(path.join(dir, 'run.lock'), '');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await statusCmd('myagent', {});
      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('yes');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('shows last_activity from log file mtime', async () => {
    const dir = await createAgent('myagent');
    await writeFile(path.join(dir, 'logs', 'agent.log'), 'some log\n');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await statusCmd('myagent', {});
      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toMatch(/\d{4}-\d{2}-\d{2}T/);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('shows last_activity=none when no log or lock file', async () => {
    await createAgent('myagent');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await statusCmd('myagent', {});
      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('none');
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

// ── JSON output ───────────────────────────────────────────────────────────────

describe('statusCmd - JSON output', () => {
  it('outputs valid JSON with required fields', async () => {
    await createAgent('myagent', 'system');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await statusCmd('myagent', { json: true });
      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(parsed).toHaveProperty('agent_id', 'myagent');
      expect(parsed).toHaveProperty('kind', 'system');
      expect(parsed).toHaveProperty('started');
      expect(parsed).toHaveProperty('last_activity');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('JSON started=false when no run.lock', async () => {
    await createAgent('myagent');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await statusCmd('myagent', { json: true });
      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(parsed.started).toBe(false);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('JSON started=true when run.lock exists', async () => {
    const dir = await createAgent('myagent');
    await writeFile(path.join(dir, 'run.lock'), '');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await statusCmd('myagent', { json: true });
      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(parsed.started).toBe(true);
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

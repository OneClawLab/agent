import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from '../../src/repo-utils/fs.js';
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

const { listCmd } = await import('../../src/commands/status.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function agentsBase() {
  return path.join(tmpBase, '.theclaw', 'agents');
}

async function createAgent(id: string, kind = 'user') {
  const dir = path.join(agentsBase(), id);
  await fs.mkdir(path.join(dir, 'logs'), { recursive: true });
  await fs.mkdir(path.join(dir, 'inbox'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'config.yaml'),
    `agent_id: ${id}\nkind: ${kind}\npai:\n  provider: openai\n  model: gpt-4o\ninbox:\n  path: ${path.join(dir, 'inbox')}\nrouting:\n  default: per-peer\noutbound: []\n`
  );
  return dir;
}

beforeEach(async () => {
  tmpBase = path.resolve(await fs.mkdtemp(path.join(path.toPosixPath(tmpdir()), 'agent-list-test-')));
});

afterEach(async () => {
  await fs.rm(tmpBase, { recursive: true, force: true });
});

// ── Empty / no agents ─────────────────────────────────────────────────────────

describe('listCmd - no agents', () => {
  it('outputs "No agents found" when base dir does not exist', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await listCmd({});
      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('No agents found');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('outputs empty JSON array when --json and no agents', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await listCmd({ json: true });
      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(0);
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('outputs "No agents found" when base dir exists but is empty', async () => {
    await fs.mkdir(agentsBase(), { recursive: true });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await listCmd({});
      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('No agents found');
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

// ── Human-readable output ─────────────────────────────────────────────────────

describe('listCmd - human output', () => {
  it('lists a single agent with id and kind', async () => {
    await createAgent('alice', 'user');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await listCmd({});
      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('alice');
      expect(output).toContain('user');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('lists multiple agents one per line', async () => {
    await createAgent('alice', 'user');
    await createAgent('bob', 'system');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await listCmd({});
      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('alice');
      expect(output).toContain('bob');
      expect(output).toContain('system');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('skips directories without config.yaml', async () => {
    await createAgent('alice');
    await fs.mkdir(path.join(agentsBase(), 'orphan'), { recursive: true });
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await listCmd({});
      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      expect(output).toContain('alice');
      expect(output).not.toContain('orphan');
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

// ── JSON output ───────────────────────────────────────────────────────────────

describe('listCmd - JSON output', () => {
  it('outputs JSON array with agent_id and kind', async () => {
    await createAgent('alice', 'user');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await listCmd({ json: true });
      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(Array.isArray(parsed)).toBe(true);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]).toHaveProperty('agent_id', 'alice');
      expect(parsed[0]).toHaveProperty('kind', 'user');
    } finally {
      stdoutSpy.mockRestore();
    }
  });

  it('outputs JSON array with multiple agents', async () => {
    await createAgent('alice', 'user');
    await createAgent('bob', 'system');
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    try {
      await listCmd({ json: true });
      const output = stdoutSpy.mock.calls.map(c => c[0]).join('');
      const parsed = JSON.parse(output);
      expect(parsed).toHaveLength(2);
      const ids = parsed.map((a: { agent_id: string }) => a.agent_id);
      expect(ids).toContain('alice');
      expect(ids).toContain('bob');
    } finally {
      stdoutSpy.mockRestore();
    }
  });
});

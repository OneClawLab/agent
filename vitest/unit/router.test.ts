import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveThreadPath, routeMessage } from '../../src/runner/router.js';

// Mock execCommand so `thread init` is never actually invoked
vi.mock('../../src/os-utils.js', () => ({
  execCommand: vi.fn().mockResolvedValue({ stdout: '', stderr: '' }),
}));

import { execCommand } from '../../src/repo-utils/os.js';
const mockExecCommand = vi.mocked(execCommand);

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'agent-router-test-'));
  mockExecCommand.mockClear();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── resolveThreadPath ────────────────────────────────────────────────────────

describe('resolveThreadPath', () => {
  it('per-peer → threads/peers/<channelId>-<peerId>', () => {
    const result = resolveThreadPath('/agents/bot', 'per-peer', 'tg', 'user42');
    expect(result).toBe(join('/agents/bot', 'threads', 'peers', 'tg-user42'));
  });

  it('per-channel → threads/channels/<channelId>', () => {
    const result = resolveThreadPath('/agents/bot', 'per-channel', 'tg', 'user42');
    expect(result).toBe(join('/agents/bot', 'threads', 'channels', 'tg'));
  });

  it('per-agent → threads/main', () => {
    const result = resolveThreadPath('/agents/bot', 'per-agent', 'tg', 'user42');
    expect(result).toBe(join('/agents/bot', 'threads', 'main'));
  });

  it('per-agent ignores channelId and peerId', () => {
    const a = resolveThreadPath('/agents/bot', 'per-agent', 'ch1', 'p1');
    const b = resolveThreadPath('/agents/bot', 'per-agent', 'ch2', 'p2');
    expect(a).toBe(b);
  });

  it('per-channel ignores peerId', () => {
    const a = resolveThreadPath('/agents/bot', 'per-channel', 'ch1', 'p1');
    const b = resolveThreadPath('/agents/bot', 'per-channel', 'ch1', 'p2');
    expect(a).toBe(b);
  });

  it('per-peer distinguishes different peers on same channel', () => {
    const a = resolveThreadPath('/agents/bot', 'per-peer', 'ch1', 'p1');
    const b = resolveThreadPath('/agents/bot', 'per-peer', 'ch1', 'p2');
    expect(a).not.toBe(b);
  });
});

// ── routeMessage ─────────────────────────────────────────────────────────────

describe('routeMessage', () => {
  it('returns isNew=true and calls thread init when directory does not exist', async () => {
    const result = await routeMessage(tmpDir, 'per-peer', 'tg', 'user1');

    expect(result.isNew).toBe(true);
    expect(result.threadPath).toBe(join(tmpDir, 'threads', 'peers', 'tg-user1'));
    expect(mockExecCommand).toHaveBeenCalledOnce();
    expect(mockExecCommand).toHaveBeenCalledWith('thread', [
      'init',
      '--thread',
      join(tmpDir, 'threads', 'peers', 'tg-user1'),
    ]);
  });

  it('returns isNew=false and does NOT call thread init when directory exists', async () => {
    const threadPath = join(tmpDir, 'threads', 'peers', 'tg-user2');
    await mkdir(threadPath, { recursive: true });

    const result = await routeMessage(tmpDir, 'per-peer', 'tg', 'user2');

    expect(result.isNew).toBe(false);
    expect(result.threadPath).toBe(threadPath);
    expect(mockExecCommand).not.toHaveBeenCalled();
  });

  it('per-channel routes to channels/<channelId>', async () => {
    const result = await routeMessage(tmpDir, 'per-channel', 'slack', 'anyone');

    expect(result.threadPath).toBe(join(tmpDir, 'threads', 'channels', 'slack'));
    expect(result.isNew).toBe(true);
  });

  it('per-agent routes to threads/main', async () => {
    const result = await routeMessage(tmpDir, 'per-agent', 'any', 'any');

    expect(result.threadPath).toBe(join(tmpDir, 'threads', 'main'));
    expect(result.isNew).toBe(true);
  });

  it('second call to same thread returns isNew=false after directory is created', async () => {
    // Simulate first call creating the directory
    const threadPath = join(tmpDir, 'threads', 'main');
    await mkdir(threadPath, { recursive: true });

    const result = await routeMessage(tmpDir, 'per-agent', 'any', 'any');
    expect(result.isNew).toBe(false);
    expect(mockExecCommand).not.toHaveBeenCalled();
  });
});

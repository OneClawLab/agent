import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { deliverCmd } from '../../src/commands/deliver.js';

// Mock deliverBatch
vi.mock('../../src/runner/deliver.js', () => ({
  deliverBatch: vi.fn(),
}));

// Mock loadConfig
vi.mock('../../src/config.js', () => ({
  loadConfig: vi.fn(),
}));

// Mock createLogger
vi.mock('../../src/logger.js', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}));

import { deliverBatch } from '../../src/runner/deliver.js';
import { loadConfig } from '../../src/config.js';

const mockDeliverBatch = vi.mocked(deliverBatch);
const mockLoadConfig = vi.mocked(loadConfig);

// Capture process.exit and process.stderr
const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

beforeEach(() => {
  vi.clearAllMocks();
  mockDeliverBatch.mockResolvedValue(undefined);
});

describe('deliverCmd', () => {
  it('exits with code 1 when --thread is missing', async () => {
    await deliverCmd({ consumer: 'outbound' });
    expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('--thread'));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('calls deliverBatch with thread, consumer, and default maxAttempts=3 when config unavailable', async () => {
    mockLoadConfig.mockRejectedValue(new Error('no config'));

    await deliverCmd({ thread: '/tmp/some/thread', consumer: 'outbound' });

    expect(mockDeliverBatch).toHaveBeenCalledWith('/tmp/some/thread', 'outbound', 3);
  });

  it('uses default consumer "outbound" when --consumer is not provided', async () => {
    mockLoadConfig.mockRejectedValue(new Error('no config'));

    await deliverCmd({ thread: '/tmp/some/thread' });

    expect(mockDeliverBatch).toHaveBeenCalledWith('/tmp/some/thread', 'outbound', 3);
  });

  it('reads deliver.max_attempts from config when agent dir can be inferred', async () => {
    const threadPath = join(homedir(), '.theclaw', 'agents', 'mybot', 'threads', 'peers', 'tg-user1');

    mockLoadConfig.mockResolvedValue({
      agent_id: 'mybot',
      kind: 'user',
      pai: { provider: 'openai', model: 'gpt-4o' },
      inbox: { path: join(homedir(), '.theclaw', 'agents', 'mybot', 'inbox') },
      routing: { default: 'per-peer' },
      outbound: [],
      deliver: { max_attempts: 5 },
    });

    await deliverCmd({ thread: threadPath, consumer: 'outbound' });

    expect(mockDeliverBatch).toHaveBeenCalledWith(threadPath, 'outbound', 5);
  });

  it('falls back to maxAttempts=3 when deliver.max_attempts is not set in config', async () => {
    const threadPath = join(homedir(), '.theclaw', 'agents', 'mybot', 'threads', 'peers', 'tg-user1');

    mockLoadConfig.mockResolvedValue({
      agent_id: 'mybot',
      kind: 'user',
      pai: { provider: 'openai', model: 'gpt-4o' },
      inbox: { path: join(homedir(), '.theclaw', 'agents', 'mybot', 'inbox') },
      routing: { default: 'per-peer' },
      outbound: [],
      // no deliver field
    } as never);

    await deliverCmd({ thread: threadPath, consumer: 'outbound' });

    expect(mockDeliverBatch).toHaveBeenCalledWith(threadPath, 'outbound', 3);
  });

  it('does not throw when deliverBatch succeeds', async () => {
    mockLoadConfig.mockRejectedValue(new Error('no config'));
    await expect(deliverCmd({ thread: '/tmp/thread', consumer: 'outbound' })).resolves.toBeUndefined();
  });
});

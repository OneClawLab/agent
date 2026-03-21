import { describe, it, expect, vi, beforeEach } from 'vitest';
import { deliverBatch, execXgwSend, execThreadPush } from '../../src/runner/deliver.js';

vi.mock('../../src/os-utils.js', () => ({
  execCommand: vi.fn(),
}));

import { execCommand } from '../../src/repo-utils/os.js';
const mockExec = vi.mocked(execCommand);

const THREAD = '/agents/bot/threads/peers/tg-user1';
const CONSUMER = 'outbound';

const makeEvent = (id: string, channelType: 'external' | 'internal', extra: Record<string, unknown> = {}) => ({
  eventId: id,
  content: {
    text: 'hello',
    reply_context: {
      channel_type: channelType,
      channel_id: 'tg',
      peer_id: 'user1',
      source_agent_id: 'admin',
      ...extra,
    },
  },
});

beforeEach(() => {
  mockExec.mockClear();
  // Default: all commands succeed
  mockExec.mockResolvedValue({ stdout: '[]', stderr: '' });
});

// ─── execXgwSend ────────────────────────────────────────────────────────────

describe('execXgwSend', () => {
  it('calls xgw send with channel, peer, and text', async () => {
    const event = makeEvent('e1', 'external');
    mockExec.mockResolvedValue({ stdout: '', stderr: '' });

    await execXgwSend(event);

    expect(mockExec).toHaveBeenCalledWith('xgw', [
      'send',
      '--channel', 'tg',
      '--peer', 'user1',
      '--text', 'hello',
    ]);
  });

  it('throws when execCommand rejects', async () => {
    mockExec.mockRejectedValue(new Error('xgw failed'));
    await expect(execXgwSend(makeEvent('e1', 'external'))).rejects.toThrow('xgw failed');
  });
});

// ─── execThreadPush ──────────────────────────────────────────────────────────

describe('execThreadPush', () => {
  it('pushes to source agent inbox via thread push', async () => {
    const event = makeEvent('e1', 'internal');
    mockExec.mockResolvedValue({ stdout: 'evt-1', stderr: '' });

    await execThreadPush(event);

    const call = mockExec.mock.calls[0]!;
    const [cmd, args] = [call[0], call[1] as string[]];
    expect(cmd).toBe('thread');
    expect(args).toContain('push');
    expect(args).toContain('--type');
    expect(args).toContain('message');
    expect(args).toContain('--source');
    expect(args).toContain('self');
    // inbox path contains source_agent_id
    const threadIdx = args.indexOf('--thread');
    expect(args[threadIdx + 1]).toContain('admin');
  });

  it('throws when source_agent_id is missing', async () => {
    const event = {
      eventId: 'e1',
      content: {
        text: 'hi',
        reply_context: { channel_type: 'internal' as const, channel_id: 'ch', peer_id: 'p1' },
      },
    };
    await expect(execThreadPush(event)).rejects.toThrow('source_agent_id');
  });
});

// ─── deliverBatch ────────────────────────────────────────────────────────────

describe('deliverBatch', () => {
  it('pops events and ACKs after successful external delivery', async () => {
    const events = [makeEvent('e1', 'external')];
    mockExec
      .mockResolvedValueOnce({ stdout: JSON.stringify(events), stderr: '' }) // pop
      .mockResolvedValueOnce({ stdout: '', stderr: '' })                      // xgw send
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                     // ack

    await deliverBatch(THREAD, CONSUMER, 3);

    // pop call
    expect(mockExec).toHaveBeenNthCalledWith(1, 'thread', ['pop', '--thread', THREAD, '--consumer', CONSUMER]);
    // xgw send
    expect(mockExec).toHaveBeenNthCalledWith(2, 'xgw', ['send', '--channel', 'tg', '--peer', 'user1', '--text', 'hello']);
    // ack
    expect(mockExec).toHaveBeenNthCalledWith(3, 'thread', ['ack', '--thread', THREAD, '--consumer', CONSUMER, '--event-id', 'e1']);
  });

  it('pops events and ACKs after successful internal delivery', async () => {
    const events = [makeEvent('e2', 'internal')];
    mockExec
      .mockResolvedValueOnce({ stdout: JSON.stringify(events), stderr: '' }) // pop
      .mockResolvedValueOnce({ stdout: 'evt-x', stderr: '' })                // thread push
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                     // ack

    await deliverBatch(THREAD, CONSUMER, 3);

    const [cmd2] = mockExec.mock.calls[1]!;
    expect(cmd2).toBe('thread');
    // ack was called
    const call3 = mockExec.mock.calls[2]!;
    const [cmd3, args3] = [call3[0], call3[1] as string[]];
    expect(cmd3).toBe('thread');
    expect(args3).toContain('ack');
  });

  it('does NOT ACK on delivery failure (retry on next dispatch)', async () => {
    const events = [makeEvent('e3', 'external')];
    mockExec
      .mockResolvedValueOnce({ stdout: JSON.stringify(events), stderr: '' }) // pop
      .mockRejectedValueOnce(new Error('network error'));                     // xgw send fails

    const counts = new Map<string, number>();
    await deliverBatch(THREAD, CONSUMER, 3, counts);

    // Only pop was called; no ack
    const calls = mockExec.mock.calls;
    const ackCall = calls.find(([, args]) => (args as string[]).includes('ack'));
    expect(ackCall).toBeUndefined();
  });

  it('writes error record and ACKs when maxAttempts reached', async () => {
    const events = [makeEvent('e4', 'external')];
    mockExec
      .mockResolvedValueOnce({ stdout: JSON.stringify(events), stderr: '' }) // pop
      .mockRejectedValueOnce(new Error('fail'))                              // xgw send fails
      .mockResolvedValueOnce({ stdout: 'err-1', stderr: '' })                // pushError (thread push record)
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                    // ack

    // maxAttempts=1 so first failure triggers error+ack
    await deliverBatch(THREAD, CONSUMER, 1);

    const calls = mockExec.mock.calls;
    // error record push
    const errorCall = calls.find(([, args]) => {
      const a = args as string[];
      return a.includes('record') && a.includes('error');
    });
    expect(errorCall).toBeDefined();
    // ack was called
    const ackCall = calls.find(([, args]) => (args as string[]).includes('ack'));
    expect(ackCall).toBeDefined();
  });

  it('returns immediately when no events', async () => {
    mockExec.mockResolvedValueOnce({ stdout: '[]', stderr: '' });

    await deliverBatch(THREAD, CONSUMER, 3);

    expect(mockExec).toHaveBeenCalledOnce(); // only pop
  });

  it('skips event that already exceeded maxAttempts in prior run', async () => {
    const events = [makeEvent('e5', 'external')];
    mockExec
      .mockResolvedValueOnce({ stdout: JSON.stringify(events), stderr: '' }) // pop
      .mockResolvedValueOnce({ stdout: 'err-2', stderr: '' })                // pushError
      .mockResolvedValueOnce({ stdout: '', stderr: '' });                    // ack

    // Pre-populate attempt count beyond max
    const counts = new Map([['e5', 3]]);
    await deliverBatch(THREAD, CONSUMER, 3, counts);

    // xgw send should NOT have been called
    const xgwCall = mockExec.mock.calls.find(([cmd]) => cmd === 'xgw');
    expect(xgwCall).toBeUndefined();
    // error record and ack should have been called
    const ackCall = mockExec.mock.calls.find(([, args]) => (args as string[]).includes('ack'));
    expect(ackCall).toBeDefined();
  });
});

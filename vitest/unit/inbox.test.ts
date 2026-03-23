import { describe, it, expect, vi, beforeEach } from 'vitest';
import { consumeMessages } from '../../src/runner/inbox.js';

vi.mock('../../src/repo-utils/os.js', () => ({
  execCommand: vi.fn(),
}));

import { execCommand } from '../../src/repo-utils/os.js';
const mockExecCommand = vi.mocked(execCommand);

const INBOX = '/agents/bot/inbox';
const CONSUMER = 'inbox';

beforeEach(() => {
  mockExecCommand.mockClear();
});

describe('consumeMessages', () => {
  it('calls thread pop with correct args', async () => {
    mockExecCommand.mockResolvedValue({ stdout: '[]', stderr: '' });

    await consumeMessages(INBOX, CONSUMER);

    // First call is thread info (to get lastEventId), second is thread pop
    expect(mockExecCommand).toHaveBeenCalledWith('thread', [
      'pop', '--thread', INBOX, '--consumer', CONSUMER,
      '--last-event-id', '0',
    ]);
  });

  it('includes --last-event-id when provided', async () => {
    mockExecCommand.mockResolvedValue({ stdout: '[]', stderr: '' });

    await consumeMessages(INBOX, CONSUMER, 'evt-42');

    expect(mockExecCommand).toHaveBeenCalledWith('thread', [
      'pop', '--thread', INBOX, '--consumer', CONSUMER,
      '--last-event-id', 'evt-42',
    ]);
  });

  it('skips thread info call when lastEventId is provided', async () => {
    mockExecCommand.mockResolvedValue({ stdout: '[]', stderr: '' });

    await consumeMessages(INBOX, CONSUMER, 'evt-42');

    expect(mockExecCommand).toHaveBeenCalledOnce();
    expect(mockExecCommand).toHaveBeenCalledWith('thread', [
      'pop', '--thread', INBOX, '--consumer', CONSUMER,
      '--last-event-id', 'evt-42',
    ]);
  });

  it('returns empty array when stdout is empty string', async () => {
    mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' });

    const result = await consumeMessages(INBOX, CONSUMER, '0');
    expect(result).toEqual([]);
  });

  it('returns empty array when stdout is []', async () => {
    mockExecCommand.mockResolvedValue({ stdout: '[]', stderr: '' });

    const result = await consumeMessages(INBOX, CONSUMER, '0');
    expect(result).toEqual([]);
  });

  it('returns empty array when stdout is whitespace', async () => {
    mockExecCommand.mockResolvedValue({ stdout: '   \n', stderr: '' });

    const result = await consumeMessages(INBOX, CONSUMER, '0');
    expect(result).toEqual([]);
  });

  it('parses a single message correctly', async () => {
    const msg = {
      eventId: 'evt-1',
      type: 'message',
      source: 'xgw:telegram:user123',
      content: { text: 'hello', reply_context: { channel_type: 'external', channel_id: 'tg', peer_id: 'user123' } },
      timestamp: '2024-01-01T00:00:00Z',
    };
    mockExecCommand.mockResolvedValue({ stdout: JSON.stringify([msg]), stderr: '' });

    const result = await consumeMessages(INBOX, CONSUMER, '0');
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual(msg);
  });

  it('parses multiple messages', async () => {
    const msgs = [
      { eventId: 'evt-1', type: 'message', source: 'src1', content: { text: 'a', reply_context: {} }, timestamp: 't1' },
      { eventId: 'evt-2', type: 'message', source: 'src2', content: { text: 'b', reply_context: {} }, timestamp: 't2' },
    ];
    mockExecCommand.mockResolvedValue({ stdout: JSON.stringify(msgs), stderr: '' });

    const result = await consumeMessages(INBOX, CONSUMER, '0');
    expect(result).toHaveLength(2);
    expect(result[0]!.eventId).toBe('evt-1');
    expect(result[1]!.eventId).toBe('evt-2');
  });
});

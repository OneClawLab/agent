import { describe, it, expect, vi, beforeEach } from 'vitest';
import { pushMessage, pushRecord, pushError, pushReply } from '../../src/runner/recorder.js';

vi.mock('../../src/repo-utils/os.js', () => ({
  execCommand: vi.fn(),
}));

import { execCommand } from '../../src/repo-utils/os.js';
const mockExecCommand = vi.mocked(execCommand);

const THREAD = '/agents/bot/threads/peers/tg-user1';

beforeEach(() => {
  mockExecCommand.mockClear();
  mockExecCommand.mockResolvedValue({ stdout: 'evt-001\n', stderr: '' });
});

describe('pushMessage', () => {
  it('calls thread push with type=message and correct args', async () => {
    const content = { text: 'hello', extra: 42 };
    await pushMessage(THREAD, 'xgw:telegram:user1', content);

    expect(mockExecCommand).toHaveBeenCalledOnce();
    expect(mockExecCommand).toHaveBeenCalledWith('thread', [
      'push',
      '--thread', THREAD,
      '--type', 'message',
      '--source', 'xgw:telegram:user1',
      '--content', JSON.stringify(content),
    ]);
  });

  it('returns trimmed event_id from stdout', async () => {
    mockExecCommand.mockResolvedValue({ stdout: '  evt-42  \n', stderr: '' });
    const id = await pushMessage(THREAD, 'src', { text: 'hi' });
    expect(id).toBe('evt-42');
  });

  it('preserves source address exactly as provided', async () => {
    const source = 'xgw:slack:channel123:user456';
    await pushMessage(THREAD, source, { text: 'msg' });

    const [, args] = mockExecCommand.mock.calls[0]!;
    const srcIdx = (args as string[]).indexOf('--source');
    expect((args as string[])[srcIdx + 1]).toBe(source);
  });

  it('serializes content as JSON string', async () => {
    const content = { text: 'hi', reply_context: { channel_type: 'external', channel_id: 'c1', peer_id: 'p1' } };
    await pushMessage(THREAD, 'src', content);

    const [, args] = mockExecCommand.mock.calls[0]!;
    const contentIdx = (args as string[]).indexOf('--content');
    expect((args as string[])[contentIdx + 1]!).toBe(JSON.stringify(content));
  });
});

describe('pushRecord', () => {
  it('calls thread push with type=record and subtype', async () => {
    const content = { name: 'search', arguments: { q: 'test' } };
    await pushRecord(THREAD, 'toolcall', 'self', content);

    expect(mockExecCommand).toHaveBeenCalledWith('thread', [
      'push',
      '--thread', THREAD,
      '--type', 'record',
      '--subtype', 'toolcall',
      '--source', 'self',
      '--content', JSON.stringify(content),
    ]);
  });

  it('returns trimmed event_id', async () => {
    mockExecCommand.mockResolvedValue({ stdout: 'rec-007\n', stderr: '' });
    const id = await pushRecord(THREAD, 'toolcall', 'self', {});
    expect(id).toBe('rec-007');
  });

  it('supports arbitrary subtypes', async () => {
    await pushRecord(THREAD, 'custom-subtype', 'self', {});
    const [, args] = mockExecCommand.mock.calls[0]!;
    const subtypeIdx = (args as string[]).indexOf('--subtype');
    expect((args as string[])[subtypeIdx + 1]).toBe('custom-subtype');
  });
});

describe('pushError', () => {
  it('delegates to pushRecord with subtype=error and source=self', async () => {
    await pushError(THREAD, { error: 'something failed', context: 'during LLM call' });

    expect(mockExecCommand).toHaveBeenCalledWith('thread', [
      'push',
      '--thread', THREAD,
      '--type', 'record',
      '--subtype', 'error',
      '--source', 'self',
      '--content', JSON.stringify({ error: 'something failed', context: 'during LLM call' }),
    ]);
  });

  it('works without optional context field', async () => {
    await pushError(THREAD, { error: 'oops' });

    const [, args] = mockExecCommand.mock.calls[0]!;
    const contentIdx = (args as string[]).indexOf('--content');
    const content = JSON.parse((args as string[])[contentIdx + 1]!);
    expect(content.error).toBe('oops');
    expect(content.context).toBeUndefined();
  });

  it('returns event_id', async () => {
    mockExecCommand.mockResolvedValue({ stdout: 'err-001', stderr: '' });
    const id = await pushError(THREAD, { error: 'fail' });
    expect(id).toBe('err-001');
  });
});

describe('pushReply', () => {
  const replyContext = {
    channel_type: 'external' as const,
    channel_id: 'tg',
    peer_id: 'user1',
  };

  it('calls pushMessage with source=self and reply_context in content', async () => {
    await pushReply(THREAD, 'Hello!', replyContext);

    expect(mockExecCommand).toHaveBeenCalledWith('thread', [
      'push',
      '--thread', THREAD,
      '--type', 'message',
      '--source', 'self',
      '--content', JSON.stringify({ text: 'Hello!', reply_context: replyContext }),
    ]);
  });

  it('carries reply_context fields unchanged', async () => {
    const ctx = {
      channel_type: 'internal' as const,
      channel_id: 'ch-99',
      peer_id: 'agent-admin',
      session_id: 'sess-1',
      source_agent_id: 'admin',
    };
    await pushReply(THREAD, 'reply text', ctx);

    const [, args] = mockExecCommand.mock.calls[0]!;
    const contentIdx = (args as string[]).indexOf('--content');
    const content = JSON.parse((args as string[])[contentIdx + 1]!);
    expect(content.reply_context).toEqual(ctx);
  });

  it('returns event_id', async () => {
    mockExecCommand.mockResolvedValue({ stdout: 'msg-reply-1', stderr: '' });
    const id = await pushReply(THREAD, 'hi', replyContext);
    expect(id).toBe('msg-reply-1');
  });
});

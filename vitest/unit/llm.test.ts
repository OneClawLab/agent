import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invokeLlm, buildSessionFilePath } from '../../src/runner/llm.js';

vi.mock('../../src/os-utils.js', () => ({
  execCommand: vi.fn(),
}));

import { execCommand } from '../../src/repo-utils/os.js';
const mockExecCommand = vi.mocked(execCommand);

const BASE_PARAMS = {
  sessionFile: '/agents/bot/sessions/thread-1.jsonl',
  systemPromptFile: '/agents/bot/system-prompt.md',
  provider: 'openai',
  model: 'gpt-4o',
  userMessage: 'Hello!',
};

beforeEach(() => {
  mockExecCommand.mockClear();
});

describe('buildSessionFilePath', () => {
  it('builds correct path from agentDir and threadId', () => {
    expect(buildSessionFilePath('/agents/bot', 'thread-1')).toBe('/agents/bot/sessions/thread-1.jsonl');
  });

  it('handles nested agentDir', () => {
    expect(buildSessionFilePath('/home/user/.theclaw/agents/mybot', 'abc123')).toBe(
      '/home/user/.theclaw/agents/mybot/sessions/abc123.jsonl'
    );
  });
});

describe('invokeLlm', () => {
  it('calls pai chat with correct arguments', async () => {
    mockExecCommand.mockResolvedValue({ stdout: 'Hello back!', stderr: '' });

    await invokeLlm(BASE_PARAMS);

    expect(mockExecCommand).toHaveBeenCalledOnce();
    expect(mockExecCommand).toHaveBeenCalledWith(
      'pai',
      [
        'chat',
        '--session', BASE_PARAMS.sessionFile,
        '--system-file', BASE_PARAMS.systemPromptFile,
        '--provider', BASE_PARAMS.provider,
        '--model', BASE_PARAMS.model,
        BASE_PARAMS.userMessage,
      ],
      120_000,
      10
    );
  });

  it('returns plain text reply when stdout is not JSON', async () => {
    mockExecCommand.mockResolvedValue({ stdout: 'Hello back!', stderr: '' });

    const result = await invokeLlm(BASE_PARAMS);

    expect(result.reply).toBe('Hello back!');
    expect(result.toolCalls).toBeUndefined();
  });

  it('trims whitespace from stdout', async () => {
    mockExecCommand.mockResolvedValue({ stdout: '  trimmed reply  \n', stderr: '' });

    const result = await invokeLlm(BASE_PARAMS);

    expect(result.reply).toBe('trimmed reply');
  });

  it('parses JSON reply with toolCalls', async () => {
    const structured = {
      reply: 'I will call a tool.',
      toolCalls: [{ name: 'search', arguments: { query: 'test' } }],
    };
    mockExecCommand.mockResolvedValue({ stdout: JSON.stringify(structured), stderr: '' });

    const result = await invokeLlm(BASE_PARAMS);

    expect(result.reply).toBe('I will call a tool.');
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls![0].name).toBe('search');
  });

  it('parses JSON reply without toolCalls', async () => {
    const structured = { reply: 'Just a reply.' };
    mockExecCommand.mockResolvedValue({ stdout: JSON.stringify(structured), stderr: '' });

    const result = await invokeLlm(BASE_PARAMS);

    expect(result.reply).toBe('Just a reply.');
    expect(result.toolCalls).toBeUndefined();
  });

  it('treats JSON without reply field as plain text', async () => {
    const notAReply = JSON.stringify({ something: 'else' });
    mockExecCommand.mockResolvedValue({ stdout: notAReply, stderr: '' });

    const result = await invokeLlm(BASE_PARAMS);

    expect(result.reply).toBe(notAReply);
    expect(result.toolCalls).toBeUndefined();
  });

  it('handles empty toolCalls array — omits the field', async () => {
    const structured = { reply: 'No tools.', toolCalls: [] };
    mockExecCommand.mockResolvedValue({ stdout: JSON.stringify(structured), stderr: '' });

    const result = await invokeLlm(BASE_PARAMS);

    expect(result.reply).toBe('No tools.');
    expect(result.toolCalls).toBeUndefined();
  });

  it('propagates execCommand errors', async () => {
    mockExecCommand.mockRejectedValue(new Error('pai exited with code 1: auth failed'));

    await expect(invokeLlm(BASE_PARAMS)).rejects.toThrow('auth failed');
  });
});

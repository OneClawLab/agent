// Feature: agent-runtime, Property 2: Source 地址透传, Property 3: Reply Context 透传

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

vi.mock('../../src/os-utils.js', () => ({
  execCommand: vi.fn(),
}));

import { execCommand } from '../../src/os-utils.js';
import { pushMessage, pushReply } from '../../src/runner/recorder.js';

const mockExecCommand = vi.mocked(execCommand);

const THREAD = '/agents/bot/threads/peers/tg-user1';

beforeEach(() => {
  mockExecCommand.mockClear();
  mockExecCommand.mockResolvedValue({ stdout: 'evt-001\n', stderr: '' });
});

// ── Arbitraries ──────────────────────────────────────────────────────────────

/** Source address: any non-empty string (mirrors real-world addresses like "xgw:telegram:user123") */
const sourceArb = fc.stringMatching(/^[a-zA-Z0-9:_\-\.]{1,64}$/);

/** Safe string for IDs and text values */
const safeStringArb = fc.stringMatching(/^[a-zA-Z0-9_\-]{1,32}$/);

/** ReplyContext arbitrary covering both channel types and all optional fields */
const replyContextArb = fc.record({
  channel_type: fc.constantFrom('external', 'internal') as fc.Arbitrary<'external' | 'internal'>,
  channel_id: safeStringArb,
  peer_id: safeStringArb,
  session_id: fc.option(safeStringArb, { nil: undefined }),
  visibility: fc.option(safeStringArb, { nil: undefined }),
  source_agent_id: fc.option(safeStringArb, { nil: undefined }),
});

/** Generic message content payload */
const contentArb = fc.record({
  text: fc.stringMatching(/^[a-zA-Z0-9 ]{1,100}$/),
});

// ── Property 2: Source 地址透传 ───────────────────────────────────────────────
// Validates: Requirements 4.4

describe('Property 2: Source 地址透传', () => {
  it('source passed to execCommand exactly matches the original source argument', async () => {
    await fc.assert(
      fc.asyncProperty(sourceArb, contentArb, async (source, content) => {
        mockExecCommand.mockClear();
        mockExecCommand.mockResolvedValue({ stdout: 'evt-001\n', stderr: '' });

        await pushMessage(THREAD, source, content);

        expect(mockExecCommand).toHaveBeenCalledOnce();
        const [, args] = mockExecCommand.mock.calls[0];
        const argList = args as string[];
        const srcIdx = argList.indexOf('--source');
        expect(srcIdx).toBeGreaterThanOrEqual(0);
        expect(argList[srcIdx + 1]).toBe(source);
      }),
      { numRuns: 100 }
    );
  });

  it('source is never modified or normalised (case, special chars preserved)', async () => {
    await fc.assert(
      fc.asyncProperty(sourceArb, async (source) => {
        mockExecCommand.mockClear();
        mockExecCommand.mockResolvedValue({ stdout: 'evt-002\n', stderr: '' });

        await pushMessage(THREAD, source, { text: 'msg' });

        const [, args] = mockExecCommand.mock.calls[0];
        const argList = args as string[];
        const srcIdx = argList.indexOf('--source');
        // Exact byte-for-byte equality — no trimming, casing, or encoding changes
        expect(argList[srcIdx + 1]).toStrictEqual(source);
      }),
      { numRuns: 100 }
    );
  });
});

// ── Property 3: Reply Context 透传 ────────────────────────────────────────────
// Validates: Requirements 6.3

describe('Property 3: Reply Context 透传', () => {
  it('reply_context in execCommand content equals the original reply_context object', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.stringMatching(/^[a-zA-Z0-9 ]{1,100}$/), // replyText
        replyContextArb,
        async (replyText, replyContext) => {
          mockExecCommand.mockClear();
          mockExecCommand.mockResolvedValue({ stdout: 'evt-003\n', stderr: '' });

          await pushReply(THREAD, replyText, replyContext);

          expect(mockExecCommand).toHaveBeenCalledOnce();
          const [, args] = mockExecCommand.mock.calls[0];
          const argList = args as string[];
          const contentIdx = argList.indexOf('--content');
          expect(contentIdx).toBeGreaterThanOrEqual(0);

          const parsed = JSON.parse(argList[contentIdx + 1]);
          expect(parsed.reply_context).toEqual(replyContext);
        }
      ),
      { numRuns: 100 }
    );
  });

  it('all reply_context fields are preserved unchanged (no field dropped or mutated)', async () => {
    await fc.assert(
      fc.asyncProperty(replyContextArb, async (replyContext) => {
        mockExecCommand.mockClear();
        mockExecCommand.mockResolvedValue({ stdout: 'evt-004\n', stderr: '' });

        await pushReply(THREAD, 'hello', replyContext);

        const [, args] = mockExecCommand.mock.calls[0];
        const argList = args as string[];
        const contentIdx = argList.indexOf('--content');
        const parsed = JSON.parse(argList[contentIdx + 1]);
        const rc = parsed.reply_context;

        expect(rc.channel_type).toBe(replyContext.channel_type);
        expect(rc.channel_id).toBe(replyContext.channel_id);
        expect(rc.peer_id).toBe(replyContext.peer_id);

        // Optional fields: only check when defined in original
        if (replyContext.session_id !== undefined) {
          expect(rc.session_id).toBe(replyContext.session_id);
        }
        if (replyContext.visibility !== undefined) {
          expect(rc.visibility).toBe(replyContext.visibility);
        }
        if (replyContext.source_agent_id !== undefined) {
          expect(rc.source_agent_id).toBe(replyContext.source_agent_id);
        }
      }),
      { numRuns: 100 }
    );
  });

  it('pushReply always sets source=self regardless of reply_context content', async () => {
    await fc.assert(
      fc.asyncProperty(replyContextArb, async (replyContext) => {
        mockExecCommand.mockClear();
        mockExecCommand.mockResolvedValue({ stdout: 'evt-005\n', stderr: '' });

        await pushReply(THREAD, 'reply', replyContext);

        const [, args] = mockExecCommand.mock.calls[0];
        const argList = args as string[];
        const srcIdx = argList.indexOf('--source');
        expect(argList[srcIdx + 1]).toBe('self');
      }),
      { numRuns: 100 }
    );
  });
});

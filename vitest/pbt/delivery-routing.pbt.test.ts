// Feature: agent-runtime, Property 6: 出站投递路由正确性

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fc from 'fast-check';

vi.mock('../../src/os-utils.js', () => ({
  execCommand: vi.fn(),
}));

import { execCommand } from '../../src/repo-utils/os.js';
import { execXgwSend, execThreadPush } from '../../src/runner/deliver.js';
import type { DeliveryEvent } from '../../src/runner/deliver.js';

const mockExecCommand = vi.mocked(execCommand);

beforeEach(() => {
  mockExecCommand.mockClear();
  mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' });
});

// ── Arbitraries ──────────────────────────────────────────────────────────────

const safeStringArb = fc.stringMatching(/^[a-zA-Z0-9_\-]{1,32}$/);

/** External DeliveryEvent: channel_type = 'external' */
const externalEventArb: fc.Arbitrary<DeliveryEvent> = fc.record({
  eventId: safeStringArb,
  content: fc.record({
    text: fc.stringMatching(/^[a-zA-Z0-9 ]{1,100}$/),
    reply_context: fc.record({
      channel_type: fc.constant('external' as const),
      channel_id: safeStringArb,
      peer_id: safeStringArb,
      session_id: fc.option(safeStringArb, { nil: undefined }),
      visibility: fc.option(safeStringArb, { nil: undefined }),
      source_agent_id: fc.option(safeStringArb, { nil: undefined }),
    }),
  }),
});

/** Internal DeliveryEvent: channel_type = 'internal', source_agent_id always present */
const internalEventArb: fc.Arbitrary<DeliveryEvent> = fc.record({
  eventId: safeStringArb,
  content: fc.record({
    text: fc.stringMatching(/^[a-zA-Z0-9 ]{1,100}$/),
    reply_context: fc.record({
      channel_type: fc.constant('internal' as const),
      channel_id: safeStringArb,
      peer_id: safeStringArb,
      session_id: fc.option(safeStringArb, { nil: undefined }),
      visibility: fc.option(safeStringArb, { nil: undefined }),
      source_agent_id: safeStringArb, // required for internal delivery
    }),
  }),
});

// ── Property 6: 出站投递路由正确性 ────────────────────────────────────────────
// Validates: Requirements 7.2, 7.3

describe('Property 6: 出站投递路由正确性', () => {
  it('external channel_type → execXgwSend calls xgw send', async () => {
    await fc.assert(
      fc.asyncProperty(externalEventArb, async (event) => {
        mockExecCommand.mockClear();
        mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' });

        await execXgwSend(event);

        expect(mockExecCommand).toHaveBeenCalledOnce();
        const [cmd, args] = mockExecCommand.mock.calls[0];
        expect(cmd).toBe('xgw');
        expect(args).toContain('send');
      }),
      { numRuns: 100 }
    );
  });

  it('external channel_type → xgw send uses correct channel_id and peer_id', async () => {
    await fc.assert(
      fc.asyncProperty(externalEventArb, async (event) => {
        mockExecCommand.mockClear();
        mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' });

        await execXgwSend(event);

        const [, args] = mockExecCommand.mock.calls[0];
        const argList = args as string[];
        const channelIdx = argList.indexOf('--channel');
        const peerIdx = argList.indexOf('--peer');

        expect(channelIdx).toBeGreaterThanOrEqual(0);
        expect(peerIdx).toBeGreaterThanOrEqual(0);
        expect(argList[channelIdx + 1]).toBe(event.content.reply_context.channel_id);
        expect(argList[peerIdx + 1]).toBe(event.content.reply_context.peer_id);
      }),
      { numRuns: 100 }
    );
  });

  it('internal channel_type → execThreadPush calls thread push', async () => {
    await fc.assert(
      fc.asyncProperty(internalEventArb, async (event) => {
        mockExecCommand.mockClear();
        mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' });

        await execThreadPush(event);

        expect(mockExecCommand).toHaveBeenCalledOnce();
        const [cmd, args] = mockExecCommand.mock.calls[0];
        expect(cmd).toBe('thread');
        expect(args).toContain('push');
      }),
      { numRuns: 100 }
    );
  });

  it('internal channel_type → thread push targets source_agent_id inbox', async () => {
    await fc.assert(
      fc.asyncProperty(internalEventArb, async (event) => {
        mockExecCommand.mockClear();
        mockExecCommand.mockResolvedValue({ stdout: '', stderr: '' });

        await execThreadPush(event);

        const [, args] = mockExecCommand.mock.calls[0];
        const argList = args as string[];
        const threadIdx = argList.indexOf('--thread');

        expect(threadIdx).toBeGreaterThanOrEqual(0);
        // inbox path must contain the source_agent_id
        expect(argList[threadIdx + 1]).toContain(
          event.content.reply_context.source_agent_id as string
        );
      }),
      { numRuns: 100 }
    );
  });
});

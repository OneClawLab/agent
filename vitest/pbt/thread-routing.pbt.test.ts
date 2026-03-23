// Feature: agent-runtime, Property 1: Thread 路径解析正确性

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { path } from '../../src/repo-utils/path.js';
import { resolveThreadPath } from '../../src/runner/router.js';

// ── Arbitraries ──────────────────────────────────────────────────────────────

/** Safe path segment: no slashes, no empty strings */
const segmentArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,32}$/);

/** Absolute-style agentDir */
const agentDirArb = fc.stringMatching(/^\/[a-zA-Z0-9/_-]{1,64}$/);

// ── Property 1: Thread 路径解析正确性 ─────────────────────────────────────────
// Validates: Requirements 4.3, 5.1, 5.2, 5.3

describe('Property 1: Thread 路径解析正确性', () => {
  it('per-peer → <agentDir>/threads/peers/<channelId>-<peerId>', () => {
    fc.assert(
      fc.property(agentDirArb, segmentArb, segmentArb, (agentDir, channelId, peerId) => {
        const result = resolveThreadPath(agentDir, 'per-peer', channelId, peerId);
        expect(result).toBe(path.join(agentDir, 'threads', 'peers', `${channelId}-${peerId}`));
      }),
      { numRuns: 100 }
    );
  });

  it('per-channel → <agentDir>/threads/channels/<channelId>', () => {
    fc.assert(
      fc.property(agentDirArb, segmentArb, segmentArb, (agentDir, channelId, peerId) => {
        const result = resolveThreadPath(agentDir, 'per-channel', channelId, peerId);
        expect(result).toBe(path.join(agentDir, 'threads', 'channels', channelId));
      }),
      { numRuns: 100 }
    );
  });

  it('per-agent → <agentDir>/threads/main', () => {
    fc.assert(
      fc.property(agentDirArb, segmentArb, segmentArb, (agentDir, channelId, peerId) => {
        const result = resolveThreadPath(agentDir, 'per-agent', channelId, peerId);
        expect(result).toBe(path.join(agentDir, 'threads', 'main'));
      }),
      { numRuns: 100 }
    );
  });


});

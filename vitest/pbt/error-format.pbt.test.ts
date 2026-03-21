// Feature: agent-runtime, Property 9: 可恢复错误重试上限, Property 10: 不可恢复错误不重试, Property 11: 错误输出格式一致性

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { withRetry, formatError } from '../../src/errors.js';

// ── Arbitraries ──────────────────────────────────────────────────────────────

/** maxAttempts: 1–10 */
const maxAttemptsArb = fc.integer({ min: 1, max: 10 });

/** Safe printable string for error messages and suggestions */
const safeStringArb = fc.stringMatching(/^[a-zA-Z0-9 _\-\.]{1,64}$/);

// ── Property 9: 可恢复错误重试上限 ────────────────────────────────────────────
// Validates: Requirements 11.1

describe('Property 9: 可恢复错误重试上限', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('withRetry calls fn at most maxAttempts times when error is always recoverable', async () => {
    await fc.assert(
      fc.asyncProperty(maxAttemptsArb, async (maxAttempts) => {
        let callCount = 0;

        const fn = () => {
          callCount++;
          return Promise.reject(new Error('recoverable'));
        };

        const isRecoverable = () => true;

        // Run withRetry and advance timers concurrently
        const retryPromise = withRetry(fn, maxAttempts, isRecoverable).catch(() => {
          // expected to throw after exhausting attempts
        });

        // Advance fake timers to skip all exponential backoff delays
        await vi.runAllTimersAsync();
        await retryPromise;

        expect(callCount).toBe(maxAttempts);
      }),
      { numRuns: 100 }
    );
  });

  it('withRetry never exceeds maxAttempts even with large values', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 10 }), async (maxAttempts) => {
        let callCount = 0;

        const fn = () => {
          callCount++;
          return Promise.reject(new Error('transient'));
        };

        const retryPromise = withRetry(fn, maxAttempts, () => true).catch(() => {});
        await vi.runAllTimersAsync();
        await retryPromise;

        expect(callCount).toBeLessThanOrEqual(maxAttempts);
      }),
      { numRuns: 100 }
    );
  });
});

// ── Property 10: 不可恢复错误不重试 ──────────────────────────────────────────
// Validates: Requirements 11.2

describe('Property 10: 不可恢复错误不重试', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('withRetry calls fn exactly once when error is non-recoverable', async () => {
    await fc.assert(
      fc.asyncProperty(maxAttemptsArb, async (maxAttempts) => {
        let callCount = 0;
        const originalError = new Error('non-recoverable');

        const fn = () => {
          callCount++;
          return Promise.reject(originalError);
        };

        const isRecoverable = () => false;

        let thrown: Error | undefined;
        const retryPromise = withRetry(fn, maxAttempts, isRecoverable).catch((e) => {
          thrown = e as Error;
        });

        await vi.runAllTimersAsync();
        await retryPromise;

        // Must have been called exactly once — no retries
        expect(callCount).toBe(1);
        // Must re-throw the original error
        expect(thrown).toBe(originalError);
      }),
      { numRuns: 100 }
    );
  });

  it('non-recoverable error is thrown immediately regardless of maxAttempts', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 2, max: 10 }), async (maxAttempts) => {
        let callCount = 0;

        const fn = () => {
          callCount++;
          return Promise.reject(new Error('fatal'));
        };

        const retryPromise = withRetry(fn, maxAttempts, () => false).catch(() => {});
        await vi.runAllTimersAsync();
        await retryPromise;

        // Even with maxAttempts > 1, non-recoverable errors must not retry
        expect(callCount).toBe(1);
      }),
      { numRuns: 100 }
    );
  });
});

// ── Property 11: 错误输出格式一致性 ──────────────────────────────────────────
// Validates: Requirements 11.4, 11.5

describe('Property 11: 错误输出格式一致性', () => {
  it('json=false: output matches "Error: <what> - <suggestion>" format', () => {
    fc.assert(
      fc.property(safeStringArb, safeStringArb, (what, suggestion) => {
        const output = formatError(what, suggestion, false);
        expect(output).toBe(`Error: ${what} - ${suggestion}`);
        expect(output).toMatch(/^Error: .+ - .+$/);
      }),
      { numRuns: 100 }
    );
  });

  it('json=true: output is valid JSON with "error" and "suggestion" fields', () => {
    fc.assert(
      fc.property(safeStringArb, safeStringArb, (what, suggestion) => {
        const output = formatError(what, suggestion, true);

        // Must be parseable JSON
        let parsed: unknown;
        expect(() => {
          parsed = JSON.parse(output);
        }).not.toThrow();

        const obj = parsed as Record<string, unknown>;
        expect(obj).toHaveProperty('error', what);
        expect(obj).toHaveProperty('suggestion', suggestion);
      }),
      { numRuns: 100 }
    );
  });

  it('json=false output always starts with "Error: "', () => {
    fc.assert(
      fc.property(safeStringArb, safeStringArb, (what, suggestion) => {
        const output = formatError(what, suggestion, false);
        expect(output.startsWith('Error: ')).toBe(true);
      }),
      { numRuns: 100 }
    );
  });

  it('json=true output never starts with "Error: "', () => {
    fc.assert(
      fc.property(safeStringArb, safeStringArb, (what, suggestion) => {
        const output = formatError(what, suggestion, true);
        expect(output.startsWith('Error: ')).toBe(false);
      }),
      { numRuns: 100 }
    );
  });
});

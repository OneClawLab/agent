import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withRetry, formatError, printError } from '../../src/errors.js';

// ─── formatError ─────────────────────────────────────────────────────────────

describe('formatError', () => {
  it('returns human-readable format when json=false', () => {
    expect(formatError('disk full', 'free up space', false)).toBe(
      'Error: disk full - free up space'
    );
  });

  it('returns JSON format when json=true', () => {
    const result = formatError('auth failed', 'check credentials', true);
    expect(JSON.parse(result)).toEqual({ error: 'auth failed', suggestion: 'check credentials' });
  });

  it('human format starts with "Error: "', () => {
    expect(formatError('something broke', 'try again', false)).toMatch(/^Error: /);
  });

  it('human format contains " - " separator', () => {
    expect(formatError('what', 'how', false)).toContain(' - ');
  });

  it('JSON format contains both error and suggestion fields', () => {
    const parsed = JSON.parse(formatError('e', 's', true));
    expect(parsed).toHaveProperty('error');
    expect(parsed).toHaveProperty('suggestion');
  });
});

// ─── printError ──────────────────────────────────────────────────────────────

describe('printError', () => {
  let stderrSpy: ReturnType<typeof vi.spyOn>;
  let stdoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it('writes to stderr in human mode', () => {
    printError('disk full', 'free up space', false);
    expect(stderrSpy).toHaveBeenCalledOnce();
    expect(stdoutSpy).not.toHaveBeenCalled();
    const written = stderrSpy.mock.calls[0][0] as string;
    expect(written).toContain('Error: disk full - free up space');
  });

  it('writes to stdout in JSON mode', () => {
    printError('auth failed', 'check credentials', true);
    expect(stdoutSpy).toHaveBeenCalledOnce();
    expect(stderrSpy).not.toHaveBeenCalled();
    const written = stdoutSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(written.trim());
    expect(parsed).toEqual({ error: 'auth failed', suggestion: 'check credentials' });
  });
});

// ─── withRetry ───────────────────────────────────────────────────────────────

describe('withRetry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns result immediately on success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn, 3, () => true);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('retries on recoverable error and succeeds', async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValueOnce('success');

    const promise = withRetry(fn, 3, () => true);
    // advance past first backoff (2^1 * 100 = 200ms)
    await vi.advanceTimersByTimeAsync(200);
    const result = await promise;

    expect(result).toBe('success');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws immediately on non-recoverable error without retry', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('auth failed'));
    const isRecoverable = vi.fn().mockReturnValue(false);

    await expect(withRetry(fn, 3, isRecoverable)).rejects.toThrow('auth failed');
    expect(fn).toHaveBeenCalledOnce();
    expect(isRecoverable).toHaveBeenCalledOnce();
  });

  it('throws after exhausting maxAttempts for recoverable errors', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('rate limit'));

    let caught: Error | undefined;
    const promise = withRetry(fn, 3, () => true).catch((e: Error) => { caught = e; });

    // Drain microtasks + advance through all backoffs (200ms + 400ms)
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(400);
    await promise;

    expect(caught?.message).toBe('rate limit');
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('uses exponential backoff: 2^attempt * 100ms', async () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const fn = vi.fn().mockRejectedValue(new Error('fail'));

    let caught: Error | undefined;
    const promise = withRetry(fn, 4, () => true).catch((e: Error) => { caught = e; });

    // Advance through all 3 backoffs: 200ms, 400ms, 800ms
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(400);
    await vi.advanceTimersByTimeAsync(800);
    await promise;

    expect(caught?.message).toBe('fail');
    const capturedDelays = setTimeoutSpy.mock.calls.map(([, ms]) => ms as number);
    // attempts 1, 2, 3 should produce delays 200, 400, 800
    expect(capturedDelays).toEqual([200, 400, 800]);

    setTimeoutSpy.mockRestore();
  });

  it('does not retry when maxAttempts is 1', async () => {
    const fn = vi.fn().mockRejectedValue(new Error('fail'));
    await expect(withRetry(fn, 1, () => true)).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledOnce();
  });

  it('passes the error to isRecoverable', async () => {
    const err = new Error('specific error');
    const fn = vi.fn().mockRejectedValue(err);
    const isRecoverable = vi.fn().mockReturnValue(false);

    await expect(withRetry(fn, 3, isRecoverable)).rejects.toThrow('specific error');
    expect(isRecoverable).toHaveBeenCalledWith(err);
  });
});

/**
 * Error handling utilities for Agent Runtime.
 *
 * - withRetry: exponential backoff retry with recoverable/non-recoverable classification
 * - formatError: format error messages for human or JSON output
 * - printError: write formatted error to appropriate stream
 */

/**
 * Sleep for the given number of milliseconds.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Retry an async function with exponential backoff.
 *
 * - Recoverable errors are retried up to maxAttempts times.
 * - Non-recoverable errors are thrown immediately without retry.
 * - Backoff: 2^attempt * 100ms (200ms, 400ms, 800ms, ...)
 *
 * @param fn            - The async function to execute.
 * @param maxAttempts   - Maximum number of attempts (including the first).
 * @param isRecoverable - Returns true if the error is recoverable (should retry).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  isRecoverable: (err: Error) => boolean
): Promise<T> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRecoverable(err as Error) || attempt === maxAttempts) throw err;
      await sleep(Math.pow(2, attempt) * 100); // 200ms, 400ms, 800ms...
    }
  }
  throw new Error('unreachable');
}

/**
 * Format an error message.
 *
 * - json=false: `Error: <what> - <suggestion>`
 * - json=true:  `{"error": "<what>", "suggestion": "<suggestion>"}`
 */
export function formatError(what: string, suggestion: string, json: boolean): string {
  if (json) {
    return JSON.stringify({ error: what, suggestion });
  }
  return `Error: ${what} - ${suggestion}`;
}

/**
 * Print a formatted error to the appropriate stream.
 *
 * - json=false: writes to stderr
 * - json=true:  writes to stdout
 */
export function printError(what: string, suggestion: string, json: boolean): void {
  const msg = formatError(what, suggestion, json);
  if (json) {
    process.stdout.write(msg + '\n');
  } else {
    process.stderr.write(msg + '\n');
  }
}

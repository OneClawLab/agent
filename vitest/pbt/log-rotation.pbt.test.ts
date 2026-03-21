// Feature: agent-runtime, Property 12: 日志轮换

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createFireAndForgetLogger } from '../../src/repo-utils/logger.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'agent-pbt-log-rotation-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Wait for async fire-and-forget log writes to settle. */
const flush = () => new Promise((r) => setTimeout(r, 80));

// ── Property 12: 日志轮换 ─────────────────────────────────────────────────────
// Validates: Requirements 12.2

describe('Property 12: 日志轮换', () => {
  it('when line count >= 10000, writing a new log line triggers rotation', async () => {
    await fc.assert(
      fc.asyncProperty(
        // Generate line counts >= 10000 (up to 10100 to keep tests fast)
        fc.integer({ min: 10000, max: 10100 }),
        // Generate a safe log message
        fc.stringMatching(/^[a-zA-Z0-9 _-]{1,64}$/),
        async (lineCount, message) => {
          const dir = await mkdtemp(join(tmpdir(), 'p12-'));
          try {
            const logsDir = join(dir, 'logs');
            await mkdir(logsDir, { recursive: true });

            // Pre-fill agent.log with exactly `lineCount` lines
            const existingContent = 'x\n'.repeat(lineCount);
            await writeFile(join(logsDir, 'agent.log'), existingContent, 'utf8');

            const logger = createFireAndForgetLogger(join(dir, 'logs'), 'agent');
            logger.info(message);
            await flush();

            // 1. New agent.log should exist and contain only the new line
            const newContent = await readFile(join(logsDir, 'agent.log'), 'utf8');
            expect(newContent).toContain(`[INFO] ${message}`);
            // New file should have exactly 1 line (the new log entry), not the old bulk content
            const newLineCount = newContent.split('\n').filter((l) => l.length > 0).length;
            expect(newLineCount).toBe(1);

            // 2. Exactly one archive file should exist
            const files = await readdir(logsDir);
            const archives = files.filter(
              (f) => f.startsWith('agent-') && f.endsWith('.log')
            );
            expect(archives).toHaveLength(1);

            // 3. Archive filename matches agent-<timestamp>.log pattern
            expect(archives[0]!).toMatch(/^agent-\d{8}-\d{6}\.log$/);

            // 4. Archive file contains the old content
            const archiveContent = await readFile(join(logsDir, archives[0]!), 'utf8');
            expect(archiveContent).toBe(existingContent);
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

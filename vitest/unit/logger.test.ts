import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createLogger } from '../../src/logger.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'agent-logger-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Wait for async fire-and-forget log writes to settle. */
const flush = () => new Promise((r) => setTimeout(r, 50));

describe('createLogger', () => {
  it('creates logs directory and writes to agent.log', async () => {
    const logger = createLogger(tmpDir);
    logger.info('hello world');
    await flush();

    const content = await readFile(join(tmpDir, 'logs', 'agent.log'), 'utf8');
    expect(content).toContain('[INFO] hello world');
  });

  it('includes ISO timestamp in each log line', async () => {
    const logger = createLogger(tmpDir);
    logger.info('timestamp test');
    await flush();

    const content = await readFile(join(tmpDir, 'logs', 'agent.log'), 'utf8');
    // ISO 8601 pattern: 2024-01-01T00:00:00.000Z
    expect(content).toMatch(/\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
  });

  it('writes error level correctly', async () => {
    const logger = createLogger(tmpDir);
    logger.error('something failed');
    await flush();

    const content = await readFile(join(tmpDir, 'logs', 'agent.log'), 'utf8');
    expect(content).toContain('[ERROR] something failed');
  });

  it('writes debug level correctly', async () => {
    const logger = createLogger(tmpDir);
    logger.debug('debug info');
    await flush();

    const content = await readFile(join(tmpDir, 'logs', 'agent.log'), 'utf8');
    expect(content).toContain('[DEBUG] debug info');
  });

  it('appends multiple log lines', async () => {
    const logger = createLogger(tmpDir);
    logger.info('line one');
    logger.error('line two');
    logger.debug('line three');
    await flush();

    const content = await readFile(join(tmpDir, 'logs', 'agent.log'), 'utf8');
    expect(content).toContain('[INFO] line one');
    expect(content).toContain('[ERROR] line two');
    expect(content).toContain('[DEBUG] line three');
  });

  it('rotates log file when it exceeds 10000 lines', async () => {
    const logsDir = join(tmpDir, 'logs');
    await mkdir(logsDir, { recursive: true });

    // Pre-fill agent.log with exactly 10000 lines
    const existingContent = 'x\n'.repeat(10000);
    await writeFile(join(logsDir, 'agent.log'), existingContent, 'utf8');

    const logger = createLogger(tmpDir);
    logger.info('trigger rotation');
    await flush();

    // The original agent.log should have been rotated (renamed)
    // A new agent.log should exist with only the new line
    const newContent = await readFile(join(logsDir, 'agent.log'), 'utf8');
    expect(newContent).toContain('[INFO] trigger rotation');
    // New file should NOT contain the old 'x' lines
    expect(newContent).not.toContain('x\n');

    // An archive file should exist
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(logsDir);
    const archives = files.filter((f) => f.startsWith('agent-') && f.endsWith('.log'));
    expect(archives).toHaveLength(1);
  });

  it('archive filename matches agent-<timestamp>.log pattern', async () => {
    const logsDir = join(tmpDir, 'logs');
    await mkdir(logsDir, { recursive: true });

    const existingContent = 'x\n'.repeat(10000);
    await writeFile(join(logsDir, 'agent.log'), existingContent, 'utf8');

    const logger = createLogger(tmpDir);
    logger.info('rotation naming test');
    await flush();

    const { readdir } = await import('node:fs/promises');
    const files = await readdir(logsDir);
    const archives = files.filter((f) => f.startsWith('agent-') && f.endsWith('.log'));
    expect(archives[0]).toMatch(/^agent-\d{8}-\d{6}-\d{3}\.log$/);
  });

  it('does not rotate when line count is below 10000', async () => {
    const logsDir = join(tmpDir, 'logs');
    await mkdir(logsDir, { recursive: true });

    // 9999 lines — should NOT rotate
    const existingContent = 'x\n'.repeat(9999);
    await writeFile(join(logsDir, 'agent.log'), existingContent, 'utf8');

    const logger = createLogger(tmpDir);
    logger.info('no rotation yet');
    await flush();

    const { readdir } = await import('node:fs/promises');
    const files = await readdir(logsDir);
    const archives = files.filter((f) => f.startsWith('agent-') && f.endsWith('.log'));
    expect(archives).toHaveLength(0);

    // Original file should still have the old content plus the new line
    const content = await readFile(join(logsDir, 'agent.log'), 'utf8');
    expect(content).toContain('[INFO] no rotation yet');
  });

  it('works even if logs directory already exists', async () => {
    const logsDir = join(tmpDir, 'logs');
    await mkdir(logsDir, { recursive: true });

    const logger = createLogger(tmpDir);
    logger.info('pre-existing dir');
    await flush();

    const content = await readFile(join(logsDir, 'agent.log'), 'utf8');
    expect(content).toContain('[INFO] pre-existing dir');
  });
});

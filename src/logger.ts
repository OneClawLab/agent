import { appendFile, mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export interface Logger {
  info(msg: string): void;
  error(msg: string): void;
  debug(msg: string): void;
}

const MAX_LINES = 10000;
const LOG_FILE = 'agent.log';

/**
 * Format a log line with ISO timestamp and level.
 */
function formatLine(level: string, msg: string): string {
  return `[${new Date().toISOString()}] [${level}] ${msg}\n`;
}

/**
 * Count lines in a string (number of newline characters).
 */
function countLines(content: string): number {
  if (content.length === 0) return 0;
  let count = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') count++;
  }
  return count;
}

/**
 * Generate a timestamp string suitable for archive filenames.
 * Format: YYYYMMDD-HHmmss-mmm
 */
function archiveTimestamp(): string {
  const now = new Date();
  const pad = (n: number, len = 2) => String(n).padStart(len, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}` +
    `-${pad(now.getMilliseconds(), 3)}`
  );
}

/**
 * Write a log line to <agentDir>/logs/agent.log.
 * If the file exceeds MAX_LINES, rotate it first.
 */
async function writeLog(logsDir: string, line: string): Promise<void> {
  // Ensure directory exists before writing (handles rapid concurrent calls)
  await mkdir(logsDir, { recursive: true });

  const logPath = join(logsDir, LOG_FILE);

  // Check current line count
  let currentContent = '';
  try {
    currentContent = await readFile(logPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    // File doesn't exist yet — no rotation needed
  }

  if (currentContent.length > 0 && countLines(currentContent) >= MAX_LINES) {
    // Rotate: rename current log to agent-<timestamp>.log
    const archiveName = `agent-${archiveTimestamp()}.log`;
    await rename(logPath, join(logsDir, archiveName));
  }

  await appendFile(logPath, line, 'utf8');
}

/**
 * Create a logger that writes to <agentDir>/logs/agent.log.
 * Log rotation happens automatically when the file exceeds 10000 lines.
 *
 * Logging is fire-and-forget (errors are silently swallowed) to avoid
 * crashing the agent on log I/O failures.
 */
export function createLogger(agentDir: string): Logger {
  const logsDir = join(agentDir, 'logs');

  const write = (level: string, msg: string) => {
    const line = formatLine(level, msg);
    writeLog(logsDir, line).catch(() => {});
  };

  return {
    info: (msg) => write('INFO', msg),
    error: (msg) => write('ERROR', msg),
    debug: (msg) => write('DEBUG', msg),
  };
}

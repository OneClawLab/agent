import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execCommand } from '../os-utils.js';
import { loadConfig } from '../config.js';
import { createLogger } from '../logger.js';

/**
 * Resolve the agent directory path: ~/.theclaw/agents/<id>/
 */
function agentDir(id: string): string {
  return join(homedir(), '.theclaw', 'agents', id);
}

/**
 * Start an agent by registering an inbox subscription via `thread subscribe`.
 * The handler is `agent run <id>`, so notifier will invoke the run loop
 * whenever new messages arrive.
 *
 * Requirements: 2.1, 2.2, 2.3
 */
export async function startCmd(id: string): Promise<void> {
  const dir = agentDir(id);

  // Requirement 2.3: error if agent directory does not exist
  if (!existsSync(dir)) {
    process.stderr.write(
      `Error: Agent '${id}' not found at ${dir} - run 'agent init ${id}' first\n`
    );
    process.exit(1);
  }

  // Requirement 2.1: load config to get inbox path
  const config = await loadConfig(dir);
  const inboxPath = config.inbox.path;

  // Requirement 2.1: register inbox subscription with handler "agent run <id>"
  await execCommand('thread', [
    'subscribe',
    '--thread', inboxPath,
    '--consumer', 'inbox',
    '--handler', `agent run ${id}`,
  ]);

  // Requirement 2.2: log startup
  const logger = createLogger(dir);
  logger.info(`Agent '${id}' started — inbox subscription registered on ${inboxPath}`);

  process.stdout.write(`Agent '${id}' started\n`);
}

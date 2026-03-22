import { existsSync } from '../repo-utils/fs.js';
import { homedir } from 'node:os';
import { path } from '../repo-utils/path.js';
import { execCommand } from '../repo-utils/os.js';
import { loadConfig } from '../config.js';

/**
 * Resolve the agent directory path: ~/.theclaw/agents/<id>/
 */
function agentDir(id: string): string {
  return path.join(path.toPosixPath(homedir()), '.theclaw', 'agents', id);
}

/**
 * Stop an agent by unregistering its inbox subscription via `thread unsubscribe`.
 * The run loop will no longer be triggered by notifier, but inbox messages
 * continue to accumulate and consumer progress is preserved.
 *
 * Requirements: 3.1, 3.3
 */
export async function stopCmd(id: string): Promise<void> {
  const dir = agentDir(id);

  // Requirement 3.3: error if agent directory does not exist
  if (!existsSync(dir)) {
    process.stderr.write(
      `Error: Agent '${id}' not found at ${dir} - run 'agent init ${id}' first\n`
    );
    process.exit(1);
  }

  // Load config to get inbox path
  const config = await loadConfig(dir);
  const inboxPath = path.resolve(config.inbox.path);

  // Requirement 3.1: unregister inbox subscription
  await execCommand('thread', [
    'unsubscribe',
    '--thread', inboxPath,
    '--consumer', 'inbox',
  ]);

  process.stdout.write(`Agent '${id}' stopped\n`);
}

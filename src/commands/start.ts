import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { path } from '../repo-utils/path.js';
import { execCommand } from '../repo-utils/os.js';
import { loadConfig } from '../config.js';
import { createFireAndForgetLogger } from '../repo-utils/logger.js';

function agentDir(id: string): string {
  return path.join(path.toPosixPath(homedir()), '.theclaw', 'agents', id);
}

export async function startCmd(id: string): Promise<void> {
  const dir = agentDir(id);

  if (!existsSync(dir)) {
    process.stderr.write(
      `Error: Agent '${id}' not found at ${dir} - run 'agent init ${id}' first\n`
    );
    process.exit(1);
  }

  const config = await loadConfig(dir);
  const inboxPath = path.resolve(config.inbox.path);

  await execCommand('thread', [
    'subscribe',
    '--thread', inboxPath,
    '--consumer', 'inbox',
    '--handler', `agent run ${id}`,
  ]);

  const logger = createFireAndForgetLogger(path.join(dir, 'logs'), 'agent');
  logger.info(`Agent '${id}' started — inbox subscription registered on ${inboxPath}`);

  process.stdout.write(`Agent '${id}' started\n`);
}

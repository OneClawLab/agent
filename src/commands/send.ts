import { existsSync } from '../repo-utils/fs.js';
import { homedir } from 'node:os';
import { path } from '../repo-utils/path.js';
import { loadConfig } from '../config.js';
import { execCommand } from '../repo-utils/os.js';

function agentDir(id: string): string {
  return path.join(path.toPosixPath(homedir()), '.theclaw', 'agents', id);
}

export interface SendOptions {
  source: string;
  type: string;
  content: string;
  subtype?: string;
}

/**
 * agent send <id> -- equivalent to:
 *   thread push --thread <agent-inbox> --source <s> --type <t> --content <c>
 *
 * Just saves you from looking up the inbox path.
 * All message parameters are passed through unchanged.
 */
export async function sendCmd(id: string, opts: SendOptions): Promise<void> {
  const dir = agentDir(id);

  if (!existsSync(dir)) {
    process.stderr.write(
      `Error: Agent '${id}' not found at ${dir} - run 'agent init ${id}' first\n`
    );
    process.exit(1);
  }

  const config = await loadConfig(dir);
  const inboxPath = path.resolve(config.inbox.path);

  if (!existsSync(inboxPath)) {
    process.stderr.write(
      `Error: Inbox not found at ${inboxPath} - run 'agent init ${id}' to reinitialise\n`
    );
    process.exit(1);
  }

  const args = [
    'push',
    '--thread', inboxPath,
    '--source', opts.source,
    '--type', opts.type,
    '--content', opts.content,
  ];
  if (opts.subtype) {
    args.push('--subtype', opts.subtype);
  }

  const { stdout } = await execCommand('thread', args);
  if (stdout.trim()) {
    process.stdout.write(stdout);
  }
}

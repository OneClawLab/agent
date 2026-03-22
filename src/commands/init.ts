import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { path } from '../repo-utils/path.js';
import { execCommand } from '../repo-utils/os.js';

function agentDir(id: string): string {
  return path.join(path.toPosixPath(homedir()), '.theclaw', 'agents', id);
}

function defaultConfig(id: string, kind: string): string {
  const inboxPath = path.join(path.toPosixPath(homedir()), '.theclaw', 'agents', id, 'inbox');
  return `agent_id: ${id}
kind: ${kind}
pai:
  provider: openai
  model: gpt-4o
inbox:
  path: ${inboxPath}
routing:
  default: per-peer
outbound: []
retry:
  max_attempts: 3
deliver:
  max_attempts: 3
`;
}

export async function initCmd(id: string, opts: { kind: string }): Promise<void> {
  const kind = opts.kind ?? 'user';
  const dir = agentDir(id);

  if (existsSync(dir)) {
    process.stderr.write(`Error: Agent '${id}' already exists at ${dir} - remove the directory first or choose a different id\n`);
    process.exit(1);
  }

  const subdirs = [
    'inbox',
    'sessions',
    'memory',
    path.join('threads', 'peers'),
    path.join('threads', 'channels'),
    path.join('threads', 'main'),
    'workdir',
    'logs',
  ];

  for (const sub of subdirs) {
    await mkdir(path.join(dir, sub), { recursive: true });
  }

  await writeFile(path.join(dir, 'IDENTITY.md'), `# ${id}\n\nYou are ${id}, an AI agent.\n`);
  await writeFile(path.join(dir, 'USAGE.md'), `# Usage\n\nThis agent responds to messages in its inbox.\n`);
  await writeFile(path.join(dir, 'config.yaml'), defaultConfig(id, kind));

  await execCommand('thread', ['init', path.join(dir, 'inbox')]);

  process.stdout.write(`Agent '${id}' initialized at ${dir}\n`);
}

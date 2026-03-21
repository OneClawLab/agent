import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execCommand } from '../repo-utils/os.js';

/**
 * Resolve the agent directory path: ~/.theclaw/agents/<id>/
 */
function agentDir(id: string): string {
  return join(homedir(), '.theclaw', 'agents', id);
}

/**
 * Generate the default config.yaml content for a new agent.
 */
function defaultConfig(id: string, kind: string): string {
  return `agent_id: ${id}
kind: ${kind}
pai:
  provider: openai
  model: gpt-4o
inbox:
  path: ~/.theclaw/agents/${id}/inbox
routing:
  default: per-peer
outbound: []
retry:
  max_attempts: 3
deliver:
  max_attempts: 3
`;
}

/**
 * Initialize a new agent directory with full structure and default files.
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
 */
export async function initCmd(id: string, opts: { kind: string }): Promise<void> {
  const kind = opts.kind ?? 'user';
  const dir = agentDir(id);

  // Requirement 1.4: error if already exists
  if (existsSync(dir)) {
    process.stderr.write(`Error: Agent '${id}' already exists at ${dir} - remove the directory first or choose a different id\n`);
    process.exit(1);
  }

  // Requirement 1.1: create full directory structure
  const subdirs = [
    'inbox',
    'sessions',
    'memory',
    join('threads', 'peers'),
    join('threads', 'channels'),
    join('threads', 'main'),
    'workdir',
    'logs',
  ];

  for (const sub of subdirs) {
    await mkdir(join(dir, sub), { recursive: true });
  }

  // Requirement 1.2: generate default files
  await writeFile(
    join(dir, 'IDENTITY.md'),
    `# ${id}\n\nYou are ${id}, an AI agent.\n`
  );

  await writeFile(
    join(dir, 'USAGE.md'),
    `# Usage\n\nThis agent responds to messages in its inbox.\n`
  );

  await writeFile(join(dir, 'config.yaml'), defaultConfig(id, kind));

  // Requirement 1.3: initialize inbox via `thread init`
  await execCommand('thread', ['init', '--thread', join(dir, 'inbox')]);

  process.stdout.write(`Agent '${id}' initialized at ${dir}\n`);
}

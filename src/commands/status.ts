import { existsSync } from '../repo-utils/fs.js';
import { stat, readdir } from '../repo-utils/fs.js';
import { homedir } from 'node:os';
import { path } from '../repo-utils/path.js';
import { execCommand } from '../repo-utils/os.js';
import { loadConfig } from '../config.js';

function agentDir(id: string): string {
  return path.join(path.toPosixPath(homedir()), '.theclaw', 'agents', id);
}

function agentsBaseDir(): string {
  return path.join(path.toPosixPath(homedir()), '.theclaw', 'agents');
}

export interface AgentStatus {
  id: string;
  agent_id: string;
  kind: string;
  dir: string;
  model: string;
  inbox_path: string;
  inbox_pending: number;
  started: boolean;
  last_activity: string | null;
}

/**
 * Query thread info JSON to determine subscription status and pending count.
 * Returns { subscribed, inbox_pending }.
 */
async function getInboxInfo(inboxPath: string): Promise<{ subscribed: boolean; inbox_pending: number }> {
  try {
    const { stdout } = await execCommand('thread', ['info', '--thread', inboxPath, '--json'], 5000);
    const info = JSON.parse(stdout) as {
      event_count: number;
      subscriptions: Array<{ consumer_id: string; last_acked_id: number }>;
    };
    const sub = info.subscriptions.find(s => s.consumer_id === 'inbox');
    const subscribed = sub !== undefined;
    const inbox_pending = subscribed ? Math.max(0, info.event_count - sub.last_acked_id) : 0;
    return { subscribed, inbox_pending };
  } catch {
    return { subscribed: false, inbox_pending: 0 };
  }
}

async function getLastActivity(dir: string): Promise<string | null> {
  const candidates = [
    path.join(dir, 'logs', 'agent.log'),
    path.join(dir, 'run.lock'),
  ];
  for (const p of candidates) {
    try {
      const s = await stat(p);
      return s.mtime.toISOString();
    } catch {
      // not found, try next
    }
  }
  return null;
}

export async function statusCmd(id: string | undefined, opts: { json?: boolean }): Promise<void> {
  if (!id) {
    // No id given — list all agents with their status
    return listCmd(opts);
  }

  const dir = agentDir(id);

  if (!existsSync(dir)) {
    const msg = `Error: Agent '${id}' not found at ${dir} - run 'agent init ${id}' first`;
    if (opts.json) {
      process.stdout.write(JSON.stringify({ error: `Agent '${id}' not found`, suggestion: `run 'agent init ${id}' first` }) + '\n');
    } else {
      process.stderr.write(msg + '\n');
    }
    process.exit(1);
  }

  const config = await loadConfig(dir);
  const inboxPath = path.resolve(config.inbox.path);
  const { subscribed, inbox_pending } = await getInboxInfo(inboxPath);
  const lockExists = existsSync(path.join(dir, 'run.lock'));
  const started = subscribed || lockExists;
  const lastActivity = await getLastActivity(dir);

  const statusInfo: AgentStatus = {
    id: config.agent_id,
    agent_id: config.agent_id,
    kind: config.kind,
    dir,
    model: `${config.pai.provider}/${config.pai.model}`,
    inbox_path: inboxPath,
    inbox_pending,
    started,
    last_activity: lastActivity,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(statusInfo, null, 2) + '\n');
  } else {
    process.stdout.write(`Agent:         ${statusInfo.agent_id}\n`);
    process.stdout.write(`Kind:          ${statusInfo.kind}\n`);
    process.stdout.write(`Dir:           ${statusInfo.dir}\n`);
    process.stdout.write(`Model:         ${statusInfo.model}\n`);
    process.stdout.write(`Inbox:         ${statusInfo.inbox_path}\n`);
    process.stdout.write(`Inbox pending: ${statusInfo.inbox_pending}\n`);
    process.stdout.write(`Started:       ${statusInfo.started ? 'yes' : 'no'}\n`);
    process.stdout.write(`Last activity: ${statusInfo.last_activity ?? 'none'}\n`);
  }
}

export async function listCmd(opts: { json?: boolean }): Promise<void> {
  const baseDir = agentsBaseDir();

  if (!existsSync(baseDir)) {
    if (opts.json) {
      process.stdout.write(JSON.stringify([]) + '\n');
    } else {
      process.stdout.write('No agents found\n');
    }
    return;
  }

  let entries: string[];
  try {
    entries = await readdir(baseDir);
  } catch {
    entries = [];
  }

  const agents: Array<{ agent_id: string; kind: string }> = [];

  for (const entry of entries) {
    const dir = path.join(baseDir, entry);
    const configPath = path.join(dir, 'config.yaml');
    if (!existsSync(configPath)) continue;
    try {
      const config = await loadConfig(dir);
      agents.push({ agent_id: config.agent_id, kind: config.kind });
    } catch {
      // Skip agents with unreadable configs
    }
  }

  if (opts.json) {
    process.stdout.write(JSON.stringify(agents, null, 2) + '\n');
  } else {
    if (agents.length === 0) {
      process.stdout.write('No agents found\n');
    } else {
      for (const a of agents) {
        process.stdout.write(`${a.agent_id}  (${a.kind})\n`);
      }
    }
  }
}

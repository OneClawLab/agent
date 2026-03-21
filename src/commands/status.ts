import { existsSync } from 'node:fs';
import { stat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../config.js';

/**
 * Resolve the agent directory path: ~/.theclaw/agents/<id>/
 */
function agentDir(id: string): string {
  return join(homedir(), '.theclaw', 'agents', id);
}

/**
 * Agents base directory: ~/.theclaw/agents/
 */
function agentsBaseDir(): string {
  return join(homedir(), '.theclaw', 'agents');
}

export interface AgentStatus {
  agent_id: string;
  kind: string;
  started: boolean;
  last_activity: string | null;
}

/**
 * Determine if an agent is "started" by checking whether run.lock exists.
 * run.lock is held while agent run is executing; its presence indicates
 * the agent is actively running (or was running and crashed).
 * We also check if the inbox subscription is active by checking for
 * a subscribers file in the inbox directory.
 */
async function isStarted(dir: string, inboxPath: string): Promise<boolean> {
  // Check run.lock — agent is currently running
  if (existsSync(join(dir, 'run.lock'))) {
    return true;
  }
  // Check for inbox subscribers file — subscription is registered
  const subscribersFile = join(inboxPath, 'subscribers.json');
  if (existsSync(subscribersFile)) {
    try {
      const { readFile } = await import('node:fs/promises');
      const raw = await readFile(subscribersFile, 'utf8');
      const subscribers = JSON.parse(raw);
      // If there's an 'inbox' consumer registered, agent is started
      if (Array.isArray(subscribers)) {
        return subscribers.some((s: { name?: string }) => s.name === 'inbox');
      }
      if (typeof subscribers === 'object' && subscribers !== null) {
        return 'inbox' in subscribers;
      }
    } catch {
      // Can't parse — fall through
    }
  }
  return false;
}

/**
 * Get last activity time from log file mtime, falling back to run.lock mtime.
 */
async function getLastActivity(dir: string): Promise<string | null> {
  const candidates = [
    join(dir, 'logs', 'agent.log'),
    join(dir, 'run.lock'),
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

/**
 * Show status of a specific agent.
 * Requirements: 10.1, 10.3
 */
export async function statusCmd(id: string | undefined, opts: { json?: boolean }): Promise<void> {
  if (!id) {
    const msg = 'Error: agent id is required - usage: agent status <id>';
    if (opts.json) {
      process.stdout.write(JSON.stringify({ error: 'agent id is required', suggestion: 'usage: agent status <id>' }) + '\n');
    } else {
      process.stderr.write(msg + '\n');
    }
    process.exit(1);
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
  const inboxPath = config.inbox.path;
  const started = await isStarted(dir, inboxPath);
  const lastActivity = await getLastActivity(dir);

  const statusInfo: AgentStatus = {
    agent_id: config.agent_id,
    kind: config.kind,
    started,
    last_activity: lastActivity,
  };

  if (opts.json) {
    process.stdout.write(JSON.stringify(statusInfo, null, 2) + '\n');
  } else {
    process.stdout.write(`Agent:         ${statusInfo.agent_id}\n`);
    process.stdout.write(`Kind:          ${statusInfo.kind}\n`);
    process.stdout.write(`Started:       ${statusInfo.started ? 'yes' : 'no'}\n`);
    process.stdout.write(`Last activity: ${statusInfo.last_activity ?? 'none'}\n`);
  }
}

/**
 * List all initialized agents.
 * Requirements: 10.2, 10.3
 */
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
    const dir = join(baseDir, entry);
    const configPath = join(dir, 'config.yaml');
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

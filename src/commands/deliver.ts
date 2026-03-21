import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../config.js';
import { createFireAndForgetLogger } from '../repo-utils/logger.js';
import { deliverBatch } from '../runner/deliver.js';

/**
 * Try to infer the agent directory from the thread path.
 * Thread paths are typically: ~/.theclaw/agents/<id>/threads/...
 * Falls back to undefined if the pattern doesn't match.
 * Uses forward-slash normalisation for cross-platform compatibility.
 */
function inferAgentDir(threadPath: string): string | undefined {
  const base = join(homedir(), '.theclaw', 'agents');
  // Normalise to forward slashes for reliable matching on all platforms
  const normPath = threadPath.replace(/\\/g, '/');
  const normBase = base.replace(/\\/g, '/');
  if (!normPath.startsWith(normBase)) return undefined;
  // Extract the agent id segment after the base
  const rel = normPath.slice(normBase.length + 1); // e.g. "myagent/threads/peers/..."
  const agentId = rel.split('/')[0];
  if (!agentId) return undefined;
  return join(base, agentId);
}

/**
 * Outbound delivery command.
 *
 * Invoked by the outbound consumer handler:
 *   agent deliver --thread <path> --consumer outbound
 *
 * 1. Infer agent dir from thread path (to load config for max_attempts)
 * 2. Load deliver.max_attempts from config (default 3)
 * 3. Call deliverBatch(threadPath, consumerName, maxAttempts)
 *
 * Requirements: 7.1, 7.6
 */
export async function deliverCmd(opts: { thread?: string; consumer?: string }): Promise<void> {
  const threadPath = opts.thread;
  const consumerName = opts.consumer ?? 'outbound';

  if (!threadPath) {
    process.stderr.write('Error: --thread <path> is required - specify the thread path to deliver from\n');
    process.exit(1);
    return; // satisfy TypeScript narrowing
  }

  // Try to load config for max_attempts; fall back to default 3
  let maxAttempts = 3;
  const agentDir = inferAgentDir(threadPath);

  if (agentDir) {
    try {
      const config = await loadConfig(agentDir);
      maxAttempts = config.deliver?.max_attempts ?? 3;
    } catch {
      // Config not loadable — use default, continue
    }
  }

  // Set up logger if we have an agent dir
  const logger = agentDir ? createFireAndForgetLogger(join(agentDir, 'logs'), 'agent') : null;
  logger?.info(`deliver: thread=${threadPath} consumer=${consumerName} maxAttempts=${maxAttempts}`);

  await deliverBatch(threadPath, consumerName, maxAttempts);

  logger?.info(`deliver: completed for thread=${threadPath}`);
}

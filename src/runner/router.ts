import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { execCommand } from '../repo-utils/os.js';
import type { RoutingMode } from '../types.js';

export type { RoutingMode };

export interface RouteResult {
  threadPath: string;
  isNew: boolean;
}

/**
 * Compute the thread directory path based on routing mode.
 *
 * per-peer    → <agentDir>/threads/peers/<channelId>-<peerId>/
 * per-channel → <agentDir>/threads/channels/<channelId>/
 * per-agent   → <agentDir>/threads/main/
 */
export function resolveThreadPath(
  agentDir: string,
  mode: RoutingMode,
  channelId: string,
  peerId: string
): string {
  switch (mode) {
    case 'per-peer':
      return join(agentDir, 'threads', 'peers', `${channelId}-${peerId}`);
    case 'per-channel':
      return join(agentDir, 'threads', 'channels', channelId);
    case 'per-agent':
      return join(agentDir, 'threads', 'main');
  }
}

/**
 * Route a message to the appropriate thread directory.
 * Creates the thread via `thread init` if it doesn't exist yet.
 */
export async function routeMessage(
  agentDir: string,
  mode: RoutingMode,
  channelId: string,
  peerId: string
): Promise<RouteResult> {
  const threadPath = resolveThreadPath(agentDir, mode, channelId, peerId);
  const isNew = !existsSync(threadPath);

  if (isNew) {
    await execCommand('thread', ['init', '--thread', threadPath]);
  }

  return { threadPath, isNew };
}

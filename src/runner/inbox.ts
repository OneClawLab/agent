import { execCommand } from '../repo-utils/os.js';
import type { InboxMessage } from '../types.js';

interface ThreadInfoSubscription {
  consumer_id: string;
  last_acked_id: number;
}

interface ThreadInfo {
  subscriptions: ThreadInfoSubscription[];
}

/**
 * Read the last_acked_id for a consumer from thread info.
 * Returns 0 if the consumer has no progress record yet.
 */
async function getLastAckedId(inboxPath: string, consumerId: string): Promise<number> {
  const { stdout } = await execCommand('thread', ['info', '--thread', inboxPath, '--json']);
  const trimmed = stdout.trim();
  if (!trimmed) return 0;
  let info: unknown;
  try {
    info = JSON.parse(trimmed);
  } catch {
    return 0;
  }
  if (!info || typeof info !== 'object' || !('subscriptions' in info)) return 0;
  const subs = (info as ThreadInfo).subscriptions;
  if (!Array.isArray(subs)) return 0;
  const sub = subs.find(s => s.consumer_id === consumerId);
  return sub?.last_acked_id ?? 0;
}

/**
 * Consume messages from an inbox thread via `thread pop`.
 *
 * If `lastEventId` is provided, it is passed directly to `thread pop`.
 * Otherwise, reads last_acked_id from `thread info` first.
 *
 * @param inboxPath   - Absolute path to the inbox thread directory.
 * @param consumerId  - Consumer identifier registered on the thread.
 * @param lastEventId - Optional override for --last-event-id (skips thread info call).
 * @returns Array of InboxMessage (empty if no new messages).
 */
export async function consumeMessages(
  inboxPath: string,
  consumerId: string,
  lastEventId?: string,
): Promise<InboxMessage[]> {
  const eventId = lastEventId ?? String(await getLastAckedId(inboxPath, consumerId));

  const args = ['pop', '--thread', inboxPath, '--consumer', consumerId];
  if (lastEventId !== undefined) {
    args.push('--last-event-id', eventId);
  } else {
    args.push('--last-event-id', eventId);
  }

  const { stdout } = await execCommand('thread', args);

  const trimmed = stdout.trim();
  if (!trimmed) {
    return [];
  }

  // Support both JSON array output and NDJSON (one object per line)
  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as InboxMessage[];
    return parsed;
  }

  // NDJSON: one JSON object per line
  const lines = trimmed.split('\n').filter(l => l.trim());
  return lines.map(line => JSON.parse(line) as InboxMessage);
}

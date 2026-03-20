import { execCommand } from '../os-utils.js';
import type { InboxMessage } from '../types.js';

/**
 * Consume messages from an inbox thread via `thread pop`.
 *
 * @param inboxPath  - Absolute path to the inbox thread directory.
 * @param consumerId - Consumer identifier registered on the thread.
 * @param lastEventId - Optional: resume from this event ID.
 * @returns Array of InboxMessage (empty if no new messages).
 */
export async function consumeMessages(
  inboxPath: string,
  consumerId: string,
  lastEventId?: string
): Promise<InboxMessage[]> {
  const args = ['pop', '--thread', inboxPath, '--consumer', consumerId];
  if (lastEventId) {
    args.push('--last-event-id', lastEventId);
  }

  const { stdout } = await execCommand('thread', args);

  const trimmed = stdout.trim();
  if (!trimmed || trimmed === '[]') {
    return [];
  }

  const parsed = JSON.parse(trimmed) as InboxMessage[];
  return Array.isArray(parsed) ? parsed : [];
}

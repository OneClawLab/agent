import { execCommand } from '../repo-utils/os.js';
import { pushError } from './recorder.js';
import type { ReplyContext } from '../types.js';

export interface DeliveryEvent {
  eventId: string;
  content: {
    text: string;
    reply_context: ReplyContext;
  };
}

/**
 * Pop pending delivery events from a thread.
 * Returns parsed DeliveryEvent array (empty if none).
 */
async function popEvents(threadPath: string, consumerName: string): Promise<DeliveryEvent[]> {
  const { stdout } = await execCommand('thread', [
    'pop',
    '--thread', threadPath,
    '--consumer', consumerName,
  ]);
  const trimmed = stdout.trim();
  if (!trimmed || trimmed === '[]') return [];
  const parsed = JSON.parse(trimmed);
  return Array.isArray(parsed) ? parsed : [];
}

/**
 * ACK a successfully delivered event.
 */
async function ackEvent(threadPath: string, consumerName: string, eventId: string): Promise<void> {
  await execCommand('thread', [
    'ack',
    '--thread', threadPath,
    '--consumer', consumerName,
    '--event-id', eventId,
  ]);
}

/**
 * Deliver via xgw send for external channel_type.
 * Calls: xgw send --channel <channel_id> --peer <peer_id> --text <text>
 */
export async function execXgwSend(event: DeliveryEvent): Promise<void> {
  const { channel_id, peer_id } = event.content.reply_context;
  await execCommand('xgw', [
    'send',
    '--channel', channel_id,
    '--peer', peer_id,
    '--text', event.content.text,
  ]);
}

/**
 * Deliver via thread push for internal channel_type.
 * Pushes to the source agent's inbox: ~/.theclaw/agents/<source_agent_id>/inbox/
 * Calls: thread push --thread <inbox> --type message --source self --content <JSON>
 */
export async function execThreadPush(event: DeliveryEvent): Promise<void> {
  const { source_agent_id } = event.content.reply_context;
  if (!source_agent_id) {
    throw new Error(`internal delivery requires source_agent_id in reply_context (eventId=${event.eventId})`);
  }
  const inboxPath = `${process.env.HOME ?? '~'}/.theclaw/agents/${source_agent_id}/inbox`;
  await execCommand('thread', [
    'push',
    '--thread', inboxPath,
    '--type', 'message',
    '--source', 'self',
    '--content', JSON.stringify(event.content),
  ]);
}

/**
 * Process a batch of outbound delivery events from a thread.
 *
 * For each event:
 *  - external channel_type → execXgwSend
 *  - internal channel_type → execThreadPush
 *  - On success: ACK the event
 *  - On failure: do NOT ACK (will be retried next dispatch)
 *  - If attempts >= maxAttempts: write error record and skip (ACK to advance)
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5
 */
export async function deliverBatch(
  threadPath: string,
  consumerName: string,
  maxAttempts: number,
  attemptCounts: Map<string, number> = new Map(),
): Promise<void> {
  const events = await popEvents(threadPath, consumerName);

  for (const event of events) {
    const attempts = (attemptCounts.get(event.eventId) ?? 0) + 1;
    attemptCounts.set(event.eventId, attempts);

    if (attempts > maxAttempts) {
      // Already exceeded max attempts on a previous run — write error and skip
      await pushError(threadPath, {
        error: `Delivery failed after ${maxAttempts} attempts`,
        context: `eventId=${event.eventId}`,
      });
      await ackEvent(threadPath, consumerName, event.eventId);
      continue;
    }

    try {
      const { channel_type } = event.content.reply_context;
      if (channel_type === 'external') {
        await execXgwSend(event);
      } else {
        await execThreadPush(event);
      }
      // Success — ACK to advance consumer position
      await ackEvent(threadPath, consumerName, event.eventId);
    } catch {
      // Failure — do NOT ACK; will be retried on next dispatch
      if (attempts >= maxAttempts) {
        // This was the last allowed attempt — write error record and ACK to skip
        await pushError(threadPath, {
          error: `Delivery failed after ${maxAttempts} attempts`,
          context: `eventId=${event.eventId}`,
        });
        await ackEvent(threadPath, consumerName, event.eventId);
      }
      // else: leave un-ACKed for retry
    }
  }
}

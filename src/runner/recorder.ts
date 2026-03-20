import { execCommand } from '../os-utils.js';
import type { ReplyContext } from '../types.js';

/**
 * Push a message event to a thread.
 *
 * Calls: thread push --thread <threadPath> --type message --source <source> --content <JSON>
 *
 * @param threadPath - Absolute path to the target thread directory.
 * @param source     - Original source address (preserved as-is from inbound message).
 * @param content    - Message content payload.
 * @returns The event_id returned by `thread push` (trimmed stdout).
 */
export async function pushMessage(
  threadPath: string,
  source: string,
  content: Record<string, unknown>
): Promise<string> {
  const { stdout } = await execCommand('thread', [
    'push',
    '--thread', threadPath,
    '--type', 'message',
    '--source', source,
    '--content', JSON.stringify(content),
  ]);
  return stdout.trim();
}

/**
 * Push a record event (toolcall, error, etc.) to a thread.
 *
 * Calls: thread push --thread <threadPath> --type record --subtype <subtype>
 *                    --source <source> --content <JSON>
 *
 * @param threadPath - Absolute path to the target thread directory.
 * @param subtype    - Record subtype (e.g. 'toolcall', 'error').
 * @param source     - Source identifier.
 * @param content    - Record content payload.
 * @returns The event_id returned by `thread push` (trimmed stdout).
 */
export async function pushRecord(
  threadPath: string,
  subtype: string,
  source: string,
  content: Record<string, unknown>
): Promise<string> {
  const { stdout } = await execCommand('thread', [
    'push',
    '--thread', threadPath,
    '--type', 'record',
    '--subtype', subtype,
    '--source', source,
    '--content', JSON.stringify(content),
  ]);
  return stdout.trim();
}

/**
 * Push an error record event to a thread.
 * Convenience wrapper around pushRecord with subtype='error', source='self'.
 *
 * @param threadPath - Absolute path to the target thread directory.
 * @param errorInfo  - Error details.
 * @returns The event_id returned by `thread push`.
 */
export async function pushError(
  threadPath: string,
  errorInfo: { error: string; context?: string }
): Promise<string> {
  return pushRecord(threadPath, 'error', 'self', errorInfo as Record<string, unknown>);
}

/**
 * Push the agent's LLM reply as a message event, carrying the original
 * reply_context so the outbound consumer can route it correctly.
 *
 * Requirements 4.6, 6.3: source is 'self'; content includes reply_context.
 *
 * @param threadPath   - Absolute path to the target thread directory.
 * @param replyText    - The LLM reply text.
 * @param replyContext - The reply_context from the original inbound message.
 * @returns The event_id returned by `thread push`.
 */
export async function pushReply(
  threadPath: string,
  replyText: string,
  replyContext: ReplyContext
): Promise<string> {
  return pushMessage(threadPath, 'self', {
    text: replyText,
    reply_context: replyContext,
  });
}

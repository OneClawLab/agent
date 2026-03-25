import { existsSync } from '../repo-utils/fs.js';
import { writeFile, mkdir, unlink } from '../repo-utils/fs.js';
import { homedir } from 'node:os';
import { path } from '../repo-utils/path.js';
import { loadConfig } from '../config.js';
import { buildSystemPrompt } from '../identity.js';
import { createFireAndForgetLogger } from '../repo-utils/logger.js';
import { consumeMessages } from '../runner/inbox.js';
import { routeMessage } from '../runner/router.js';
import { invokeLlm, buildSessionFilePath } from '../runner/llm.js';
import { pushMessage, pushReply, pushRecord } from '../runner/recorder.js';
import { execCommand } from '../repo-utils/os.js';
import { withRetry } from '../errors.js';
import { compactSession } from '../runner/compactor.js';
import type { ReplyContext } from '../types.js';

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/**
 * Resolve the agent directory path: ~/.theclaw/agents/<id>/
 */
function agentDir(id: string): string {
  return path.join(path.toPosixPath(homedir()), '.theclaw', 'agents', id);
}

/**
 * Acquire a file lock by writing PID to run.lock.
 * Returns false if the lock already exists (another run is active).
 */
async function acquireLock(lockPath: string): Promise<boolean> {
  if (existsSync(lockPath)) {
    return false;
  }
  await writeFile(lockPath, String(process.pid), { flag: 'wx' });
  return true;
}

/**
 * Release the file lock by deleting run.lock.
 */
async function releaseLock(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch {
    // Ignore errors — lock may have already been removed
  }
}

/**
 * Register an outbound consumer on a thread so agent replies are delivered.
 *
 * Requirements: 4.8, 7.6
 */
async function registerOutboundConsumer(threadPath: string): Promise<void> {
  await execCommand('thread', [
    'subscribe',
    '--thread', threadPath,
    '--consumer', 'outbound',
    '--handler', `agent deliver --thread ${threadPath} --consumer outbound`,
    '--filter', 'type=message AND source=self',
  ]);
}

/**
 * Core run loop for an agent.
 *
 * 1. Acquire file lock (run.lock) — exit 1 if already locked
 * 2. Load config and identity
 * 3. Consume inbox messages via thread pop
 * 4. If no messages: exit 0
 * 5. For each message:
 *    a. Route to target thread
 *    b. Push inbound message to thread (preserving source)
 *    c. Build system prompt (IDENTITY + memory layers)
 *    d. Run session compaction if needed (context > 80% or every 10 turns)
 *    e. Invoke LLM via pai chat
 *    f. Push reply to thread (with reply_context)
 *    g. Push toolcall records if any
 *    h. Register outbound consumer if thread is new
 * 6. Release file lock
 *
 * Requirements: 4.1–4.10, 8.2, 8.4, 8.5
 */
export async function runCmd(id: string): Promise<void> {
  const dir = agentDir(id);

  // Validate agent directory exists
  if (!existsSync(dir)) {
    process.stderr.write(
      `Error: Agent '${id}' not found at ${dir} - run 'agent init ${id}' first\n`
    );
    process.exit(1);
  }

  const logger = createFireAndForgetLogger(path.join(dir, 'logs'), 'agent');
  const lockPath = path.join(dir, 'run.lock');

  // Requirement 4.10: acquire file lock
  let locked = false;
  try {
    locked = await acquireLock(lockPath);
  } catch {
    // wx flag race — another process won
    locked = false;
  }

  if (!locked) {
    logger.error(`Run lock already held for agent '${id}' — another run is active`);
    process.stderr.write(
      `Error: Agent '${id}' is already running (run.lock exists) - wait for the current run to finish\n`
    );
    process.exit(1);
  }

  logger.info(`Agent '${id}' run started (pid=${process.pid})`);

  try {
    // Requirement 9.1: load config
    const config = await loadConfig(dir);
    const { provider, model } = config.pai;
    const maxRetries = config.retry?.max_attempts ?? 3;
    const contextWindow = config.context_window ?? DEFAULT_CONTEXT_WINDOW;
    const maxOutputTokens = config.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

    // Requirement 4.1: consume inbox messages
    logger.info(`Consuming inbox messages from ${config.inbox.path}`);
    const inboxMessages = await consumeMessages(config.inbox.path, 'inbox');

    // Requirement 4.2: no messages → exit 0
    if (inboxMessages.length === 0) {
      logger.info('No new inbox messages — exiting');
      return;
    }

    logger.info(`Processing ${inboxMessages.length} inbox message(s)`);

    for (const message of inboxMessages) {
      try {
        const content = message.content;
        const replyContext = content.reply_context as ReplyContext | undefined;
        const channelId = replyContext?.channel_id ?? 'unknown';
        const peerId = replyContext?.peer_id ?? 'unknown';

        logger.info(`Routing message from ${message.source} (channel=${channelId}, peer=${peerId})`);

        // Requirement 4.3: route message to target thread
        const { threadPath, isNew } = await routeMessage(
          dir,
          config.routing.default,
          channelId,
          peerId
        );

        const threadId = path.basename(threadPath);
        logger.info(`Routed to thread ${threadPath} (isNew=${isNew})`);

        // Requirement 4.4: push inbound message preserving original source
        await pushMessage(threadPath, message.source, content);

        // Requirement 4.5, 8.1, 8.3: build system prompt with memory layers
        const systemPrompt = await buildSystemPrompt(dir, peerId, threadId);

        // Write system prompt to temp file for pai chat
        await mkdir(path.join(dir, 'sessions'), { recursive: true });
        const systemPromptFile = path.join(dir, 'sessions', `system-prompt-${threadId}.md`);
        await writeFile(systemPromptFile, systemPrompt, 'utf8');

        // Requirement 6.1: session file path
        const sessionFile = buildSessionFilePath(dir, threadId);

        // Requirement 8.2, 8.4, 8.5: compact session if context is too large or interval reached
        await compactSession({
          agentDir: dir,
          threadId,
          sessionFile,
          systemPrompt,
          userMessage: content.text,
          provider,
          model,
          contextWindow,
          maxOutputTokens,
          logger,
        });

        // Requirement 6.2, 4.5: invoke LLM with retry for recoverable errors
        logger.info(`Invoking LLM for thread ${threadId}`);
        let llmResult;
        try {
          llmResult = await withRetry(
            () => invokeLlm({ sessionFile, systemPromptFile, provider, model, userMessage: content.text }),
            maxRetries,
            (err) => {
              const msg = err.message.toLowerCase();
              // Recoverable: network/timeout/rate-limit errors
              return (
                msg.includes('timeout') ||
                msg.includes('rate limit') ||
                msg.includes('network') ||
                msg.includes('econnreset') ||
                msg.includes('econnrefused') ||
                msg.includes('503') ||
                msg.includes('429')
              );
            }
          );
        } catch (err) {
          // Requirement 11.2: non-recoverable error — write error record, continue
          logger.error(`LLM invocation failed for thread ${threadId}: ${(err as Error).message}`);
          await pushRecord(threadPath, 'error', 'self', {
            error: (err as Error).message,
            context: `LLM invocation failed for message from ${message.source}`,
          });
          continue;
        }

        logger.info(`LLM replied for thread ${threadId} (${llmResult.reply.length} chars)`);

        // Requirement 4.6, 6.3: push reply with reply_context
        if (replyContext) {
          await pushReply(threadPath, llmResult.reply, replyContext);
        } else {
          await pushMessage(threadPath, 'self', { text: llmResult.reply });
        }

        // Requirement 4.7: push toolcall records
        if (llmResult.toolCalls?.length) {
          for (const toolCall of llmResult.toolCalls) {
            await pushRecord(threadPath, 'toolcall', 'self', toolCall as unknown as Record<string, unknown>);
          }
          logger.info(`Recorded ${llmResult.toolCalls.length} toolcall(s) for thread ${threadId}`);
        }

        // Requirement 4.8: register outbound consumer for new threads
        if (isNew) {
          logger.info(`Registering outbound consumer for new thread ${threadPath}`);
          try {
            await registerOutboundConsumer(threadPath);
          } catch (err) {
            logger.error(`Failed to register outbound consumer: ${(err as Error).message}`);
          }
        }
      } catch (err) {
        logger.error(`Unhandled error processing message from ${message.source}: ${(err as Error).message}`);
      }
    }

    // Requirement 4.9: inbox consumer progress is updated by thread pop (ACK implicit)
    logger.info(`Agent '${id}' run completed — processed ${inboxMessages.length} message(s)`);
    process.stdout.write(`Agent '${id}' processed ${inboxMessages.length} message(s)\n`);

  } finally {
    // Requirement 4.10: always release file lock
    await releaseLock(lockPath);
    logger.info(`File lock released for agent '${id}'`);
  }
}

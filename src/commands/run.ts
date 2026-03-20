import { existsSync } from 'node:fs';
import { writeFile, unlink, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { loadConfig } from '../config.js';
import { buildSystemPrompt } from '../identity.js';
import { createLogger } from '../logger.js';
import { consumeMessages } from '../runner/inbox.js';
import { routeMessage } from '../runner/router.js';
import { invokeLlm, buildSessionFilePath } from '../runner/llm.js';
import { pushMessage, pushReply, pushRecord } from '../runner/recorder.js';
import { execCommand } from '../os-utils.js';
import { withRetry } from '../errors.js';
import type { ReplyContext } from '../types.js';

/**
 * Resolve the agent directory path: ~/.theclaw/agents/<id>/
 */
function agentDir(id: string): string {
  return join(homedir(), '.theclaw', 'agents', id);
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
 * Estimate token count from a string (rough approximation: 1 token ≈ 4 chars).
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Compress thread memory by summarising conversation history via pai chat.
 * Writes the summary to memory/thread-<threadId>.md.
 *
 * Requirements: 8.4, 8.5
 */
async function compressThreadMemory(
  agentDir: string,
  threadId: string,
  provider: string,
  model: string,
  logger: ReturnType<typeof createLogger>
): Promise<void> {
  const memoryPath = join(agentDir, 'memory', `thread-${threadId}.md`);
  const summarySessionFile = join(agentDir, 'sessions', `compress-${threadId}.jsonl`);
  const systemPromptFile = join(agentDir, 'sessions', `system-compress.md`);

  await mkdir(join(agentDir, 'sessions'), { recursive: true });
  await writeFile(
    systemPromptFile,
    'You are a memory compression assistant. Summarise the conversation history concisely, preserving key facts and context.'
  );

  logger.info(`Compressing thread memory for thread ${threadId}`);

  try {
    const result = await invokeLlm({
      sessionFile: summarySessionFile,
      systemPromptFile,
      provider,
      model,
      userMessage: 'Please summarise the conversation history above into a concise memory summary.',
    });

    await mkdir(join(agentDir, 'memory'), { recursive: true });
    await writeFile(memoryPath, result.reply, 'utf8');
    logger.info(`Thread memory compressed for ${threadId}`);
  } catch (err) {
    logger.error(`Failed to compress thread memory for ${threadId}: ${(err as Error).message}`);
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
 *    d. Optionally compress memory if context is too large
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

  const logger = createLogger(dir);
  const lockPath = join(dir, 'run.lock');

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

    // Requirement 4.1: consume inbox messages
    logger.info(`Consuming inbox messages from ${config.inbox.path}`);
    const messages = await consumeMessages(config.inbox.path, 'inbox');

    // Requirement 4.2: no messages → exit 0
    if (messages.length === 0) {
      logger.info('No new inbox messages — exiting');
      return;
    }

    logger.info(`Processing ${messages.length} inbox message(s)`);

    for (const message of messages) {
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

      const threadId = basename(threadPath);
      logger.info(`Routed to thread ${threadPath} (isNew=${isNew})`);

      // Requirement 4.4: push inbound message preserving original source
      await pushMessage(threadPath, message.source, content);

      // Requirement 4.5, 8.1, 8.3: build system prompt with memory layers
      const systemPrompt = await buildSystemPrompt(dir, peerId, threadId);

      // Requirement 8.2, 8.4: check context size and compress if needed
      const TOKEN_THRESHOLD = 6000;
      if (estimateTokens(systemPrompt) > TOKEN_THRESHOLD) {
        logger.info(`Context exceeds token threshold — compressing thread memory for ${threadId}`);
        await compressThreadMemory(dir, threadId, provider, model, logger);
      }

      // Write system prompt to temp file for pai chat
      await mkdir(join(dir, 'sessions'), { recursive: true });
      const systemPromptFile = join(dir, 'sessions', `system-prompt-${threadId}.md`);
      await writeFile(systemPromptFile, systemPrompt, 'utf8');

      // Requirement 6.1: session file path
      const sessionFile = buildSessionFilePath(dir, threadId);

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
          await pushRecord(threadPath, 'toolcall', 'self', toolCall as Record<string, unknown>);
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
    }

    // Requirement 4.9: inbox consumer progress is updated by thread pop (ACK implicit)
    logger.info(`Agent '${id}' run completed — processed ${messages.length} message(s)`);
    process.stdout.write(`Agent '${id}' processed ${messages.length} message(s)\n`);

  } finally {
    // Requirement 4.10: always release file lock
    await releaseLock(lockPath);
    logger.info(`File lock released for agent '${id}'`);
  }
}

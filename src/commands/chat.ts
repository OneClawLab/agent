import { existsSync } from '../repo-utils/fs.js';
import { writeFile, mkdir } from '../repo-utils/fs.js';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { path } from '../repo-utils/path.js';
import { loadConfig } from '../config.js';
import { buildSystemPrompt } from '../identity.js';
import { routeMessage } from '../runner/router.js';
import { invokeLlm, buildSessionFilePath } from '../runner/llm.js';
import { pushMessage, pushReply } from '../runner/recorder.js';
import { execCommand } from '../repo-utils/os.js';
import { withRetry } from '../errors.js';
import type { ReplyContext } from '../types.js';

// Fixed identifiers for CLI chat sessions
const CLI_CHANNEL = 'cli';
const CLI_PEER = 'cli';
const CLI_SOURCE = 'internal:cli';

function agentDir(id: string): string {
  return path.join(path.toPosixPath(homedir()), '.theclaw', 'agents', id);
}

/**
 * agent chat <id>
 *
 * Interactive REPL that talks directly to an agent without xgw or notifier.
 * Each turn:
 *   1. Read user input from stdin
 *   2. Route to a fixed cli-cli thread (per-peer routing with channel=cli, peer=cli)
 *   3. Push user message to thread
 *   4. Invoke LLM (pai chat) synchronously
 *   5. Push reply to thread
 *   6. Print reply to stdout
 *
 * The session persists across invocations (same thread + session file).
 * Use Ctrl+C or Ctrl+D to exit.
 */
export async function chatCmd(id: string): Promise<void> {
  const dir = agentDir(id);

  if (!existsSync(dir)) {
    process.stderr.write(
      `Error: Agent '${id}' not found at ${dir} - run 'agent init ${id}' first\n`
    );
    process.exit(1);
  }

  const config = await loadConfig(dir);
  const { provider, model } = config.pai;
  const maxRetries = config.retry?.max_attempts ?? 3;

  // Ensure the cli-cli thread exists (reuse across sessions)
  const { threadPath } = await routeMessage(dir, 'per-peer', CLI_CHANNEL, CLI_PEER);
  const threadId = path.basename(threadPath);

  // Register a no-op consumer on the thread if not already present,
  // so thread pop works. We use 'chat' as the consumer name.
  // thread subscribe is idempotent-ish — ignore error if already exists.
  try {
    await execCommand('thread', [
      'subscribe',
      '--thread', threadPath,
      '--consumer', 'chat',
      '--handler', 'true',
      '--filter', "type = 'message' AND source = 'self'",
    ]);
  } catch {
    // Already subscribed — that's fine
  }

  const replyContext: ReplyContext = {
    channel_type: 'internal',
    channel_id: CLI_CHANNEL,
    peer_id: CLI_PEER,
    source_agent_id: 'cli',
  };

  process.stdout.write(`Chatting with agent '${id}' (Ctrl+C or Ctrl+D to exit)\n\n`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY,
  });

  const prompt = () => {
    if (process.stdin.isTTY) {
      process.stdout.write('> ');
    }
  };

  const handleLine = async (line: string): Promise<void> => {
    const text = line.trim();
    if (!text) {
      prompt();
      return;
    }

    rl.pause();

    try {
      // Push user message to thread
      await pushMessage(threadPath, CLI_SOURCE, { text, reply_context: replyContext });

      // Build system prompt with current memory state
      const systemPrompt = await buildSystemPrompt(dir, CLI_PEER, threadId);
      await mkdir(path.join(dir, 'sessions'), { recursive: true });
      const systemPromptFile = path.join(dir, 'sessions', `system-prompt-${threadId}.md`);
      await writeFile(systemPromptFile, systemPrompt, 'utf8');

      const sessionFile = buildSessionFilePath(dir, threadId);

      // Invoke LLM synchronously
      const result = await withRetry(
        () => invokeLlm({ sessionFile, systemPromptFile, provider, model, userMessage: text }),
        maxRetries,
        (err) => {
          const msg = err.message.toLowerCase();
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

      // Push reply to thread
      await pushReply(threadPath, result.reply, replyContext);

      // Print reply
      process.stdout.write(`\n${result.reply}\n\n`);
    } catch (err) {
      process.stderr.write(`Error: ${(err as Error).message}\n\n`);
    }

    rl.resume();
    prompt();
  };

  rl.on('line', (line) => {
    void handleLine(line);
  });

  rl.on('close', () => {
    process.stdout.write('\n');
    process.exit(0);
  });

  prompt();
}

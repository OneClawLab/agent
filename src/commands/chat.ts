import { existsSync } from '../repo-utils/fs.js';
import { writeFile, mkdir } from '../repo-utils/fs.js';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { path } from '../repo-utils/path.js';
import { loadConfig } from '../config.js';
import { buildSystemPrompt } from '../identity.js';
import { routeMessage } from '../runner/router.js';
import { invokeLlm, buildSessionFilePath } from '../runner/llm.js';
import type { PaiProgressEvent } from '../runner/llm.js';
import { pushMessage, pushReply } from '../runner/recorder.js';
import { execCommand } from '../repo-utils/os.js';
import { withRetry } from '../errors.js';
import { compactSession } from '../runner/compactor.js';
import { estimateTokens, estimateMessageTokens, loadSessionMessages } from '../runner/session.js';
import type { ReplyContext } from '../types.js';

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

// Fixed identifiers for CLI chat sessions
const CLI_CHANNEL = 'cli';
const CLI_PEER = 'cli';
const CLI_SOURCE = 'internal:cli';

// Section separator printed to stderr before progress output
// (removed — replaced by inline "--- working..." header)

function agentDir(id: string): string {
  return path.join(path.toPosixPath(homedir()), '.theclaw', 'agents', id);
}

// ─── Progress rendering ───────────────────────────────────────────────────────

const INDENT = '    ';
const LINE_MAX = 120;
const MULTILINE_MAX_LINES = 3;

/**
 * Truncate a string to maxLen, appending "…(Nc)" if cut.
 */
function truncate(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen) + `…(${s.length - maxLen} chars)`;
}

/**
 * Render a value (command text or result text) as either:
 *   - single line: prefix + truncated text on same line
 *   - multi-line:  prefix on its own line, then indented lines (max 3) + "…" if more
 *
 * @param prefix   e.g. "command:" or "✓" or "✗"
 * @param text     the content to display
 * @param indent   indentation string for multi-line body
 */
function renderInlineOrBlock(prefix: string, text: string, indent: string): string {
  const nonEmptyLines = text.split('\n').map(l => l.trimEnd()).filter(l => l.length > 0);
  const isMultiLine = nonEmptyLines.length > 1;

  if (!isMultiLine) {
    const line = nonEmptyLines[0] ?? '';
    const truncated = line.length > LINE_MAX;
    const display = truncated ? line.slice(0, LINE_MAX) + `…(${line.length - LINE_MAX} chars)` : line;
    return `${prefix} ${display}\n`;
  }

  // Multi-line — prefix on its own line, body indented
  const shown = nonEmptyLines.slice(0, MULTILINE_MAX_LINES);
  const omitted = nonEmptyLines.length - MULTILINE_MAX_LINES;
  const bodyLines = shown.map(l => {
    const truncated = l.length > LINE_MAX;
    return `${indent}${truncated ? l.slice(0, LINE_MAX) + `…(${l.length - LINE_MAX} chars)` : l}`;
  });
  const suffix = omitted > 0 ? `\n${indent}…(${omitted} lines)` : '';
  return `${prefix}\n${bodyLines.join('\n')}${suffix}\n`;
}

/**
 * Render a bash_exec tool_call event to stderr in a human-friendly format.
 *
 * Output format (single-line command):
 *   ▶ <comment>
 *     command: <cmd>  cwd: <cwd>  timeout: <t>s
 *
 * Output format (multi-line command):
 *   ▶ <comment>
 *     command:
 *       line1
 *       line2
 *       line3
 *       …
 *     cwd: <cwd>  timeout: <t>s
 */
function renderToolCall(data: unknown): void {
  if (typeof data !== 'object' || data === null) {
    process.stderr.write(`  tool_call: ${JSON.stringify(data)}\n`);
    return;
  }

  const d = data as Record<string, unknown>;
  const name = typeof d['name'] === 'string' ? d['name'] : 'unknown';

  if (name !== 'bash_exec') {
    process.stderr.write(`  tool_call: ${name}(${JSON.stringify(d['arguments'] ?? {})})\n`);
    return;
  }

  const args = (typeof d['arguments'] === 'object' && d['arguments'] !== null)
    ? d['arguments'] as Record<string, unknown>
    : {};

  const comment = typeof args['comment'] === 'string' ? args['comment'].trim() : '';
  const command = typeof args['command'] === 'string' ? args['command'].trim() : '';
  const cwd = typeof args['cwd'] === 'string' ? args['cwd'] : '';
  const timeout = args['timeout_seconds'] !== undefined ? String(args['timeout_seconds']) : '';

  // Line 1: human-readable comment
  process.stderr.write(`  ▶ ${comment || 'bash_exec'}\n`);

  // Command block
  if (command) {
    process.stderr.write(renderInlineOrBlock(`${INDENT}command:`, command, `${INDENT}  `));
  }

  // cwd / timeout on a separate line
  const meta: string[] = [];
  if (cwd) meta.push(`cwd: ${cwd}`);
  if (timeout) meta.push(`timeout: ${timeout}s`);
  if (meta.length > 0) {
    process.stderr.write(`${INDENT}${meta.join('  ')}\n`);
  }
}

/**
 * Render a tool_result event to stderr.
 *
 * Success (exitCode === 0):  ✓ <output>
 * Failure (exitCode !== 0):  ✗ <output>
 *
 * Output follows the same single/multi-line rules as renderInlineOrBlock.
 */
function renderToolResult(data: unknown): void {
  if (typeof data !== 'object' || data === null) {
    process.stderr.write(`  ✓ ${truncate(JSON.stringify(data), LINE_MAX)}\n`);
    return;
  }

  const d = data as Record<string, unknown>;
  const exitCode = d['exitCode'] !== undefined ? d['exitCode'] : d['exit_code'];
  const stdout = typeof d['stdout'] === 'string' ? d['stdout'] : '';
  const stderr = typeof d['stderr'] === 'string' ? d['stderr'] : '';
  const errMsg = typeof d['error'] === 'string' ? d['error'] : '';

  const isSuccess = exitCode === 0 || exitCode === undefined;
  const icon = isSuccess ? '✓' : '✗';
  const prefix = `  ${icon}`;

  const content = errMsg || [stdout, stderr].filter(s => s.trim()).join('\n').trim();

  if (!content) {
    process.stderr.write(`${prefix} (no output)\n`);
    return;
  }

  process.stderr.write(renderInlineOrBlock(prefix, content, `${INDENT}`));
}

interface CtxParams {
  sessionFile: string;
  systemPrompt: string;
  contextWindow: number;
  maxOutputTokens: number;
  userMessage: string;
}

function makeProgressHandler(ctx: CtxParams): { onProgress: (event: PaiProgressEvent) => void; printCtx: () => void } {
  const inputBudget = ctx.contextWindow - ctx.maxOutputTokens - 512;
  const toK = (n: number): string => `${Math.round(n / 1000)}K`;

  const printCtx = async (): Promise<void> => {
    try {
      const msgs = await loadSessionMessages(ctx.sessionFile);
      const total = estimateTokens(ctx.systemPrompt) +
        msgs.reduce((s, m) => s + estimateMessageTokens(m), 0) +
        estimateTokens(ctx.userMessage) + 4;
      const pct = Math.round((total / inputBudget) * 100);
      process.stderr.write(`\n\nctx: ${pct}% (${toK(total)}/${toK(inputBudget)})\n`);
    } catch {
      // session may not exist yet
    }
  };

  const onProgress = (event: PaiProgressEvent): void => {
    switch (event.type) {
      case 'start':
        process.stderr.write(`\n--- working...\n`);
        break;
      case 'tool_call':
        renderToolCall(event.data);
        break;
      case 'tool_result':
        renderToolResult(event.data);
        break;
      case 'complete':
        break;
      case 'error': {
        const msg = typeof event.data === 'string' ? event.data : JSON.stringify(event.data);
        process.stderr.write(`  error: ${msg}\n`);
        break;
      }
      default:
        break;
    }
  };

  return { onProgress, printCtx };
}

// ─── Chat command ─────────────────────────────────────────────────────────────

/**
 * agent chat <id>
 *
 * Interactive REPL that talks directly to an agent without xgw or notifier.
 * Each turn:
 *   1. Read user input from stdin
 *   2. Route to a fixed cli-cli thread (per-peer routing with channel=cli, peer=cli)
 *   3. Push user message to thread
 *   4. Invoke LLM via `pai chat --stream --json` (streaming)
 *      - stderr section: progress events (tool calls, results, token usage)
 *      - stdout section: final reply text
 *   5. Push reply to thread
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
  const contextWindow = config.context_window ?? DEFAULT_CONTEXT_WINDOW;
  const maxOutputTokens = config.max_output_tokens ?? DEFAULT_MAX_OUTPUT_TOKENS;

  // Ensure the cli-cli thread exists (reuse across sessions)
  const { threadPath } = await routeMessage(dir, 'per-peer', CLI_CHANNEL, CLI_PEER);
  const threadId = path.basename(threadPath);

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
    prompt: 'Q: ',
  });

  let processing = false;

  const handleLine = async (line: string): Promise<void> => {
    const text = line.trim();
    if (!text || processing) {
      return;
    }

    processing = true;

    try {
      // Push user message to thread
      await pushMessage(threadPath, CLI_SOURCE, { text, reply_context: replyContext });

      // Build system prompt with current memory state
      const systemPrompt = await buildSystemPrompt(dir, CLI_PEER, threadId);
      await mkdir(path.join(dir, 'sessions'), { recursive: true });
      const systemPromptFile = path.join(dir, 'sessions', `system-prompt-${threadId}.md`);
      await writeFile(systemPromptFile, systemPrompt, 'utf8');

      const sessionFile = buildSessionFilePath(dir, threadId);

      // Compact session if context is too large
      await compactSession({
        agentDir: dir,
        threadId,
        sessionFile,
        systemPrompt,
        userMessage: text,
        provider,
        model,
        contextWindow,
        maxOutputTokens,
        logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {}, close: async () => {} },
      });

      // ── Progress section (stderr) ──────────────────────────────────────
      // (header printed by 'start' progress event as "--- working...")

      // Print "A:" header before first streaming chunk arrives
      let replyHeaderPrinted = false;
      const onChunk = (chunk: string): void => {
        if (!replyHeaderPrinted) {
          process.stdout.write(`\nA:\n`);
          replyHeaderPrinted = true;
        }
        process.stdout.write(chunk);
      };

      const { onProgress, printCtx } = makeProgressHandler({ sessionFile, systemPrompt, contextWindow, maxOutputTokens, userMessage: text });

      const result = await withRetry(
        () => invokeLlm({
          sessionFile,
          systemPromptFile,
          provider,
          model,
          userMessage: text,
          onProgress,
          onChunk,
        }),
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

      process.stderr.write(`\n`);

      // Push reply to thread
      await pushReply(threadPath, result.reply, replyContext);

      // Print ctx after session file is fully written
      await printCtx();

      // Ensure trailing newlines after streamed reply (onChunk already wrote the content)
      if (replyHeaderPrinted) {
        process.stdout.write(`\n\n`);
      } else {
        // Fallback: no chunks received, print full reply at once
        process.stdout.write(`\nA:\n${result.reply}\n\n`);
      }
    } catch (err) {
      process.stderr.write(`\nError: ${(err as Error).message}\n\n`);
    }

    processing = false;
    rl.prompt();
  };

  rl.on('line', (line) => {
    void handleLine(line);
  });

  rl.on('close', () => {
    process.stdout.write('\n');
    process.exit(0);
  });

  rl.prompt();
}

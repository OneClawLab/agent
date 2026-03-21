import { execCommand } from '../repo-utils/os.js';
import type { ToolCall } from '../types.js';

export interface LlmInvokeParams {
  sessionFile: string;
  systemPromptFile: string;
  provider: string;
  model: string;
  userMessage: string;
}

export interface LlmResult {
  reply: string;
  toolCalls?: ToolCall[];
}

/**
 * Build the session file path for a given agent dir and thread id.
 * Convention: <agentDir>/sessions/<threadId>.jsonl
 */
export function buildSessionFilePath(agentDir: string, threadId: string): string {
  return `${agentDir}/sessions/${threadId}.jsonl`;
}

/**
 * Invoke the LLM via `pai chat`.
 *
 * Command:
 *   pai chat --session <sessionFile> --system-file <systemPromptFile>
 *            --provider <provider> --model <model> <userMessage>
 *
 * Parses stdout as the reply text. If stdout is valid JSON containing a
 * `toolCalls` array, those are extracted as well.
 */
export async function invokeLlm(params: LlmInvokeParams): Promise<LlmResult> {
  const { sessionFile, systemPromptFile, provider, model, userMessage } = params;

  const args = [
    'chat',
    '--session', sessionFile,
    '--system-file', systemPromptFile,
    '--provider', provider,
    '--model', model,
    userMessage,
  ];

  const { stdout } = await execCommand('pai', args, 120_000, 10);

  const text = stdout.trim();

  // Try to parse as JSON — pai may return structured output with toolCalls
  try {
    const parsed = JSON.parse(text) as { reply?: string; toolCalls?: ToolCall[] };
    if (typeof parsed === 'object' && parsed !== null && 'reply' in parsed) {
      return {
        reply: parsed.reply ?? '',
        ...(parsed.toolCalls?.length ? { toolCalls: parsed.toolCalls } : {}),
      };
    }
  } catch {
    // Not JSON — treat the whole stdout as plain reply text
  }

  return { reply: text };
}

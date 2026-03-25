import { spawn } from 'node:child_process';
import { execSync } from 'node:child_process';
import type { ToolCall } from '../types.js';

export interface LlmInvokeParams {
  sessionFile: string;
  systemPromptFile: string;
  provider: string;
  model: string;
  userMessage: string;
  onProgress?: (event: PaiProgressEvent) => void;
  /** Called with each stdout chunk as it arrives (streaming tokens). */
  onChunk?: (chunk: string) => void;
}

export interface LlmResult {
  reply: string;
  toolCalls?: ToolCall[];
}

/** Parsed NDJSON event from pai --json stderr */
export interface PaiProgressEvent {
  type: 'start' | 'chunk' | 'tool_call' | 'tool_result' | 'complete' | 'error';
  data: unknown;
  timestamp?: number;
}

const IS_WIN32 = process.platform === 'win32';

/**
 * Build the session file path for a given agent dir and thread id.
 * Convention: <agentDir>/sessions/<threadId>.jsonl
 */
export function buildSessionFilePath(agentDir: string, threadId: string): string {
  return `${agentDir}/sessions/${threadId}.jsonl`;
}

/**
 * Invoke the LLM via `pai chat --stream --json`.
 *
 * stdout: streaming model text (accumulated as reply)
 * stderr: NDJSON progress events (tool_call, tool_result, complete, etc.)
 *
 * onProgress is called for each parsed stderr event in real time.
 */
export async function invokeLlm(params: LlmInvokeParams): Promise<LlmResult> {
  const { sessionFile, systemPromptFile, provider, model, userMessage, onProgress, onChunk } = params;

  const paiArgs = [
    'chat',
    '--stream',
    '--json',
    '--session', sessionFile,
    '--system-file', systemPromptFile,
    '--provider', provider,
    '--model', model,
    userMessage,
  ];

  const spawnCmd = IS_WIN32 ? 'sh' : 'pai';
  const spawnArgs = IS_WIN32
    ? ['-c', ['pai', ...paiArgs.map(a => `'${a.replace(/'/g, "'\\''")}'`)].join(' ')]
    : paiArgs;

  return new Promise((resolve, reject) => {
    const proc = spawn(spawnCmd, spawnArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });

    let stdoutBuf = '';
    let stderrBuf = '';

    proc.stdout!.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdoutBuf += text;
      onChunk?.(text);
    });

    proc.stderr!.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf8');
      // Parse complete NDJSON lines as they arrive
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as PaiProgressEvent;
          onProgress?.(event);
        } catch {
          // Non-JSON stderr line — ignore
        }
      }
    });

    // Timeout: 1 hour (same as before)
    const timer = setTimeout(() => {
      if (IS_WIN32 && proc.pid !== undefined) {
        try { execSync(`taskkill /F /T /PID ${proc.pid}`, { stdio: 'ignore' }); } catch { /* dead */ }
      }
      try { proc.kill('SIGKILL'); } catch { /* dead */ }
      reject(new Error('pai chat timed out after 3600s'));
    }, 3_600_000);

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    proc.on('close', (code) => {
      clearTimeout(timer);

      // Flush any remaining stderr
      if (stderrBuf.trim()) {
        try {
          const event = JSON.parse(stderrBuf.trim()) as PaiProgressEvent;
          onProgress?.(event);
        } catch { /* ignore */ }
      }

      if (code !== 0) {
        reject(new Error(`pai chat exited with code ${code}`));
        return;
      }

      const text = stdoutBuf.trim();

      // Try to parse as JSON (pai --json may wrap the final reply)
      try {
        const parsed = JSON.parse(text) as { reply?: string; toolCalls?: ToolCall[] };
        if (typeof parsed === 'object' && parsed !== null && 'reply' in parsed) {
          resolve({
            reply: parsed.reply ?? '',
            ...(parsed.toolCalls?.length ? { toolCalls: parsed.toolCalls } : {}),
          });
          return;
        }
      } catch { /* not JSON */ }

      resolve({ reply: text });
    });
  });
}

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Load the IDENTITY.md content for an agent.
 * Throws if the file does not exist or cannot be read.
 */
export async function loadIdentity(agentDir: string): Promise<string> {
  const identityPath = join(agentDir, 'IDENTITY.md');
  try {
    return await readFile(identityPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `IDENTITY.md not found: ${identityPath} - create an IDENTITY.md in the agent directory`
      );
    }
    throw new Error(
      `Failed to read IDENTITY.md at ${identityPath}: ${(err as Error).message}`
    );
  }
}

/**
 * Read a file and return its content, or null if the file does not exist.
 */
async function readOptional(filePath: string): Promise<string | null> {
  try {
    return await readFile(filePath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Build the full system prompt for an LLM call.
 *
 * Assembles: IDENTITY.md + memory/agent.md + memory/user-<peerId>.md + memory/thread-<threadId>.md
 * Missing memory files are silently skipped.
 */
export async function buildSystemPrompt(
  agentDir: string,
  peerId?: string,
  threadId?: string
): Promise<string> {
  const identity = await loadIdentity(agentDir);

  const memoryDir = join(agentDir, 'memory');

  const agentMemory = await readOptional(join(memoryDir, 'agent.md'));
  const userMemory = peerId
    ? await readOptional(join(memoryDir, `user-${peerId}.md`))
    : null;
  const threadMemory = threadId
    ? await readOptional(join(memoryDir, `thread-${threadId}.md`))
    : null;

  const parts = [identity];
  if (agentMemory) parts.push(agentMemory);
  if (userMemory) parts.push(userMemory);
  if (threadMemory) parts.push(threadMemory);

  return parts.join('\n\n');
}

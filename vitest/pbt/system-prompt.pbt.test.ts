// Feature: agent-runtime, Property 4: System Prompt 组装完整性

import { describe, it, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect } from 'vitest';
import { buildSystemPrompt } from '../../src/identity.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'agent-pbt-sysprompt-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Arbitraries ──────────────────────────────────────────────────────────────

/** Safe non-empty content strings (no path separators) */
const contentArb = fc.stringMatching(/^[a-zA-Z0-9 _\-\.\n]{1,200}$/);

/** Safe identifiers for peerId and threadId */
const idArb = fc.stringMatching(/^[a-zA-Z0-9_-]{1,32}$/);

/** Optional content: present (Some string) or absent (null) */
const optionalContentArb = fc.option(contentArb, { nil: null });

// ── Property 4: System Prompt 组装完整性 ──────────────────────────────────────
// Validates: Requirements 4.5, 8.1, 8.3

describe('Property 4: System Prompt 组装完整性', () => {
  it('output always contains IDENTITY.md content', async () => {
    await fc.assert(
      fc.asyncProperty(
        contentArb,
        optionalContentArb, // agent.md
        fc.option(fc.tuple(idArb, contentArb), { nil: null }), // peerId + user memory
        fc.option(fc.tuple(idArb, contentArb), { nil: null }), // threadId + thread memory
        async (identityContent, agentMemory, userEntry, threadEntry) => {
          const dir = await mkdtemp(join(tmpdir(), 'p4a-'));
          try {
            await writeFile(join(dir, 'IDENTITY.md'), identityContent);
            const memDir = join(dir, 'memory');
            await mkdir(memDir, { recursive: true });

            if (agentMemory !== null) {
              await writeFile(join(memDir, 'agent.md'), agentMemory);
            }

            const peerId = userEntry ? userEntry[0] : undefined;
            const threadId = threadEntry ? threadEntry[0] : undefined;

            if (userEntry) {
              await writeFile(join(memDir, `user-${userEntry[0]}.md`), userEntry[1]);
            }
            if (threadEntry) {
              await writeFile(join(memDir, `thread-${threadEntry[0]}.md`), threadEntry[1]);
            }

            const result = await buildSystemPrompt(dir, peerId, threadId);
            expect(result).toContain(identityContent);
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('output contains all existing memory layer contents in order (agent → user → thread)', async () => {
    await fc.assert(
      fc.asyncProperty(
        contentArb,
        optionalContentArb, // agent.md
        fc.option(fc.tuple(idArb, contentArb), { nil: null }), // peerId + user memory
        fc.option(fc.tuple(idArb, contentArb), { nil: null }), // threadId + thread memory
        async (identityContent, agentMemory, userEntry, threadEntry) => {
          const dir = await mkdtemp(join(tmpdir(), 'p4b-'));
          try {
            // Use unique sentinel wrappers so indexOf is unambiguous even with duplicate content
            const identityWrapped = `IDENTITY_START:${identityContent}:IDENTITY_END`;
            const agentWrapped = agentMemory !== null ? `AGENT_START:${agentMemory}:AGENT_END` : null;
            const userWrapped = userEntry ? `USER_START:${userEntry[1]}:USER_END` : null;
            const threadWrapped = threadEntry ? `THREAD_START:${threadEntry[1]}:THREAD_END` : null;

            await writeFile(join(dir, 'IDENTITY.md'), identityWrapped);
            const memDir = join(dir, 'memory');
            await mkdir(memDir, { recursive: true });

            if (agentWrapped !== null) {
              await writeFile(join(memDir, 'agent.md'), agentWrapped);
            }

            const peerId = userEntry ? userEntry[0] : undefined;
            const threadId = threadEntry ? threadEntry[0] : undefined;

            if (userWrapped && userEntry) {
              await writeFile(join(memDir, `user-${userEntry[0]}.md`), userWrapped);
            }
            if (threadWrapped && threadEntry) {
              await writeFile(join(memDir, `thread-${threadEntry[0]}.md`), threadWrapped);
            }

            const result = await buildSystemPrompt(dir, peerId, threadId);

            // All existing memory layers must appear in result
            expect(result).toContain(identityWrapped);
            if (agentWrapped !== null) expect(result).toContain(agentWrapped);
            if (userWrapped) expect(result).toContain(userWrapped);
            if (threadWrapped) expect(result).toContain(threadWrapped);

            // Order: identity → agent → user → thread (sentinels guarantee unique positions)
            const identityPos = result.indexOf(identityWrapped);
            if (agentWrapped !== null) {
              expect(result.indexOf(agentWrapped)).toBeGreaterThan(identityPos);
            }
            if (userWrapped && agentWrapped !== null) {
              expect(result.indexOf(userWrapped)).toBeGreaterThan(result.indexOf(agentWrapped));
            }
            if (userWrapped && agentWrapped === null) {
              expect(result.indexOf(userWrapped)).toBeGreaterThan(identityPos);
            }
            if (threadWrapped && userWrapped) {
              expect(result.indexOf(threadWrapped)).toBeGreaterThan(result.indexOf(userWrapped));
            }
            if (threadWrapped && !userWrapped && agentWrapped !== null) {
              expect(result.indexOf(threadWrapped)).toBeGreaterThan(result.indexOf(agentWrapped));
            }
            if (threadWrapped && !userWrapped && agentWrapped === null) {
              expect(result.indexOf(threadWrapped)).toBeGreaterThan(identityPos);
            }
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  it('output does not contain content from non-existent memory files', async () => {
    await fc.assert(
      fc.asyncProperty(
        contentArb,       // identity
        contentArb,       // absent agent memory content (not written)
        idArb,            // peerId (no file written)
        idArb,            // threadId (no file written)
        contentArb,       // absent user memory content (not written)
        contentArb,       // absent thread memory content (not written)
        async (identityContent, absentAgent, peerId, threadId, absentUser, absentThread) => {
          const dir = await mkdtemp(join(tmpdir(), 'p4c-'));
          try {
            await writeFile(join(dir, 'IDENTITY.md'), identityContent);
            await mkdir(join(dir, 'memory'), { recursive: true });
            // Intentionally do NOT write any memory files

            const result = await buildSystemPrompt(dir, peerId, threadId);

            // Result should only be the identity content (no extra sections)
            expect(result.trim()).toBe(identityContent.trim());
          } finally {
            await rm(dir, { recursive: true, force: true });
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

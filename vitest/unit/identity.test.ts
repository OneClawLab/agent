import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadIdentity, buildSystemPrompt } from '../../src/identity.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'agent-identity-test-'));
  await mkdir(join(tmpDir, 'memory'), { recursive: true });
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('loadIdentity', () => {
  it('reads IDENTITY.md content', async () => {
    await writeFile(join(tmpDir, 'IDENTITY.md'), 'You are a helpful agent.');
    const result = await loadIdentity(tmpDir);
    expect(result).toBe('You are a helpful agent.');
  });

  it('throws descriptive error when IDENTITY.md is missing', async () => {
    await expect(loadIdentity(tmpDir)).rejects.toThrow(/IDENTITY\.md not found/);
    await expect(loadIdentity(tmpDir)).rejects.toThrow(/create an IDENTITY\.md/);
  });
});

describe('buildSystemPrompt', () => {
  it('returns only identity when no memory files exist', async () => {
    await writeFile(join(tmpDir, 'IDENTITY.md'), 'Identity content');
    const result = await buildSystemPrompt(tmpDir);
    expect(result).toBe('Identity content');
  });

  it('includes agent.md when it exists', async () => {
    await writeFile(join(tmpDir, 'IDENTITY.md'), 'Identity');
    await writeFile(join(tmpDir, 'memory', 'agent.md'), 'Agent memory');
    const result = await buildSystemPrompt(tmpDir);
    expect(result).toBe('Identity\n\nAgent memory');
  });

  it('includes user memory when peerId is provided and file exists', async () => {
    await writeFile(join(tmpDir, 'IDENTITY.md'), 'Identity');
    await writeFile(join(tmpDir, 'memory', 'user-alice.md'), 'User alice memory');
    const result = await buildSystemPrompt(tmpDir, 'alice');
    expect(result).toBe('Identity\n\nUser alice memory');
  });

  it('includes thread memory when threadId is provided and file exists', async () => {
    await writeFile(join(tmpDir, 'IDENTITY.md'), 'Identity');
    await writeFile(join(tmpDir, 'memory', 'thread-t1.md'), 'Thread t1 memory');
    const result = await buildSystemPrompt(tmpDir, undefined, 't1');
    expect(result).toBe('Identity\n\nThread t1 memory');
  });

  it('assembles all three memory layers in order', async () => {
    await writeFile(join(tmpDir, 'IDENTITY.md'), 'Identity');
    await writeFile(join(tmpDir, 'memory', 'agent.md'), 'Agent memory');
    await writeFile(join(tmpDir, 'memory', 'user-bob.md'), 'User bob memory');
    await writeFile(join(tmpDir, 'memory', 'thread-t2.md'), 'Thread t2 memory');

    const result = await buildSystemPrompt(tmpDir, 'bob', 't2');
    expect(result).toBe('Identity\n\nAgent memory\n\nUser bob memory\n\nThread t2 memory');
  });

  it('silently skips missing agent.md', async () => {
    await writeFile(join(tmpDir, 'IDENTITY.md'), 'Identity');
    await writeFile(join(tmpDir, 'memory', 'user-bob.md'), 'User bob memory');
    const result = await buildSystemPrompt(tmpDir, 'bob');
    expect(result).toBe('Identity\n\nUser bob memory');
  });

  it('silently skips missing user memory when peerId provided', async () => {
    await writeFile(join(tmpDir, 'IDENTITY.md'), 'Identity');
    await writeFile(join(tmpDir, 'memory', 'agent.md'), 'Agent memory');
    const result = await buildSystemPrompt(tmpDir, 'nonexistent-peer');
    expect(result).toBe('Identity\n\nAgent memory');
  });

  it('silently skips missing thread memory when threadId provided', async () => {
    await writeFile(join(tmpDir, 'IDENTITY.md'), 'Identity');
    const result = await buildSystemPrompt(tmpDir, undefined, 'nonexistent-thread');
    expect(result).toBe('Identity');
  });

  it('does not look up user memory when peerId is undefined', async () => {
    await writeFile(join(tmpDir, 'IDENTITY.md'), 'Identity');
    // Even if a user file exists, it should not be included without a peerId
    await writeFile(join(tmpDir, 'memory', 'user-alice.md'), 'Should not appear');
    const result = await buildSystemPrompt(tmpDir);
    expect(result).toBe('Identity');
  });

  it('throws when IDENTITY.md is missing', async () => {
    await expect(buildSystemPrompt(tmpDir)).rejects.toThrow(/IDENTITY\.md not found/);
  });
});

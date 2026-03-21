import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadConfig } from '../../src/config.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'agent-config-test-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('loads a complete config.yaml correctly', async () => {
    await writeFile(
      join(tmpDir, 'config.yaml'),
      `
agent_id: test-agent
kind: user
pai:
  provider: openai
  model: gpt-4o
inbox:
  path: /home/user/.theclaw/agents/test-agent/inbox
routing:
  default: per-channel
outbound:
  - thread_pattern: "threads/peers/*"
    via: xgw
retry:
  max_attempts: 5
deliver:
  max_attempts: 7
`.trim()
    );

    const config = await loadConfig(tmpDir);

    expect(config.agent_id).toBe('test-agent');
    expect(config.kind).toBe('user');
    expect(config.pai.provider).toBe('openai');
    expect(config.pai.model).toBe('gpt-4o');
    expect(config.routing.default).toBe('per-channel');
    expect(config.retry?.max_attempts).toBe(5);
    expect(config.deliver?.max_attempts).toBe(7);
  });

  it('fills default routing.default = per-peer when missing', async () => {
    await writeFile(
      join(tmpDir, 'config.yaml'),
      `
agent_id: test-agent
kind: user
pai:
  provider: openai
  model: gpt-4o
inbox:
  path: /inbox
outbound: []
`.trim()
    );

    const config = await loadConfig(tmpDir);
    expect(config.routing.default).toBe('per-peer');
  });

  it('fills default retry.max_attempts = 3 when missing', async () => {
    await writeFile(
      join(tmpDir, 'config.yaml'),
      `
agent_id: test-agent
kind: user
pai:
  provider: openai
  model: gpt-4o
inbox:
  path: /inbox
outbound: []
`.trim()
    );

    const config = await loadConfig(tmpDir);
    expect(config.retry?.max_attempts).toBe(3);
  });

  it('fills default deliver.max_attempts = 3 when missing', async () => {
    await writeFile(
      join(tmpDir, 'config.yaml'),
      `
agent_id: test-agent
kind: user
pai:
  provider: openai
  model: gpt-4o
inbox:
  path: /inbox
outbound: []
`.trim()
    );

    const config = await loadConfig(tmpDir);
    expect(config.deliver?.max_attempts).toBe(3);
  });

  it('preserves explicit retry.max_attempts when provided', async () => {
    await writeFile(
      join(tmpDir, 'config.yaml'),
      `
agent_id: test-agent
kind: user
pai:
  provider: openai
  model: gpt-4o
inbox:
  path: /inbox
outbound: []
retry:
  max_attempts: 10
`.trim()
    );

    const config = await loadConfig(tmpDir);
    expect(config.retry?.max_attempts).toBe(10);
  });

  it('throws descriptive error when config.yaml does not exist', async () => {
    await expect(loadConfig(tmpDir)).rejects.toThrow(/Config file not found/);
    await expect(loadConfig(tmpDir)).rejects.toThrow(/config\.yaml/);
  });

  it('throws descriptive error with fix hint when file is missing', async () => {
    await expect(loadConfig(tmpDir)).rejects.toThrow(/create a config\.yaml/);
  });

  it('throws descriptive error for invalid YAML', async () => {
    await writeFile(
      join(tmpDir, 'config.yaml'),
      `
agent_id: test
invalid: yaml: content: [unclosed
`.trim()
    );

    await expect(loadConfig(tmpDir)).rejects.toThrow(/Invalid YAML/);
  });

  it('throws descriptive error when YAML is not an object', async () => {
    await writeFile(join(tmpDir, 'config.yaml'), '- just\n- a\n- list\n');

    await expect(loadConfig(tmpDir)).rejects.toThrow(/Invalid config format/);
  });
});

// Feature: agent-runtime, Property 7: 配置默认值填充, Property 8: 配置解析 Round-Trip

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fc from 'fast-check';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stringify } from 'yaml';
import { loadConfig } from '../../src/config.js';
import type { AgentConfig, RoutingMode } from '../../src/types.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'agent-pbt-config-'));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Arbitraries ──────────────────────────────────────────────────────────────

const safeString = fc.stringMatching(/^[a-zA-Z0-9_-]{1,32}$/);

const routingModeArb: fc.Arbitrary<RoutingMode> = fc.constantFrom(
  'per-peer',
  'per-channel',
  'per-agent'
);

const outboundEntryArb = fc.record({
  thread_pattern: safeString,
  via: safeString,
});

/** Full valid AgentConfig arbitrary */
const agentConfigArb: fc.Arbitrary<AgentConfig> = fc.record({
  agent_id: safeString,
  kind: fc.constantFrom('system', 'user') as fc.Arbitrary<'system' | 'user'>,
  pai: fc.record({
    provider: safeString,
    model: safeString,
  }),
  inbox: fc.record({
    path: fc.stringMatching(/^\/[a-zA-Z0-9/_-]{1,64}$/),
  }),
  routing: fc.record({
    default: routingModeArb,
  }),
  outbound: fc.array(outboundEntryArb, { minLength: 0, maxLength: 3 }),
  retry: fc.record({ max_attempts: fc.integer({ min: 1, max: 10 }) }),
  deliver: fc.record({ max_attempts: fc.integer({ min: 1, max: 10 }) }),
});

/** Minimal config YAML missing all optional fields */
const minimalYamlArb = fc.record({
  agent_id: safeString,
  kind: fc.constantFrom('system', 'user'),
  pai: fc.record({ provider: safeString, model: safeString }),
  inbox: fc.record({ path: fc.stringMatching(/^\/[a-zA-Z0-9/_-]{1,64}$/) }),
  outbound: fc.constant([]),
});

// ── Property 7: 配置默认值填充 ────────────────────────────────────────────────
// Validates: Requirements 9.2

describe('Property 7: 配置默认值填充', () => {
  it('missing routing.default → filled with per-peer', async () => {
    await fc.assert(
      fc.asyncProperty(minimalYamlArb, async (minimal) => {
        const dir = await mkdtemp(join(tmpdir(), 'p7a-'));
        try {
          await writeFile(join(dir, 'config.yaml'), stringify(minimal));
          const config = await loadConfig(dir);
          expect(config.routing.default).toBe('per-peer');
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 }
    );
  });

  it('missing retry.max_attempts → filled with 3', async () => {
    await fc.assert(
      fc.asyncProperty(minimalYamlArb, async (minimal) => {
        const dir = await mkdtemp(join(tmpdir(), 'p7b-'));
        try {
          await writeFile(join(dir, 'config.yaml'), stringify(minimal));
          const config = await loadConfig(dir);
          expect(config.retry?.max_attempts).toBe(3);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 }
    );
  });

  it('missing deliver.max_attempts → filled with 3', async () => {
    await fc.assert(
      fc.asyncProperty(minimalYamlArb, async (minimal) => {
        const dir = await mkdtemp(join(tmpdir(), 'p7c-'));
        try {
          await writeFile(join(dir, 'config.yaml'), stringify(minimal));
          const config = await loadConfig(dir);
          expect(config.deliver?.max_attempts).toBe(3);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 }
    );
  });
});

// ── Property 8: 配置解析 Round-Trip ──────────────────────────────────────────
// Validates: Requirements 9.1

describe('Property 8: 配置解析 Round-Trip', () => {
  it('serialize AgentConfig to YAML and parse back produces equivalent config', async () => {
    await fc.assert(
      fc.asyncProperty(agentConfigArb, async (original) => {
        const dir = await mkdtemp(join(tmpdir(), 'p8-'));
        try {
          await writeFile(join(dir, 'config.yaml'), stringify(original));
          const parsed = await loadConfig(dir);

          expect(parsed.agent_id).toBe(original.agent_id);
          expect(parsed.kind).toBe(original.kind);
          expect(parsed.pai.provider).toBe(original.pai.provider);
          expect(parsed.pai.model).toBe(original.pai.model);
          expect(parsed.inbox.path).toBe(original.inbox.path);
          expect(parsed.routing.default).toBe(original.routing.default);
          expect(parsed.retry?.max_attempts).toBe(original.retry?.max_attempts);
          expect(parsed.deliver?.max_attempts).toBe(original.deliver?.max_attempts);
          expect(parsed.outbound).toEqual(original.outbound);
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 }
    );
  });
});

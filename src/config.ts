import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { AgentConfig, RoutingMode } from './types.js';

/**
 * Load and parse agent configuration from <agentDir>/config.yaml.
 * Fills in default values for optional fields:
 *   - routing.default = 'per-peer'
 *   - retry.max_attempts = 3
 *   - deliver.max_attempts = 3
 *
 * Throws a descriptive error if the file is missing or malformed.
 */
export async function loadConfig(agentDir: string): Promise<AgentConfig> {
  const configPath = join(agentDir, 'config.yaml');

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new Error(
        `Config file not found: ${configPath} - create a config.yaml in the agent directory`
      );
    }
    throw new Error(
      `Failed to read config file ${configPath}: ${(err as Error).message} - check file permissions`
    );
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    throw new Error(
      `Invalid YAML in ${configPath}: ${(err as Error).message} - fix the YAML syntax and retry`
    );
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `Invalid config format in ${configPath}: expected a YAML object - ensure the file contains valid key-value pairs`
    );
  }

  const cfg = parsed as Record<string, unknown>;

  // Apply defaults for optional fields
  const routing = (cfg.routing ?? {}) as Record<string, unknown>;
  if (!routing.default) {
    routing.default = 'per-peer' satisfies RoutingMode;
  }
  cfg.routing = routing;

  const retry = (cfg.retry ?? {}) as Record<string, unknown>;
  if (retry.max_attempts === undefined || retry.max_attempts === null) {
    retry.max_attempts = 3;
  }
  cfg.retry = retry;

  const deliver = (cfg.deliver ?? {}) as Record<string, unknown>;
  if (deliver.max_attempts === undefined || deliver.max_attempts === null) {
    deliver.max_attempts = 3;
  }
  cfg.deliver = deliver;

  return cfg as unknown as AgentConfig;
}

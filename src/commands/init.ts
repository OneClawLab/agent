import { existsSync } from '../repo-utils/fs.js';
import { mkdir, writeFile } from '../repo-utils/fs.js';
import { homedir } from 'node:os';
import { path } from '../repo-utils/path.js';
import { execCommand } from '../repo-utils/os.js';

function agentDir(id: string): string {
  return path.join(path.toPosixPath(homedir()), '.theclaw', 'agents', id);
}

interface PaiResolveResult {
  provider: string;
  model: string;
  contextWindow: number | null;
  maxTokens: number | null;
}

/**
 * Call `pai model resolve --json` to get the effective provider/model/contextWindow.
 * Returns null if pai is not available or resolution fails.
 */
async function resolvePaiModel(provider?: string): Promise<PaiResolveResult | null> {
  try {
    const args = ['model', 'resolve'];
    if (provider) args.push('--provider', provider);
    const { stdout } = await execCommand('pai', args, 10000);
    const result = JSON.parse(stdout) as PaiResolveResult;
    return result;
  } catch {
    return null;
  }
}

function defaultConfig(
  id: string,
  kind: string,
  provider: string,
  model: string,
  contextWindow: number | null,
  maxTokens: number | null,
): string {
  const inboxPath = path.join(path.toPosixPath(homedir()), '.theclaw', 'agents', id, 'inbox');
  const contextWindowLine = contextWindow != null ? `context_window: ${contextWindow}\n` : '';
  const maxOutputTokensLine = maxTokens != null ? `max_output_tokens: ${maxTokens}\n` : '';
  return `agent_id: ${id}
kind: ${kind}
pai:
  provider: ${provider}
  model: ${model}
inbox:
  path: ${inboxPath}
routing:
  default: per-peer
outbound: []
retry:
  max_attempts: 3
deliver:
  max_attempts: 3
${contextWindowLine}${maxOutputTokensLine}`;
}

export async function initCmd(id: string, opts: { kind: string; provider?: string }): Promise<void> {
  const kind = opts.kind ?? 'user';
  const dir = agentDir(id);

  if (existsSync(dir)) {
    process.stderr.write(`Error: Agent '${id}' already exists at ${dir} - remove the directory first or choose a different id\n`);
    process.exit(1);
  }

  // Resolve provider/model/contextWindow from pai
  const resolved = await resolvePaiModel(opts.provider);
  const provider = resolved?.provider ?? opts.provider ?? 'openai';
  const model = resolved?.model ?? 'gpt-4o';
  const contextWindow = resolved?.contextWindow ?? null;
  const maxTokens = resolved?.maxTokens ?? null;

  if (resolved) {
    process.stdout.write(`Resolved pai config: ${provider}/${model}${contextWindow ? ` (context: ${contextWindow})` : ''}\n`);
  } else {
    process.stdout.write(`Warning: could not resolve pai model config — using defaults (openai/gpt-4o)\n`);
  }

  const subdirs = [
    'inbox',
    'sessions',
    'memory',
    path.join('threads', 'peers'),
    path.join('threads', 'channels'),
    path.join('threads', 'main'),
    'workdir',
    'logs',
  ];

  for (const sub of subdirs) {
    await mkdir(path.join(dir, sub), { recursive: true });
  }

  await writeFile(path.join(dir, 'IDENTITY.md'), `# ${id}\n\nYou are ${id}, an AI agent.\n`);
  await writeFile(path.join(dir, 'USAGE.md'), `# Usage\n\nThis agent responds to messages in its inbox.\n`);
  await writeFile(path.join(dir, 'config.yaml'), defaultConfig(id, kind, provider, model, contextWindow, maxTokens));

  await execCommand('thread', ['init', path.join(dir, 'inbox')]);

  process.stdout.write(`Agent '${id}' initialized at ${dir}\n`);
}

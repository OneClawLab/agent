# agent ↔ pai chat session compaction strategy — investigation & TODO

This note documents how `agent` uses `pai chat` sessions today, whether there is any automatic context-window detection/compaction, and a concrete plan to implement robust session compaction.

> Scope: agent repo runtime behavior (`agent run`, `agent chat`) + pai repo `pai chat` implementation.

---

## 1) Current session strategy (what happens today)

### 1.1 Per-thread session files (persistent)

In `agent/src/runner/llm.ts`:

- Session file path is deterministic:

```ts
buildSessionFilePath(agentDir, threadId) => `${agentDir}/sessions/${threadId}.jsonl`
```

- LLM invocation is:

```bash
pai chat \
  --session <agentDir>/sessions/<threadId>.jsonl \
  --system-file <agentDir>/sessions/system-prompt-<threadId>.md \
  --provider <provider> --model <model> \
  <userMessage>
```

So: **conversation history is whatever `pai` loads from the JSONL session file**.

### 1.2 System prompt handling: rewritten each run, replaces existing system message

`pai chat` loads session messages, then if `--system/--system-file` is provided:

- if first loaded message is `role=system`: it replaces it in memory
- otherwise it prepends a system message and appends it to session file

So agent can change system prompt per turn without rewriting the whole session file.

### 1.3 Session JSONL schema (confirmed)

Each line is a JSON object with required fields `role` and `content`, optional `timestamp`:

```jsonl
{"role":"system","content":"...","timestamp":"..."}
{"role":"user","content":"...","timestamp":"..."}
{"role":"assistant","content":"...","timestamp":"..."}
{"role":"tool","name":"bash_exec","tool_call_id":"...","content":"...","timestamp":"..."}
```

Assistant messages may also carry a `tool_calls` array. Agent can read this file directly with line-by-line `JSON.parse`.

### 1.4 Separate compression session file (currently broken)

`agent/src/commands/run.ts` defines `compressThreadMemory()`:

- Uses a separate session: `sessions/compress-<threadId>.jsonl`
- Uses `system-compress.md`
- Writes summary to: `memory/thread-<threadId>.md`

**Bug:** the compression call does not pass conversation history to the model.
It sends only: "Please summarise the conversation history above into a concise memory summary."
Since `compress-<threadId>.jsonl` is always empty, this produces a useless summary.

### 1.5 "Context too large" detection is wrong

`agent/src/commands/run.ts`:

- Estimates tokens as `ceil(chars/4)`.
- Only checks the **system prompt string** size.
- Uses a fixed `TOKEN_THRESHOLD = 6000`.

Problems:
- Does not measure session history (the actual source of context growth).
- 6000 tokens is far too low for modern models (128k context).
- Not tied to actual model context window.

---

## 2) Does `pai chat` auto-detect context window and auto-compact?

### 2.1 pai is context-window aware in config, but does not enforce/compact

In `pai/src/commands/chat.ts`:

- `provider.contextWindow` is passed into `LLMClient`.

In `pai/src/llm-client.ts`:

- `contextWindow` is used only to construct a `Model` object (for pi-ai).
- `buildContext()` does not count tokens.
- No truncation/compaction logic exists.

**Conclusion:** Today there is no automatic session compaction in `pai chat`.
If the session grows beyond the model context, the upstream provider will error.

---

## 3) What's missing / risks

1. **Over-context failures** — Session JSONL grows unbounded; providers return context-length errors.
2. **Current compression hook doesn't work** — compress step doesn't feed any history.
3. **Threshold is wrong target** — only system prompt is checked; real context includes session messages.
4. **No deterministic strategy for "what to drop"** — no rolling window policy.

---

## 4) Chosen strategy: compaction in `agent` (caller-owned)

Option A from the original analysis. Agent owns identity/memory layering; compaction semantics are agent-specific. No changes needed in `pai`.

---

## 5) Confirmed design decisions

### 5.1 Context window source

- Add optional `context_window?: number` to `AgentConfig`.
- Fallback: **128,000 tokens** (conservative minimum for mainstream models).
- `pai model info` integration deferred to a future iteration.

### 5.2 Token budget

```
inputBudget = contextWindow - maxOutputTokens - safetyMargin
```

- `maxOutputTokens`: default 4096 (configurable via `AgentConfig`)
- `safetyMargin`: 512 tokens
- Token estimation: language-aware heuristic (see below)

#### Token estimation heuristic

Rather than a flat `chars/4`, use a per-character weight that accounts for script density:

```ts
function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp > 0x2E7F) {
      // CJK, fullwidth, emoji, etc. — typically 1–2 tokens per character
      tokens += 1.5;
    } else if (cp > 0x007F) {
      // Latin extended, accented chars, punctuation blocks — ~1.5 chars/token
      tokens += 0.7;
    } else {
      // ASCII — ~4 chars/token
      tokens += 0.25;
    }
  }
  return Math.ceil(tokens);
}
```

This gives reasonable estimates for mixed Chinese/English/code content without a tokenizer dependency.

### 5.3 Compaction trigger (OR of two conditions)

Compaction fires before calling `pai chat` if **either**:

1. **Context size > 80% of `inputBudget`** — measured over: system prompt + all session messages + current user message
2. **Turn count ≥ 10** since last compaction — tracked in a lightweight sidecar file `sessions/compact-state-<threadId>.json`

```ts
interface CompactState {
  lastCompactedAt: number; // turn index
  turnCount: number;       // total turns processed
}
```

### 5.4 What to compact

- **Preserve raw**: the most recent messages whose cumulative estimated token count ≤ **4,096 tokens** are kept verbatim. Token count is computed with the language-aware heuristic above (not a flat chars/4).
- **Summarize**: all older messages are fed to the summarizer.
- **Dynamic keepTurns**: after generating the summary, fill remaining `inputBudget - summaryTokens` from newest turns backwards. This avoids wasting context space.

### 5.5 Compaction flow

```
1. Load session JSONL → messages[]
2. Estimate total tokens (system + messages + userMsg)
3. If trigger condition met:
   a. Split messages: recentRaw (last 4K tokens equivalence) + toSummarize (the rest)
   b. Build summarizer prompt from toSummarize transcript
   c. Call pai chat (separate session file) → summary text
   d. Write summary to memory/thread-<threadId>.md
   e. Rewrite session JSONL:
      - synthetic assistant message: {"role":"assistant","content":"[Memory Summary]\n<summary>"}
      - recentRaw messages (verbatim)
   f. Update compact-state-<threadId>.json
4. Proceed with pai chat as normal
```

### 5.6 Failure-mode behavior

- If summarization call fails → fall back to **truncation only**: keep only `recentRaw` messages, log a warning to stderr and agent log.
- If truncated context is still too large → reduce `recentRaw` threshold by half and retry once.

---

## 6) File-level TODO list

- [ ] `src/types.ts`: add `context_window?: number` and `max_output_tokens?: number` to `AgentConfig`.
- [ ] `src/runner/session.ts` *(new)*: utilities for reading/writing session JSONL, estimating tokens, splitting messages into recentRaw + toSummarize.
- [ ] `src/runner/compactor.ts` *(new)*: `compactSession()` — implements the full compaction flow (steps 3a–3f above). Reads/writes `compact-state-<threadId>.json`.
- [ ] `src/commands/run.ts`:
  - Replace `estimateTokens(systemPrompt) > TOKEN_THRESHOLD` with full context estimation.
  - Replace `compressThreadMemory()` call with `compactSession()`.
  - Pass `contextWindow` and `maxOutputTokens` from config (with fallbacks).
- [ ] `vitest/unit/session.test.ts` *(new)*: unit tests for session read/write, token estimation, message splitting.
- [ ] `vitest/unit/compactor.test.ts` *(new)*: unit tests for compaction trigger logic, rewrite correctness, fallback behavior.

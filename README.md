# agent

A CLI tool for managing autonomous AI agents in TheClaw — each agent has an inbox thread, an LLM identity, and a routing table that maps incoming messages to conversation threads.

## How it works

- Initialize an agent with `agent init <id>` — creates the directory structure, config, and inbox thread.
- Start the agent with `agent start <id>` — registers an inbox subscription so `notifier` can trigger `agent run` on new messages.
- When a message arrives in the inbox, `notifier` dispatches `agent run <id>` — which routes the message to the right thread, calls the LLM via `pai chat`, and writes the reply back.
- Outbound replies are delivered by `agent deliver` — which reads from the thread and calls `xgw send` (external) or `thread push` (internal).

## Install

### From npm

```bash
npm install -g @theclawlab/agent
```

### From source

```bash
npm run build && npm link
```

## Quick start

```bash
# Initialize a new agent
agent init my-agent --kind user

# Start the agent (registers inbox subscription)
agent start my-agent

# Check status
agent status my-agent

# Simulate an incoming message (for testing)
agent send my-agent \
  --source xgw:telegram:user42 \
  --type message \
  --content '{"text":"hello","reply_context":{"channel_type":"external","channel_id":"telegram","peer_id":"user42"}}'

# Interactive debug chat (bypasses inbox/notifier, calls LLM directly)
agent chat my-agent

# Stop the agent
agent stop my-agent
```

## Commands

| Command | Description |
|---------|-------------|
| `agent init <id>` | Initialize a new agent directory |
| `agent start <id>` | Register inbox subscription (enable dispatch) |
| `agent stop <id>` | Unregister inbox subscription (pause, keep state) |
| `agent status [<id>]` | Show agent status (or list all agents) |
| `agent list` | List all initialized agents |
| `agent send <id>` | Push a message into the agent's inbox (debug) |
| `agent chat <id>` | Interactive LLM chat, bypasses full pipeline (debug) |
| `agent run <id>` | Process inbox messages — called by notifier, not manually |
| `agent deliver` | Deliver outbound replies — called by thread dispatch, not manually |

## Data directory

Default: `~/.theclaw/agents/<id>/` — override root with `THECLAW_HOME`.

```
~/.theclaw/agents/<id>/
├── IDENTITY.md       # agent system prompt
├── USAGE.md          # usage notes for the agent itself
├── config.yaml       # LLM provider, routing, outbound config
├── inbox/            # inbox thread (SQLite-backed)
├── sessions/         # pai chat session files (per thread)
├── memory/           # persistent memory files
├── threads/          # per-peer/channel/agent conversation threads
├── workdir/          # scratch space
└── logs/             # agent run logs
```

## Dependencies

Requires the following tools to be installed and on `PATH`:

- [`pai`](../pai) — LLM CLI (`pai chat`)
- [`thread`](../thread) — event queue CLI
- [`notifier`](../notifier) — task scheduler daemon
- [`xgw`](../xgw) — communication gateway (for external channel delivery)

## Documentation

- [USAGE.md](./USAGE.md) — full CLI reference, config format, and data directory details

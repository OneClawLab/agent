# agent - agent runtime and lifecycle management CLI command

Manages the full lifecycle of TheClaw agents: create, start, stop, and drive the core run-loop — consuming messages from inbox, routing to threads, invoking LLM (via `pai`), recording events, and delivering replies to external peers (via `xgw`).

## 决策记录

1. **Agent 即目录**：每个 agent 的全部数据存放在一个目录下（`~/.theclaw/agents/<agent_id>/`），通过 `agent init <id>` 初始化。agent_id 即目录名，天然唯一。
2. **Inbox 是特殊 thread**：agent 的 inbox 是一个普通 thread 目录（由 `thread` 工具管理），xgw 通过 `thread push` 写入，agent 通过 `thread pop` 消费。inbox 不做语义路由，只是入站队列。
3. **Agent 运行循环由 notifier 驱动**：agent 不是常驻进程，而是由 `notifier` 在有新消息时调度启动（通过 thread 的 dispatch 机制）。每次调度运行一个处理批次后退出，文件锁保证同一 agent 不并发运行。
4. **LLM 调用通过 `pai`**：agent 不直接调用 LLM API，而是通过 `pai chat` 命令，保持工具链一致性。session 文件存储在 agent 目录下，实现多轮对话持久化。
5. **出站回复通过 `xgw send`**：agent 将回复写入 thread 后，由注册在该 thread 上的 outbound consumer 触发投递。outbound consumer 是通过 `thread subscribe` 注册的普通 consumer，handler 命令即为 `xgw send --channel <id> --peer <id> ...`，由 thread dispatch 机制自动触发，无独立进程。
6. **System prompt 与 identity 分离**：agent 的 identity（IDENTITY.md）描述 agent 的角色和能力，system prompt 由 agent 运行时动态组装（identity + 当前 thread 上下文 + 工具提示）。
7. **IDENTITY.md 与 USAGE.md 分工**：IDENTITY.md 对内，是 agent 自己的 system prompt（"你是谁，你该怎么做"）；USAGE.md 对外，给调用者（人类或其他 agent）的使用说明（"这个 agent 能做什么，怎么交互"）。其他 agent（如 admin）可将目标 agent 的 USAGE.md 作为 context 辅助路由决策。
7. **工具发现通过 `cmds`**：agent 配备的唯一 LLM tool 是 `bash_exec`，通过内置的 `cmds` 命令渐进发现系统能力（遵循 TheClaw 整体设计原则）。
8. **多 agent 支持**：系统预置 system agents（admin、warden 等），用户可通过 admin 创建 user agents。所有 agent 共享同一套运行机制。

## 1. Role

```
xgw → agent.inbox (thread) → agent run-loop
                                ├── pai chat (LLM)
                                ├── bash_exec (tools)
                                └── thread push (outbound events)
                                        ↓
                              outbound consumer → agent deliver → xgw send → channel → peer
```

- **Inbox Consumption**: Consume inbound messages from inbox thread (`thread pop`).
- **Thread Routing**: Route messages to the appropriate thread (create new or continue existing).
- **LLM Driving**: Invoke `pai chat` to process messages, produce replies and tool calls.
- **Event Recording**: Write toolcall, decision, message events to thread (`thread push`).
- **Outbound Delivery**: Register outbound consumers on threads; thread dispatch triggers `xgw send`.
- **Lifecycle Management**: Create, configure, start/stop agents via CLI.

## 2. Tech Stack & Project Structure

遵循 TheClaw 其他 repo 约定：

- **TypeScript + ESM** (Node 22+)
- **构建**: tsup (ESM, shebang banner)
- **测试**: vitest
- **CLI 解析**: commander

```
agent/
├── src/
│   ├── index.ts              # Entry point, CLI parsing & dispatch
│   ├── commands/
│   │   ├── init.ts           # agent init <id>
│   │   ├── start.ts          # agent start <id>
│   │   ├── stop.ts           # agent stop <id>
│   │   ├── status.ts         # agent status [<id>] [--json]
│   │   ├── list.ts           # agent list [--json]
│   │   ├── run.ts            # agent run <id> (internal, scheduled by notifier)
│   │   └── deliver.ts        # agent deliver (internal, triggered by outbound consumer)
│   ├── runner/
│   │   ├── inbox.ts          # Inbox consumption logic
│   │   ├── router.ts         # Message → thread routing
│   │   ├── llm.ts            # Invoke pai chat
│   │   ├── recorder.ts       # Write events to thread
│   │   └── deliver.ts        # Outbound delivery logic
│   ├── config.ts             # Agent config loading
│   ├── identity.ts           # IDENTITY.md loading & system prompt assembly
│   ├── logger.ts             # Runtime logging
│   └── types.ts              # Shared type definitions
├── vitest/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── SPEC.md
└── USAGE.md
```

## 3. Data Directory Layout

```
~/.theclaw/agents/<agent_id>/
├── IDENTITY.md               # 对内：agent 的 system prompt（角色、能力、行为准则）
├── USAGE.md                  # 对外：给调用者（人类或其他 agent）的使用说明
├── config.yaml               # Agent config (inbox path, pai provider, routing rules, etc.)
├── inbox/                    # Inbox thread directory (initialized by thread init)
│   ├── events.db
│   ├── events.jsonl
│   └── ...
├── sessions/                 # pai chat session files (JSONL, per-thread working area)
│   └── <thread_id>.jsonl
├── memory/                   # Agent memory files (Markdown, LLM-friendly)
│   ├── agent.md              # 跨所有 peer/thread 的记忆（agent 自我改进、通用知识）
│   ├── user-<peer_id>.md     # per peer 跨 thread 的记忆（用户偏好、历史摘要）
│   └── thread-<thread_id>.md # per thread 的记忆（当前对话的压缩摘要）
├── threads/                  # Agent-private thread directories (per routing rules)
│   ├── peers/                # per-peer threads (e.g. peers/<channel_id>-<peer_id>/)
│   ├── sessions/             # per-session threads (e.g. sessions/<channel_id>-<session_id>/)
│   └── main/                 # per-agent mode: single shared thread
├── workdir/                  # Temporary workspace (plans, drafts, etc.)
└── logs/
    ├── agent.log
    └── agent-<YYYYMMDD-HHmmss>.log
```

所有 thread 均为 agent 私有，不存在全局共享 thread。agent 间通信统一通过向目标 agent 的 inbox `thread push`（source 使用 `internal:...` 地址格式）。

## 4. Agent Configuration

`~/.theclaw/agents/<agent_id>/config.yaml`:

```yaml
agent_id: admin
kind: system          # system | user

pai:
  provider: openai
  model: gpt-4o

inbox:
  path: ~/.theclaw/agents/admin/inbox   # thread directory path

# 消息路由规则：将 inbox 消息路由到哪个 thread
routing:
  # per-peer: 每个 (channel, peer) 独立 thread（默认）
  # per-channel: 同一渠道共享一个 thread
  # per-agent: 所有消息共享同一个 thread
  default: per-peer

# 出站配置：哪些 thread 的消息需要通过 xgw 回复
outbound:
  - thread_pattern: "**"     # 匹配所有 thread
    via: xgw                 # 通过 xgw send 投递
```

## 5. CLI Commands

### 5.1 `agent init <id>`

Initialize a new agent.

```bash
agent init admin [--kind system|user]
```

**Behavior**:
1. 创建 `~/.theclaw/agents/<id>/` 目录结构。
2. 生成默认 `IDENTITY.md`、`USAGE.md` 和 `config.yaml`。
3. 通过 `thread init` 初始化 inbox thread。
4. 若 agent 已存在，报错退出（退出码 1）。

### 5.2 `agent start <id>`

Start (resume) an agent — register inbox subscription so it responds to messages.

```bash
agent start <id>
```

**Behavior**:
1. 加载 agent 配置。
2. 通过 `thread subscribe` 在 inbox thread 注册订阅，handler 为 `agent run <id>`。
3. 记录启动日志。

agent 本身不是常驻进程——`start` 只是注册订阅，实际运行由 `notifier` 在有新消息时触发 `agent run`。

`start` 是 `stop` 的逆操作（恢复）。stop 期间积累在 inbox 中的消息不会丢失，start 后从上次消费进度继续处理。

### 5.3 `agent stop <id>`

Stop (pause) an agent — unregister inbox subscription, but preserve all state.

```bash
agent stop <id>
```

**Behavior**: 通过 `thread unsubscribe` 注销 inbox 订阅。已在运行的 `agent run` 实例会自然完成当前批次后退出。

**关键语义**：stop 是暂停而非销毁。`consumer_progress` 不清除，inbox 中的消息继续积累，下次 `start` 后从暂停点继续消费。

**删除 agent**：没有专用的 delete 命令。删除 agent 的方式是直接删除其整个目录（`rm -rf ~/.theclaw/agents/<id>/`）。目录删除后，inbox thread、所有私有 thread、session 文件、日志等一并清除。

### 5.4 `agent run <id>` (Internal)

由 `notifier` 通过 thread dispatch 机制自动调用，不建议手动执行。

```bash
agent run <id>
```

**Behavior** (single run batch):
1. 从 inbox thread 消费消息（`thread pop --consumer <id> --last-event-id <last>`）。
2. 若无新消息，直接退出（退出码 0）。
3. 对每条入站消息：
   a. 路由到目标 thread（根据 routing 规则，新建或复用）。
   b. 将消息写入目标 thread（`thread push --type message --source <original_source>`，保留入站消息的完整 source 地址）。
   c. 组装 system prompt（IDENTITY.md + thread 上下文）。
   d. 调用 `pai chat`（携带 session 文件，实现多轮对话）。
   e. 将 LLM 回复写入 thread（`thread push --type message --source self`）。
   f. 将 toolcall 记录写入 thread（`thread push --type record --subtype toolcall --source self`）。
4. 若该 thread 是首次创建（新 peer 对话），注册 outbound consumer（见 6.4）。
5. 更新 inbox 消费进度（下次 `thread pop` 传入已处理的最大 event id）。

文件锁（`~/.theclaw/agents/<id>/run.lock`）保证同一 agent 不并发运行。

**错误处理与自动重试**：
- 可恢复错误（网络超时、LLM API 临时错误、rate limit 等）：agent run 自动重试，最多 3 次，指数退避。重试次数可通过 config.yaml 的 `retry.max_attempts` 配置。
- 不可恢复错误（配置错误、认证失败、LLM 策略违反等）：不重试，写一条 `type=record, subtype=error` 事件到当前 thread，记录错误信息，然后继续处理下一条消息（不中断整个批次）。
- 批次级别的致命错误（inbox 不可访问、文件锁获取失败等）：直接退出（退出码 1）。

### 5.5 `agent status [<id>]`

Show agent runtime status.

```bash
agent status [<id>] [--json]
```

Output: agent 列表或单个 agent 的状态（是否已启动、inbox 消费进度、最近活动时间）。

### 5.6 `agent list`

List all agents.

```bash
agent list [--json]
```

## 6. Run-Loop Details

### 6.1 Inbox Consumption

inbox 是一个普通 thread，agent 作为 consumer 订阅它。`thread dispatch` 在有新消息时触发 `agent run`，`agent run` 通过 `thread pop` 批量取出消息处理。

消费进度持久化在 inbox thread 的 `consumer_progress` 表中（at-least-once 语义）。

### 6.2 Thread Routing

路由规则（`config.yaml` 中的 `routing.default`）决定入站消息进入哪个 thread：

| Mode | Description | Thread Path |
|------|-------------|-------------|
| `per-peer` (default) | One thread per `(channel_id, peer_id)` pair | `threads/peers/<channel_id>-<peer_id>/` |
| `per-channel` | All peers in a channel share one thread | `threads/channels/<channel_id>/` |
| `per-agent` | All channels and peers share one thread | `threads/main/` |

- `per-peer`：适合大多数场景，每个用户有独立的对话上下文。
- `per-channel`：适合群聊类场景，或希望同一渠道的消息汇聚在一起。
- `per-agent`：适合单用户/单渠道的简单场景，或需要跨渠道统一上下文的场景。

Thread 不存在时自动通过 `thread init` 创建。

**Outbound consumer 注册**：只有从 inbox 路由过来的 peer 对话 thread 才注册 outbound consumer（见 6.4）。agent 写入 thread 的回复 event 的 content 中携带 `reply_context`（从入站消息透传），outbound consumer 从中提取出站路由信息。

### 6.3 LLM Invocation

agent 调用 LLM 前需要先构建 context（见 6.5），然后通过 `pai chat` 发起调用：

```bash
pai chat \
  --session ~/.theclaw/agents/<id>/sessions/<thread_id>.jsonl \
  --system-file <dynamically-assembled-system-prompt> \
  --provider <provider> \
  --model <model> \
  "<user_message>"
```

`pai chat` 的 stdout 即为 LLM 回复文本。`--json` 模式下可获取结构化输出（tool calls 等）。

session-file 的定位是"LLM 调用的工作区"，而非完整事件流的副本。每次调用前由 agent 框架动态组装（system prompt + memory 摘要 + 最近消息），调用期间 `pai chat` 会 append 新的 assistant/tool messages。

### 6.4 Outbound Consumer (Delivery)

outbound consumer 没有独立进程，物理上就是注册在目标 thread 上的一个普通 consumer，由 thread dispatch 机制触发 `agent deliver`。

**注册时机**：`agent run` 路由消息到某个 thread 时，若该 thread 尚未注册 outbound consumer，则调用：

```bash
thread subscribe \
  --thread <thread_path> \
  --consumer outbound \
  --filter "type = 'message' AND source = 'self'" \
  --handler "agent deliver --thread <thread_path> --consumer outbound"
```

- `--filter` 精确匹配：只有 agent 自己产生的 `type=message` 事件（`source=self`）才触发出站，外部来源的消息和内部 `record` 事件不触发。
- `--handler` 不再需要硬编码 `channel_id`、`peer_id`、`session_id`——`agent deliver` 从每条待投递 event 的 content 中的 `reply_context` 提取出站路由信息。
- `thread dispatch` 只负责"有新事件时触发 handler"，不传递数据。handler（`agent deliver`）自己通过 `thread pop` 取数据，与 `agent run` 的模式完全一致。

**`agent deliver`** (Internal): 由 outbound consumer handler 触发，执行出站投递批次：
1. `thread pop --consumer outbound --last-event-id <last>` 取出待投递 events。
2. 对每条 event，从 content 中的 `reply_context` 提取出站路由信息（channel_type、channel_id、session_id、peer_id、visibility 等）。
3. 根据 `reply_context` 中的信息判断投递方式：
   - 若 `reply_context` 中包含 external 渠道信息：调用 `xgw send`，从 `reply_context` 提取所有出站参数。
   - 若 `reply_context` 中标识为 internal 来源：通过 `thread push` 写入发送方 agent 的 inbox。
4. 消费进度由 `thread` 的 `consumer_progress` 持久化，at-least-once 语义，文件锁保证不并发。

**At-least-once 投递语义**：`agent deliver` 投递失败时（`xgw send` 返回非零退出码），不更新该 event 的消费进度（不 ACK），下次 dispatch 时会重试。对于持续失败的 event（连续 N 次失败，N 由 config.yaml 的 `deliver.max_attempts` 配置，默认 3），deliver 写一条 `type=record, subtype=error` 事件到 thread 记录失败信息（供 maintainer agent 感知），然后跳过该 event 继续处理后续 events。

**哪些 thread 需要出站**：只有从 inbox 路由过来的 peer 对话 thread 需要注册 outbound consumer。agent 内部的 memory/tasks thread 不注册，因此不会触发出站。这个区分由路由层（6.2）在创建 thread 时决定，而非在 event 层判断。

**出站路由信息的携带**：agent 写回复到 thread 时（`source=self`），必须在 content 中携带入站消息的 `reply_context`（由 agent 运行时框架自动透传）。`agent deliver` 从 `reply_context` 中提取出站路由信息，根据来源类型（external/internal）选择投递方式。对于 external 来源调用 `xgw send`，对于 internal 来源直接 `thread push` 到发送方 agent 的 inbox。

### 6.5 Context Building & Memory Management

agent 在每次 LLM 调用前需要组装 context。context 由三层 memory + 最近原始消息构成。

#### Memory 三层结构

```
~/.theclaw/agents/<id>/memory/
├── agent.md                    # Layer 1: 跨所有 peer/thread 的记忆
├── user-<peer_id>.md           # Layer 2: per peer 跨 thread 的记忆
└── thread-<thread_id>.md       # Layer 3: per thread 的记忆
```

| 层级 | 文件 | 范围 | 典型内容 |
|------|------|------|---------|
| Layer 1 | `agent.md` | 跨所有 peer 和 thread | agent 自我改进笔记、通用知识、行为模式总结 |
| Layer 2 | `user-<peer_id>.md` | 单个 peer 跨所有 thread | 用户偏好、交互风格、历史摘要 |
| Layer 3 | `thread-<thread_id>.md` | 单个 thread | 当前对话的压缩摘要 |

memory 格式统一使用 Markdown：LLM 天然擅长读写 Markdown，memory 本身就是给 LLM 消费的压缩文本，不需要结构化查询。

#### Context 构建流程

每次 `agent run` 处理消息、调用 `pai chat` 前：

1. 读取 `memory/agent.md`（若存在）
2. 读取 `memory/user-<peer_id>.md`（若存在，peer_id 从入站消息的 source 解析）
3. 读取 `memory/thread-<thread_id>.md`（若存在）
4. 从对话 thread 取最近 N 条原始消息（`thread peek --thread <path> --last-event-id <id> --limit <N> --filter "type = 'message'"`）
5. 组装 system prompt = IDENTITY.md + agent.md 摘要 + user memory 摘要 + thread memory 摘要
6. 构建 session-file = system prompt + 最近 N 条 messages，传给 `pai chat`
7. `pai chat` 完成后，将新产生的 assistant/tool messages 写回 thread（`thread push`）

#### Memory 压缩

由 agent 框架触发（非 LLM 自触发），保持为独立模块以便后期替换策略或算法。

触发时机：`agent run` 在调用 `pai chat` 前检查 context 大小（token 估算），超过阈值时先执行压缩再构建 context。

压缩方式：发起一次独立的 `pai chat` 调用，system prompt 指示 LLM 将对话历史压缩为摘要，输出写入对应层级的 memory 文件：
- thread 级别压缩 → 更新 `memory/thread-<thread_id>.md`
- 跨 thread 的 peer 级别压缩 → 更新 `memory/user-<peer_id>.md`（触发频率较低，如 peer 的多个 thread 都积累了足够内容时）
- agent 级别压缩 → 更新 `memory/agent.md`（触发频率最低，如定期自省）

## 7. System Agents

系统预置以下 agent，通过 `agent init` 初始化：

| agent_id | Role |
|----------|------|
| `admin` | System administrator, user-facing, handles daily interaction and agent management |
| `warden` | Security / audit / compliance, monitors system behavior |
| `maintainer` | Upgrades / maintenance, handles system updates |
| `evolver` | Self-iteration / learning / optimization |

system agents 不直接和外部 peer 交互（除 admin 外），主要通过 thread 事件与其他 agent 协作。

## 8. Output Format

### 8.1 stdout / stderr Contract

- `stdout`: Command result data (status info, agent list, etc.).
- `stderr`: Progress, debug, error, and warning messages.

### 8.2 Human / Machine Readability

- Default output is human-readable.
- `--json` enables structured JSON output (`status`, `list`).

## 9. Error Handling & Exit Codes

### 9.1 Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Logic error (agent not found, config error, etc.) |
| `2` | Usage/argument error (missing required args, etc.) |

### 9.2 Error Output

- Default (no `--json`): human-readable error to `stderr`, format `Error: <what went wrong> - <how to fix>`.
- `--json` mode: `{"error": "...", "suggestion": "..."}`

## 10. Logging

Log file: `~/.theclaw/agents/<id>/logs/agent.log`

**记录内容**：
- `agent run` 启动/完成，处理消息数量
- inbox pop 结果
- thread 路由决策
- `pai chat` 调用状态（耗时、token 用量）
- outbound consumer 出站投递结果
- 文件锁状态（获取/释放/跳过）

**Rotation**: 超过 10000 行时自动轮换（与其他 repo 一致）。

## 11. Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `THECLAW_HOME` | TheClaw data root directory | `~/.theclaw` |

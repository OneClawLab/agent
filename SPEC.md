# SPEC: agent

`agent` 是 TheClaw 系统的 agent 生命周期管理工具，负责创建/启动/停止 agent，并驱动 agent 的核心运行循环：从 inbox 消费消息、路由到 thread、调用 LLM（通过 `pai`）、将结果写回 thread，以及将回复通过 `xgw` 投递给外部 peer。

## 决策记录

1. **Agent 即目录**：每个 agent 的全部数据存放在一个目录下（`~/.theclaw/agents/<agent_id>/`），通过 `agent init <id>` 初始化。agent_id 即目录名，天然唯一。
2. **Inbox 是特殊 thread**：agent 的 inbox 是一个普通 thread 目录（由 `thread` 工具管理），xgw 通过 `thread push` 写入，agent 通过 `thread pop` 消费。inbox 不做语义路由，只是入站队列。
3. **Agent 运行循环由 notifier 驱动**：agent 不是常驻进程，而是由 `notifier` 在有新消息时调度启动（通过 thread 的 dispatch 机制）。每次调度运行一个处理批次后退出，文件锁保证同一 agent 不并发运行。
4. **LLM 调用通过 `pai`**：agent 不直接调用 LLM API，而是通过 `pai chat` 命令，保持工具链一致性。session 文件存储在 agent 目录下，实现多轮对话持久化。
5. **出站回复通过 `xgw send`**：agent 将回复写入 thread 后，由注册在该 thread 上的 outbound consumer 触发投递。outbound consumer 是通过 `thread subscribe` 注册的普通 consumer，handler 命令即为 `xgw send --channel <id> --peer <id> ...`，由 thread dispatch 机制自动触发，无独立进程。
6. **System prompt 与 identity 分离**：agent 的 identity（IDENTITY.md）描述 agent 的角色和能力，system prompt 由 agent 运行时动态组装（identity + 当前 thread 上下文 + 工具提示）。
7. **工具发现通过 `cmds`**：agent 配备的唯一 LLM tool 是 `bash_exec`，通过内置的 `cmds` 命令渐进发现系统能力（遵循 TheClaw 整体设计原则）。
8. **多 agent 支持**：系统预置 system agents（admin、warden 等），用户可通过 admin 创建 user agents。所有 agent 共享同一套运行机制。

## 1. 定位 (Role)

```
xgw → agent.inbox (thread) → agent run-loop
                                ├── pai chat (LLM)
                                ├── bash_exec (tools)
                                └── thread push (出站事件)
                                        ↓
                              outbound consumer → agent deliver → xgw send → channel → peer
```

**agent 的职责**：
- **Inbox 消费**：从 inbox thread 消费入站消息（`thread pop`）。
- **Thread 路由**：将消息路由到对应的 thread（新建或继续已有 thread）。
- **LLM 驱动**：调用 `pai chat` 处理消息，产生回复和 tool calls。
- **事件记录**：将 toolcall、decision、message 等事件写入 thread（`thread push`）。
- **出站分发**：在需要出站的 thread 上注册 outbound consumer，由 thread dispatch 机制触发 `xgw send` 投递。
- **生命周期管理**：通过 `agent` CLI 管理 agent 的创建、配置、启停。

## 2. 技术栈与项目结构

遵循 TheClaw 其他 repo 约定：

- **TypeScript + ESM** (Node 22+)
- **构建**: tsup (ESM, shebang banner)
- **测试**: vitest
- **CLI 解析**: commander

```
agent/
├── src/
│   ├── index.ts              # 入口，CLI 解析与分发
│   ├── commands/
│   │   ├── init.ts           # agent init <id>
│   │   ├── start.ts          # agent start <id>
│   │   ├── stop.ts           # agent stop <id>
│   │   ├── status.ts         # agent status [<id>] [--json]
│   │   ├── list.ts           # agent list [--json]
│   │   ├── run.ts            # agent run <id>（内部，由 notifier 调度）
│   │   └── deliver.ts # agent deliver（内部，由 outbound consumer 触发）
│   ├── runner/
│   │   ├── inbox.ts          # inbox 消费逻辑
│   │   ├── router.ts         # 消息 → thread 路由
│   │   ├── llm.ts            # 调用 pai chat
│   │   ├── recorder.ts       # 事件写入 thread
│   │   └── deliver.ts        # agent deliver（内部，由 outbound consumer 触发）
│   ├── config.ts             # agent 配置加载
│   ├── identity.ts           # IDENTITY.md 加载与 system prompt 组装
│   ├── logger.ts             # 运行日志
│   └── types.ts              # 共享类型定义
├── vitest/
├── package.json
├── tsconfig.json
├── tsup.config.ts
├── vitest.config.ts
├── SPEC.md
└── USAGE.md
```

## 3. Agent 目录规范

```
~/.theclaw/agents/<agent_id>/
├── IDENTITY.md               # agent 身份描述（角色、能力、行为准则）
├── config.yaml               # agent 配置（inbox 路径、pai provider、routing 规则等）
├── inbox/                    # inbox thread 目录（由 thread init 初始化）
│   ├── events.db
│   ├── events.jsonl
│   └── ...
├── sessions/                 # pai chat session 文件（JSONL，按 thread_id 命名）
│   └── <thread_id>.jsonl
├── threads/                  # agent 私有 thread 目录
│   ├── memory/               # 私有记忆 thread
│   └── tasks/                # 私有任务 thread
├── workdir/                  # 临时工作区（plan、草稿等）
└── logs/
    ├── agent.log
    └── agent-<YYYYMMDD-HHmmss>.log
```

全局共享 thread 存放在 `~/.theclaw/threads/`（由系统统一管理，不属于单个 agent）。

## 4. Agent 配置文件

`~/.theclaw/agents/<agent_id>/config.yaml`：

```yaml
agent_id: admin
kind: system          # system | user

pai:
  provider: openai
  model: gpt-4o

inbox:
  path: ~/.theclaw/agents/admin/inbox   # thread 目录路径

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

## 5. CLI 子命令规范

### `agent init <id>`

初始化一个新 agent。

```bash
agent init admin [--kind system|user]
```

**行为**：
1. 创建 `~/.theclaw/agents/<id>/` 目录结构。
2. 生成默认 `IDENTITY.md` 和 `config.yaml`。
3. 通过 `thread init` 初始化 inbox thread。
4. 若 agent 已存在，报错退出（退出码 1）。

### `agent start <id>`

启动 agent（注册 inbox 订阅，使 agent 开始响应消息）。

```bash
agent start <id>
```

**行为**：
1. 加载 agent 配置。
2. 通过 `thread subscribe` 在 inbox thread 注册订阅，handler 为 `agent run <id>`。
3. 记录启动日志。

agent 本身不是常驻进程——`start` 只是注册订阅，实际运行由 `notifier` 在有新消息时触发 `agent run`。

### `agent stop <id>`

停止 agent（注销 inbox 订阅）。

```bash
agent stop <id>
```

**行为**：通过 `thread unsubscribe` 注销 inbox 订阅。已在运行的 `agent run` 实例会自然完成当前批次后退出。

### `agent run <id>`（Internal）

由 `notifier` 通过 thread dispatch 机制自动调用，不建议手动执行。

```bash
agent run <id>
```

**行为**（单次运行批次）：
1. 从 inbox thread 消费消息（`thread pop --consumer <id> --last-event-id <last>`）。
2. 若无新消息，直接退出（退出码 0）。
3. 对每条入站消息：
   a. 路由到目标 thread（根据 routing 规则，新建或复用）。
   b. 将消息写入目标 thread（`thread push --type message --source <peer_id>`）。
   c. 组装 system prompt（IDENTITY.md + thread 上下文）。
   d. 调用 `pai chat`（携带 session 文件，实现多轮对话）。
   e. 将 LLM 回复写入 thread（`thread push --type message --source <agent_id>`）。
   f. 将 toolcall 记录写入 thread（`thread push --type record --subtype toolcall`）。
4. 若该 thread 是首次创建（新 peer 对话），注册 outbound consumer（见 6.4）。
5. 更新 inbox 消费进度（下次 `thread pop` 传入已处理的最大 event id）。

文件锁（`~/.theclaw/agents/<id>/run.lock`）保证同一 agent 不并发运行。

### `agent status [<id>]`

查看 agent 运行状态。

```bash
agent status [<id>] [--json]
```

输出：agent 列表或单个 agent 的状态（是否已启动、inbox 消费进度、最近活动时间）。

### `agent list`

列出所有 agent。

```bash
agent list [--json]
```

## 6. 运行循环详解

### 6.1 Inbox 消费

inbox 是一个普通 thread，agent 作为 consumer 订阅它。`thread dispatch` 在有新消息时触发 `agent run`，`agent run` 通过 `thread pop` 批量取出消息处理。

消费进度持久化在 inbox thread 的 `consumer_progress` 表中（at-least-once 语义）。

### 6.2 Thread 路由

路由规则（`config.yaml` 中的 `routing.default`）决定入站消息进入哪个 thread：

| 模式 | 说明 | Thread 路径 |
|------|------|-------------|
| `per-peer`（默认） | 每个 `(channel_id, peer_id)` 组合一个独立 thread | `threads/peers/<channel_id>-<peer_id>/` |
| `per-channel` | 同一渠道的所有 peer 共享一个 thread | `threads/channels/<channel_id>/` |
| `per-agent` | 所有渠道、所有 peer 共享同一个 thread | `threads/main/` |

- `per-peer`：适合大多数场景，每个用户有独立的对话上下文。
- `per-channel`：适合群聊类场景，或希望同一渠道的消息汇聚在一起。
- `per-agent`：适合单用户/单渠道的简单场景，或需要跨渠道统一上下文的场景。

Thread 不存在时自动通过 `thread init` 创建。

**Outbound consumer 注册**：只有从 inbox 路由过来的 peer 对话 thread 才注册 outbound consumer（见 6.4）。注册时将 `channel_id`、`peer_id`、`session_id` 硬编码进 handler 命令。`per-channel` 和 `per-agent` 模式下，同一 thread 可能对应多个 peer，outbound consumer 需要从 event 的 `content` 中读取目标 peer 信息（agent 写入 thread 时需在 content 中携带回信地址）。

### 6.3 LLM 调用

```bash
pai chat \
  --session ~/.theclaw/agents/<id>/sessions/<thread_id>.jsonl \
  --system-file ~/.theclaw/agents/<id>/IDENTITY.md \
  --provider <provider> \
  --model <model> \
  "<user_message>"
```

`pai chat` 的 stdout 即为 LLM 回复文本。`--json` 模式下可获取结构化输出（tool calls 等）。

### 6.4 Outbound Consumer（出站投递）

outbound consumer 没有独立进程，物理上就是注册在目标 thread 上的一个普通 consumer，由 thread dispatch 机制触发 `agent deliver`。

**注册时机**：`agent run` 路由消息到某个 thread 时，若该 thread 尚未注册 outbound consumer，则调用：

```bash
thread subscribe \
  --thread <thread_path> \
  --consumer outbound \
  --filter "type = 'message' AND source = '<agent_id>'" \
  --handler "agent deliver --thread <thread_path> --consumer outbound --channel <channel_id> --peer <peer_id> --session <session_id>"
```

- `--filter` 精确匹配：只有 agent 自己产生的 `type=message` 事件才触发出站，内部 `record` 事件（toolcall/decision）不触发。
- `--handler` 里的 `channel_id`、`peer_id`、`session_id` 在注册时从入站消息中提取并硬编码进命令字符串。
- `thread dispatch` 只负责"有新事件时触发 handler"，不传递数据。handler（`agent deliver`）自己通过 `thread pop` 取数据，与 `agent run` 的模式完全一致。

**`agent deliver`**（Internal）：由 outbound consumer handler 触发，执行出站投递批次：
1. `thread pop --consumer outbound --last-event-id <last>` 取出待投递 events。
2. 对每条 event 调用 `xgw send --channel <id> --peer <id> --session <id> --message "<content>"`。
3. 消费进度由 `thread` 的 `consumer_progress` 持久化，at-least-once 语义，文件锁保证不并发。

**消费进度**：由 `thread` 的 `consumer_progress` 机制保证 at-least-once 投递，每条出站消息只投递一次（文件锁保证 handler 不并发）。

**哪些 thread 需要出站**：只有从 inbox 路由过来的 peer 对话 thread 需要注册 outbound consumer。agent 内部的 memory/tasks thread 不注册，因此不会触发出站。这个区分由路由层（6.2）在创建 thread 时决定，而非在 event 层判断。

## 7. System Agents

系统预置以下 agent，通过 `agent init` 初始化：

| agent_id | 职责 |
|----------|------|
| `admin` | 系统管理员，面向用户，处理日常交互和 agent 管理 |
| `warden` | 安全/审计/合规，监控系统行为 |
| `maintainer` | 升级/维护，处理系统更新 |
| `evolver` | 自我迭代/学习/优化 |

system agents 不直接和外部 peer 交互（除 admin 外），主要通过 thread 事件与其他 agent 协作。

## 8. 机器可读输出与错误处理

### 8.1 退出码

| 退出码 | 含义 |
|--------|------|
| `0` | 成功 |
| `1` | 一般逻辑错误（agent 不存在、配置错误等） |
| `2` | 参数/语法错误（缺少必需参数等） |

### 8.2 错误输出

stderr 格式：`Error: <什么错了> - <怎么修>`

`--json` 模式下：`{"error": "...", "suggestion": "..."}`

## 9. 日志规范

日志文件：`~/.theclaw/agents/<id>/logs/agent.log`

**记录内容**：
- `agent run` 启动/完成，处理消息数量
- inbox pop 结果
- thread 路由决策
- `pai chat` 调用状态（耗时、token 用量）
- outbound consumer 出站投递结果
- 文件锁状态（获取/释放/跳过）

**轮换策略**：超过 10000 行时自动轮换（与其他 repo 一致）。

## 10. 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `THECLAW_HOME` | TheClaw 数据根目录 | `~/.theclaw` |

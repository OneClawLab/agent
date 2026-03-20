# 需求文档

## 简介

Agent Runtime 是 TheClaw 多 agent AI 平台的核心运行时模块，负责 agent 的完整生命周期管理：创建、启动、停止，以及驱动核心运行循环——从 inbox 消费消息、路由到 thread、调用 LLM（通过 `pai`）、记录事件、并通过 `xgw` 向外部 peer 投递回复。

Agent 不是常驻进程，而是由 `notifier` 在有新消息时调度启动，每次运行一个处理批次后退出。所有数据存放在 `~/.theclaw/agents/<agent_id>/` 目录下。

## 术语表

- **Agent**: TheClaw 平台中的 AI 代理实体，拥有独立的 inbox、thread、memory 和配置
- **Agent_Directory**: agent 的数据根目录，路径为 `~/.theclaw/agents/<agent_id>/`
- **Inbox**: agent 的入站消息队列，物理上是一个普通 thread 目录，由 `thread` 工具管理
- **Thread**: 事件队列目录，由 `thread` CLI 工具管理，存储消息和记录事件
- **Run_Loop**: agent 的核心运行循环，由 `notifier` 调度触发，消费 inbox 消息并处理
- **Outbound_Consumer**: 注册在 thread 上的消费者，负责将 agent 回复投递到外部
- **Reply_Context**: 入站消息中携带的出站路由信息，包含 channel_type、channel_id、peer_id 等
- **Memory**: agent 的记忆系统，分三层：agent 级、peer 级、thread 级，均为 Markdown 格式
- **Session_File**: `pai chat` 的会话文件（JSONL 格式），存储在 agent 的 sessions 目录下
- **Config**: agent 的配置文件（config.yaml），包含 pai 配置、路由规则、出站配置等
- **System_Agent**: 系统预置的 agent（admin、warden、maintainer、evolver）
- **CLI**: agent 命令行接口，基于 commander 框架

## 需求

### 需求 1：Agent 初始化

**用户故事：** 作为系统管理员，我希望通过 CLI 初始化一个新的 agent，以便为其创建完整的目录结构和默认配置。

#### 验收标准

1. WHEN 用户执行 `agent init <id>` THEN CLI SHALL 在 `~/.theclaw/agents/<id>/` 下创建完整的目录结构，包括 inbox/、sessions/、memory/、threads/、workdir/、logs/ 子目录
2. WHEN 用户执行 `agent init <id>` THEN CLI SHALL 生成默认的 IDENTITY.md、USAGE.md 和 config.yaml 文件
3. WHEN 用户执行 `agent init <id>` THEN CLI SHALL 通过 `thread init` 初始化 inbox thread 目录
4. IF agent 目录已存在 THEN CLI SHALL 输出错误信息并以退出码 1 退出
5. WHERE 用户指定 `--kind system|user` 选项 THEN CLI SHALL 在 config.yaml 中记录对应的 kind 值
6. WHEN `--kind` 未指定 THEN CLI SHALL 默认使用 `user` 作为 kind 值

### 需求 2：Agent 启动

**用户故事：** 作为系统管理员，我希望启动一个 agent，使其开始响应 inbox 中的新消息。

#### 验收标准

1. WHEN 用户执行 `agent start <id>` THEN CLI SHALL 加载 agent 配置并通过 `thread subscribe` 在 inbox thread 注册订阅，handler 为 `agent run <id>`
2. WHEN agent 成功启动 THEN CLI SHALL 记录启动日志到 agent 的日志文件
3. IF agent 目录不存在 THEN CLI SHALL 输出错误信息并以退出码 1 退出

### 需求 3：Agent 停止

**用户故事：** 作为系统管理员，我希望停止一个 agent，使其暂停处理新消息，同时保留所有状态。

#### 验收标准

1. WHEN 用户执行 `agent stop <id>` THEN CLI SHALL 通过 `thread unsubscribe` 注销 inbox 订阅
2. WHEN agent 停止后 THEN Run_Loop SHALL 保留消费进度，inbox 中的消息继续积累
3. IF agent 目录不存在 THEN CLI SHALL 输出错误信息并以退出码 1 退出

### 需求 4：Agent 运行循环（Run Loop）

**用户故事：** 作为 agent 运行时，我希望在被 notifier 调度时执行一个完整的消息处理批次，以便消费 inbox 消息并产生回复。

#### 验收标准

1. WHEN `agent run <id>` 被触发 THEN Run_Loop SHALL 通过 `thread pop` 从 inbox 消费消息
2. WHEN inbox 中无新消息 THEN Run_Loop SHALL 以退出码 0 直接退出
3. WHEN 处理入站消息时 THEN Run_Loop SHALL 根据 routing 规则将消息路由到目标 thread
4. WHEN 消息路由到目标 thread 时 THEN Run_Loop SHALL 通过 `thread push` 将消息写入目标 thread，保留入站消息的完整 source 地址
5. WHEN 处理消息时 THEN Run_Loop SHALL 组装 system prompt（IDENTITY.md + memory 上下文）并调用 `pai chat`
6. WHEN `pai chat` 返回回复 THEN Run_Loop SHALL 将 LLM 回复通过 `thread push` 写入 thread，source 标记为 `self`
7. WHEN LLM 产生 toolcall THEN Run_Loop SHALL 将 toolcall 记录通过 `thread push` 写入 thread，type 为 `record`，subtype 为 `toolcall`
8. WHEN 目标 thread 是首次创建的 peer 对话 thread THEN Run_Loop SHALL 注册 outbound consumer
9. WHEN 批次处理完成 THEN Run_Loop SHALL 更新 inbox 消费进度
10. WHILE `agent run` 执行期间 THEN Run_Loop SHALL 持有文件锁（`run.lock`），防止同一 agent 并发运行

### 需求 5：Thread 路由

**用户故事：** 作为 agent 运行时，我希望根据配置的路由规则将入站消息分配到正确的 thread，以便维护独立的对话上下文。

#### 验收标准

1. WHEN routing 配置为 `per-peer` THEN Router SHALL 将消息路由到 `threads/peers/<channel_id>-<peer_id>/` 目录
2. WHEN routing 配置为 `per-channel` THEN Router SHALL 将消息路由到 `threads/channels/<channel_id>/` 目录
3. WHEN routing 配置为 `per-agent` THEN Router SHALL 将消息路由到 `threads/main/` 目录
4. WHEN 目标 thread 目录不存在 THEN Router SHALL 通过 `thread init` 自动创建该 thread

### 需求 6：LLM 调用

**用户故事：** 作为 agent 运行时，我希望通过 `pai chat` 调用 LLM 处理消息，以便生成智能回复和工具调用。

#### 验收标准

1. WHEN 调用 LLM 时 THEN Run_Loop SHALL 使用 agent 的 session 文件（`sessions/<thread_id>.jsonl`）实现多轮对话持久化
2. WHEN 调用 `pai chat` 时 THEN Run_Loop SHALL 传入 provider、model、system prompt 和用户消息
3. WHEN agent 写回复到 thread 时 THEN Run_Loop SHALL 在 content 中携带入站消息的 reply_context，以便 outbound consumer 提取出站路由信息

### 需求 7：出站投递（Outbound Delivery）

**用户故事：** 作为 agent 运行时，我希望将 agent 的回复自动投递到外部 peer 或内部 agent，以便完成消息的端到端传递。

#### 验收标准

1. WHEN `agent deliver` 被触发 THEN Outbound_Consumer SHALL 通过 `thread pop` 取出待投递的 events
2. WHEN event 的 reply_context 包含 external 渠道信息 THEN Outbound_Consumer SHALL 调用 `xgw send` 进行外部投递
3. WHEN event 的 reply_context 标识为 internal 来源 THEN Outbound_Consumer SHALL 通过 `thread push` 写入发送方 agent 的 inbox
4. IF 投递失败（`xgw send` 返回非零退出码） THEN Outbound_Consumer SHALL 不更新该 event 的消费进度，等待下次 dispatch 重试
5. IF 同一 event 连续投递失败达到最大重试次数（默认 3 次） THEN Outbound_Consumer SHALL 写一条 `type=record, subtype=error` 事件到 thread 记录失败信息，然后跳过该 event
6. WHEN 注册 outbound consumer 时 THEN Run_Loop SHALL 使用 filter `type = 'message' AND source = 'self'` 确保只有 agent 自己产生的消息触发出站

### 需求 8：上下文构建与 Memory 管理

**用户故事：** 作为 agent 运行时，我希望在每次 LLM 调用前构建完整的上下文，并在上下文过大时自动压缩 memory，以便维持高质量的对话。

#### 验收标准

1. WHEN 构建 LLM 上下文时 THEN Run_Loop SHALL 按顺序读取 agent.md、user-<peer_id>.md、thread-<thread_id>.md 三层 memory 文件
2. WHEN 构建 LLM 上下文时 THEN Run_Loop SHALL 从对话 thread 取最近 N 条原始消息
3. WHEN 构建 LLM 上下文时 THEN Run_Loop SHALL 组装 system prompt 为 IDENTITY.md + 三层 memory 摘要的组合
4. WHEN context 大小（token 估算）超过阈值 THEN Run_Loop SHALL 在调用 `pai chat` 前先执行 memory 压缩
5. WHEN 执行 thread 级别 memory 压缩时 THEN Run_Loop SHALL 发起独立的 `pai chat` 调用将对话历史压缩为摘要，写入 `memory/thread-<thread_id>.md`

### 需求 9：Agent 配置管理

**用户故事：** 作为 agent 运行时，我希望从 config.yaml 加载 agent 配置，以便驱动路由、LLM 调用和出站投递等行为。

#### 验收标准

1. WHEN 加载 agent 配置时 THEN Config SHALL 从 `~/.theclaw/agents/<id>/config.yaml` 读取并解析 YAML 配置
2. WHEN config.yaml 中缺少必要字段 THEN Config SHALL 使用合理的默认值（routing.default 默认 `per-peer`，deliver.max_attempts 默认 3，retry.max_attempts 默认 3）
3. IF config.yaml 文件不存在或格式错误 THEN Config SHALL 返回描述性错误信息

### 需求 10：Agent 状态与列表查询

**用户故事：** 作为系统管理员，我希望查看 agent 的运行状态和列表，以便监控系统运行情况。

#### 验收标准

1. WHEN 用户执行 `agent status <id>` THEN CLI SHALL 显示该 agent 的状态信息（是否已启动、inbox 消费进度、最近活动时间）
2. WHEN 用户执行 `agent list` THEN CLI SHALL 列出所有已初始化的 agent
3. WHERE 用户指定 `--json` 选项 THEN CLI SHALL 输出结构化 JSON 格式

### 需求 11：错误处理与重试

**用户故事：** 作为 agent 运行时，我希望对不同类型的错误采取不同的处理策略，以便保证系统的健壮性。

#### 验收标准

1. WHEN 发生可恢复错误（网络超时、LLM API 临时错误、rate limit） THEN Run_Loop SHALL 自动重试，最多重试次数由 config.yaml 的 `retry.max_attempts` 配置（默认 3 次），使用指数退避
2. WHEN 发生不可恢复错误（配置错误、认证失败） THEN Run_Loop SHALL 不重试，写一条 `type=record, subtype=error` 事件到当前 thread，然后继续处理下一条消息
3. WHEN 发生批次级别致命错误（inbox 不可访问、文件锁获取失败） THEN Run_Loop SHALL 直接以退出码 1 退出
4. WHEN 输出错误信息时 THEN CLI SHALL 使用格式 `Error: <what went wrong> - <how to fix>` 输出到 stderr
5. WHERE 用户指定 `--json` 选项 THEN CLI SHALL 以 `{"error": "...", "suggestion": "..."}` 格式输出错误

### 需求 12：日志记录

**用户故事：** 作为系统管理员，我希望 agent 运行时记录详细的日志，以便排查问题和监控运行状况。

#### 验收标准

1. WHEN `agent run` 执行时 THEN Logger SHALL 记录启动/完成、处理消息数量、inbox pop 结果、thread 路由决策、`pai chat` 调用状态、出站投递结果、文件锁状态到日志文件
2. WHEN 日志文件超过 10000 行 THEN Logger SHALL 自动执行日志轮换
3. THE Logger SHALL 将日志写入 `~/.theclaw/agents/<id>/logs/agent.log`

### 需求 13：CLI 入口与命令分发

**用户故事：** 作为用户，我希望通过统一的 `agent` CLI 入口访问所有子命令，以便方便地管理 agent。

#### 验收标准

1. THE CLI SHALL 使用 commander 框架解析命令行参数并分发到对应的子命令处理函数
2. WHEN 用户提供无效的命令或参数 THEN CLI SHALL 以退出码 2 退出并显示用法帮助
3. THE CLI SHALL 将 stdout 用于命令结果数据，stderr 用于进度、调试、错误和警告信息

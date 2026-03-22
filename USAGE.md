# USAGE: agent

## 安装

```bash
npm run build && npm link
```

---

## 生命周期管理

### `agent init <id>`

初始化一个新 agent。

```bash
agent init admin [--kind system|user]
```

创建 `~/.theclaw/agents/<id>/` 目录结构，生成默认 `IDENTITY.md`、`USAGE.md`、`config.yaml`，并初始化 inbox thread。

### `agent start <id>`

启动 agent（注册 inbox 订阅，使 notifier 能调度 `agent run`）。

```bash
agent start admin
```

agent 本身不是常驻进程，`start` 只是注册订阅。stop 期间积累的消息不会丢失，start 后从上次进度继续。

### `agent stop <id>`

暂停 agent（注销 inbox 订阅，保留所有状态）。

```bash
agent stop admin
```

暂停而非销毁。删除 agent 直接 `rm -rf ~/.theclaw/agents/<id>/`。

### `agent status [<id>]`

查看 agent 状态。

```bash
agent status
agent status admin
agent status admin --json
```

### `agent list`

列出所有 agent。

```bash
agent list
agent list --json
```

---

## 内部命令（由系统自动调用）

### `agent run <id>`

由 notifier 通过 thread dispatch 自动触发，**不建议手动执行**。

从 inbox 消费消息，路由到对应 thread，调用 LLM（`pai chat`），将回复写回 thread，触发出站投递。

### `agent deliver`

由 outbound consumer handler 自动触发，**不建议手动执行**。

从 thread 取出待投递事件，根据 `reply_context` 调用 `xgw send`（external 来源）或 `thread push`（internal 来源）。

---

## 调试辅助命令

### `agent send <id>`

将事件推入 agent inbox，等价于：

```bash
thread push --thread ~/.theclaw/agents/<id>/inbox ...
```

只是帮你省掉了查找 inbox 路径这一步。参数与 `thread push` 完全一致。

```bash
# 模拟 xgw 推入一条外部消息
agent send admin \
  --source xgw:telegram:channel-1 \
  --type message \
  --content '{"text":"你好","reply_context":{"channel_type":"external","channel_id":"telegram-1","peer_id":"user-42"}}'
```

消息进入 inbox 后，若 agent 已 `start`，notifier 会自动触发 `agent run` 处理它。这条路径与真实的 xgw 入站路径完全一致。

### `agent chat <id>`

> **注意**：`agent chat` 是本地调试工具，**绕过了 xgw、notifier、inbox、outbound 等常规流程**，直接在进程内同步调用 LLM。跑通 `agent chat` 不能证明完整链路正常，仅用于快速验证 agent 的 LLM 行为（identity、memory、prompt 组装等）。

交互式 REPL，直接与 agent 的 LLM 对话。

```bash
agent chat admin
```

```
Chatting with agent 'admin' (Ctrl+C or Ctrl+D to exit)

> 你好
你好！有什么可以帮你的？

> 帮我列出当前所有 agent
...
```

会话路由到固定 thread（`threads/peers/cli-cli/`），session 文件跨次持久化，多轮对话上下文保留。

---

## 数据目录

```
~/.theclaw/agents/<id>/
├── IDENTITY.md       # agent system prompt（对内）
├── USAGE.md          # 使用说明（对外）
├── config.yaml       # 配置（pai provider、routing、outbound 等）
├── inbox/            # inbox thread 目录
├── sessions/         # pai chat session 文件（per thread）
├── memory/           # 记忆文件（agent.md / user-<id>.md / thread-<id>.md）
├── threads/          # agent 私有 thread 目录
├── workdir/          # 临时工作区
└── logs/
```

## 环境变量

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `THECLAW_HOME` | TheClaw 数据根目录 | `~/.theclaw` |

## 退出码

| 退出码 | 含义 |
|--------|------|
| `0` | 成功 |
| `1` | 逻辑错误（agent 不存在、配置错误等） |
| `2` | 参数/语法错误 |

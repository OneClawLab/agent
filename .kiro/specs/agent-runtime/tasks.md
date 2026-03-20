# Implementation Plan: Agent Runtime

## Overview

基于 SPEC.md 和设计文档，将 agent runtime 实现为 TypeScript + ESM CLI 工具。采用增量构建方式：先搭建项目骨架和核心类型，再逐步实现各命令和 runner 模块，最后集成联调。

## Tasks

- [x] 1. 项目骨架与核心类型
  - [x] 1.1 初始化项目结构（package.json、tsconfig.json、tsup.config.ts、vitest.config.ts）
    - 配置 ESM 输出、shebang banner、vitest 测试目录
    - 安装依赖：commander、yaml（YAML 解析）、fast-check（属性测试）
    - _Requirements: 13.1_
  - [x] 1.2 创建 `src/types.ts` 定义所有共享类型
    - InboxMessage、ReplyContext、ToolCall、RoutingMode、AgentConfig 等
    - _Requirements: 9.1_
  - [x] 1.3 创建 `src/index.ts` CLI 入口
    - 使用 commander 注册所有子命令（init、start、stop、status、list、run、deliver）
    - 统一处理 `--json` 全局选项
    - 无效命令/参数以退出码 2 退出
    - _Requirements: 13.1, 13.2, 13.3_

- [x] 2. 配置与日志模块
  - [x] 2.1 实现 `src/config.ts` 配置加载
    - 从 config.yaml 读取并解析 YAML
    - 填充默认值（routing.default='per-peer'、retry.max_attempts=3、deliver.max_attempts=3）
    - 文件不存在或格式错误时返回描述性错误
    - _Requirements: 9.1, 9.2, 9.3_
  - [x]* 2.2 写配置模块属性测试
    - **Property 7: 配置默认值填充**
    - **Property 8: 配置解析 Round-Trip**
    - **Validates: Requirements 9.1, 9.2**
  - [x] 2.3 实现 `src/logger.ts` 日志模块
    - 写入 `<agentDir>/logs/agent.log`
    - 超过 10000 行自动轮换为带时间戳的归档文件
    - _Requirements: 12.1, 12.2, 12.3_
  - [x]* 2.4 写日志轮换属性测试
    - **Property 12: 日志轮换**
    - **Validates: Requirements 12.2**

- [x] 3. Checkpoint - 确保基础模块测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 4. Identity 与路由模块
  - [x] 4.1 实现 `src/identity.ts` Identity 加载与 System Prompt 组装
    - 读取 IDENTITY.md
    - 按顺序读取三层 memory 文件（agent.md、user-\<peer_id\>.md、thread-\<thread_id\>.md）
    - 组装 system prompt = identity + 各层 memory
    - _Requirements: 8.1, 8.3_
  - [x]* 4.2 写 System Prompt 组装属性测试
    - **Property 4: System Prompt 组装完整性**
    - **Validates: Requirements 4.5, 8.1, 8.3**
  - [x] 4.3 实现 `src/runner/router.ts` 消息路由
    - `resolveThreadPath`：根据 routing mode 计算 thread 路径
    - `routeMessage`：检查目录是否存在，不存在则 `thread init` 创建
    - _Requirements: 4.3, 5.1, 5.2, 5.3, 5.4_
  - [x]* 4.4 写 Thread 路由属性测试
    - **Property 1: Thread 路径解析正确性**
    - **Validates: Requirements 4.3, 5.1, 5.2, 5.3**

- [x] 5. Runner 核心模块
  - [x] 5.1 实现 `src/runner/inbox.ts` Inbox 消费
    - 通过 `thread pop` 消费消息
    - 解析 JSON 输出为 InboxMessage 数组
    - 空数组表示无新消息
    - _Requirements: 4.1, 4.2_
  - [x] 5.2 实现 `src/runner/llm.ts` LLM 调用
    - 构建 `pai chat` 命令参数（session file、system prompt、provider、model）
    - Session 文件路径：`<agent_dir>/sessions/<thread_id>.jsonl`
    - 解析 LLM 回复
    - _Requirements: 6.1, 6.2_
  - [x] 5.3 实现 `src/runner/recorder.ts` 事件记录
    - `pushMessage`：写入 type=message 事件，保留原始 source
    - `pushRecord`：写入 type=record 事件（toolcall、error 等）
    - 回复消息中携带 reply_context
    - _Requirements: 4.4, 4.6, 4.7, 6.3_
  - [x]* 5.4 写消息转发属性测试
    - **Property 2: Source 地址透传**
    - **Property 3: Reply Context 透传**
    - **Validates: Requirements 4.4, 6.3**

- [x] 6. 出站投递模块
  - [x] 6.1 实现 `src/runner/deliver.ts` 出站投递逻辑
    - 通过 `thread pop` 取出待投递 events
    - 根据 reply_context.channel_type 选择投递方式（xgw send / thread push）
    - 失败不 ACK，超过 max_attempts 写 error record 并跳过
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5_
  - [x]* 6.2 写出站投递路由属性测试
    - **Property 6: 出站投递路由正确性**
    - **Validates: Requirements 7.2, 7.3**

- [x] 7. 错误处理与重试
  - [x] 7.1 实现错误分类与重试机制
    - `withRetry` 函数：指数退避重试，支持可恢复/不可恢复错误分类
    - 错误输出格式化：人类模式 `Error: <what> - <how>`，JSON 模式 `{"error", "suggestion"}`
    - _Requirements: 11.1, 11.2, 11.3, 11.4, 11.5_
  - [x]* 7.2 写错误处理属性测试
    - **Property 9: 可恢复错误重试上限**
    - **Property 10: 不可恢复错误不重试**
    - **Property 11: 错误输出格式一致性**
    - **Validates: Requirements 11.1, 11.2, 11.4, 11.5**

- [x] 8. Checkpoint - 确保 runner 模块测试通过
  - Ensure all tests pass, ask the user if questions arise.

- [x] 9. CLI 命令实现
  - [x] 9.1 实现 `src/commands/init.ts`
    - 创建完整目录结构（inbox/、sessions/、memory/、threads/{peers,sessions,main}、workdir/、logs/）
    - 生成默认 IDENTITY.md、USAGE.md、config.yaml
    - 通过 `thread init` 初始化 inbox
    - 已存在则报错退出码 1
    - 支持 `--kind system|user`，默认 user
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6_
  - [x] 9.2 实现 `src/commands/start.ts`
    - 加载配置，通过 `thread subscribe` 注册 inbox 订阅
    - handler 为 `agent run <id>`
    - 记录启动日志
    - agent 不存在则报错退出码 1
    - _Requirements: 2.1, 2.2, 2.3_
  - [x] 9.3 实现 `src/commands/stop.ts`
    - 通过 `thread unsubscribe` 注销 inbox 订阅
    - agent 不存在则报错退出码 1
    - _Requirements: 3.1, 3.3_
  - [x] 9.4 实现 `src/commands/run.ts` 核心运行循环
    - 获取文件锁（run.lock）
    - 消费 inbox 消息 → 路由 → 写入 thread → 组装 context → pai chat → 写回复
    - 新 thread 注册 outbound consumer
    - 更新消费进度
    - 无消息时退出码 0
    - Memory 压缩：context 超阈值时先压缩
    - _Requirements: 4.1-4.10, 8.2, 8.4, 8.5_
  - [x] 9.5 实现 `src/commands/deliver.ts` 出站投递命令
    - 调用 runner/deliver.ts 的 deliverBatch
    - _Requirements: 7.1, 7.6_
  - [x] 9.6 实现 `src/commands/status.ts` 和 `src/commands/list.ts`
    - status：显示 agent 状态（是否启动、inbox 进度、最近活动）
    - list：列出所有 agent
    - 支持 `--json` 输出
    - _Requirements: 10.1, 10.2, 10.3_

- [x] 10. 集成与最终验证
  - [x] 10.1 连接所有模块到 CLI 入口
    - 确保 index.ts 正确导入并注册所有命令
    - 验证 tsup 构建输出可执行
    - _Requirements: 13.1, 13.2, 13.3_
  - [x]* 10.2 写集成测试
    - 测试 init → start → run → deliver 完整流程
    - 测试 status 和 list 输出
    - _Requirements: 1.1-1.6, 2.1-2.3, 4.1-4.10, 7.1-7.6, 10.1-10.3_

- [x] 11. Final checkpoint - 确保所有测试通过
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- 所有 shell 命令调用函数从 pai repo 的 os-utils.ts 复制使用，不需要单独写测试
- 属性测试使用 fast-check，每个属性最少 100 次迭代
- 测试文件遵循扁平目录结构：`vitest/unit/` 和 `vitest/pbt/`

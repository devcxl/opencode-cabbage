# 架构概览

本文档介绍 opencode-cabbage 的核心架构设计。

---

## 整体架构

```
┌─────────────────────────────────────────────────────────────┐
│                    OpenCode 运行时                           │
│  ┌───────────────────────────────────────────────────────┐  │
│  │              opencode-cabbage Plugin                   │  │
│  │  ┌─────────────┐  ┌─────────────┐  ┌───────────────┐ │  │
│  │  │  Config      │  │  Events     │  │  Tools        │ │  │
│  │  │  Injection   │  │  Handler    │  │  (goal)       │ │  │
│  │  └──────┬───────┘  └──────┬──────┘  └───────┬───────┘ │  │
│  │         │                 │                  │         │  │
│  │  ┌──────┴─────────────────┴──────────────────┴───────┐ │  │
│  │  │              FlowRun 引擎                           │ │  │
│  │  │  ┌─────────┐ ┌────────┐ ┌────────┐ ┌──────────┐  │ │  │
│  │  │  │ Gate    │ │ GitHub │ │ Merge  │ │Resilience│  │ │  │
│  │  │  │ 检查    │ │ 存储   │ │ 合并   │ │ 弹性     │  │ │  │
│  │  │  └─────────┘ └────────┘ └────────┘ └──────────┘  │ │  │
│  │  └───────────────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │           Agent 团队 (5 agents + 1 goal-verify)       │  │
│  │  @dev-lifecycle → @architect → @backend/@frontend     │  │
│  │                    → @reviewer → @goal-verify          │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## 三层架构

### 1. 基础设施层 (`src/`)

TypeScript 薄层，职责：

- **插件入口** (`index.ts`) — 导出 `{ id, server }`
- **包路径解析** (`plugin.ts`) — 解析 npm 包根路径
- **主工厂** (`plugin/server.ts`) — 创建 `Plugin` 接口，注入配置、注册事件、暴露 tool

### 2. 加载器层 (`src/plugin/`)

负责将 `assets/` 中的资源加载到 OpenCode 配置：

| 加载器 | 职责 |
|--------|------|
| `commands.ts` | 解析 markdown frontmatter，注册 9 个 slash command |
| `skills.ts` | 复制 skills 到临时目录，替换路径引用 |
| `agents.ts` | 解析 YAML frontmatter，注册 agent |
| `prompts.ts` | 两级加载（项目 > 内置），提供 prompt 内容 |
| `bootstrap.ts` | 加载启动引导 system prompt |
| `goal.ts` | Goal 状态机 + continuation 管理 |

### 3. FlowRun 引擎 (`src/flowrun/`)

全自动流程编排核心，管理 GitHub Issue body 中的 JSON 状态机：

| 模块 | 职责 |
|------|------|
| `types.ts` | 类型系统：FlowRun/Stage/Task/Checkpoint |
| `github.ts` | Issue CRUD + 标签管理 + 乐观锁 |
| `gate.ts` | 阶段/任务准入准出检查 |
| `merge.ts` | PR 合并 + 分支保护 + 回滚 |
| `validator.ts` | JSON Schema 校验 |
| `resilience.ts` | 运行时检查 + 背压检测 |
| `audit.ts` | 审计评论发布 |

## 核心概念

### Goal（目标）

Goal 是 flow 状态的载体，存储在 session metadata 中：

```typescript
interface GoalData {
  objective: string          // 一句话目标
  completionCriterion: string // 完成标准
  status: "active" | "paused" | "complete"
  continuationCount: number   // 自动 continuation 次数
}
```

### FlowRun（流程运行）

FlowRun 是完整的流程状态机，存储在 GitHub Issue body 中：

```typescript
interface FlowRun {
  flowRunId: string
  repo: string
  parentIssueNumber: number
  status: "planned" | "running" | "blocked" | "merging" | "completed" | "cancelled"
  stages: Record<FlowStage, StageState>
  tasks: Record<string, TaskState>
  // ...
}
```

FlowRun 通过 JSON 块持久化在 Issue body 中：

```
<!-- cabbage-flow-run:start -->
```json
{ ... }
```
<!-- cabbage-flow-run:end -->
```

### Stage（阶段）

7 个有序阶段，每个有准入/准出条件：

```
requirements → design → tasks → code → test → review → merge
```

### Task（任务）

DAG 任务图，支持依赖关系和并行执行：

```typescript
interface TaskState {
  id: string
  dependsOn: string[]     // 依赖的任务 ID
  area: "backend" | "frontend" | "common"
  parallelSafe: boolean   // 是否可并行
  prNumber: number | null // 关联 PR
  // ...
}
```

## 事件驱动

插件通过 OpenCode 事件系统驱动自动工作流：

| 事件 | 处理 |
|------|------|
| `session.status (idle)` | 自动 continuation（最多 50 次） |
| `session.status (error)` | 错误恢复（重试 3→跳过 2→暂停） |
| `session.error` | 记录 abort session |
| `message.updated (user)` | 重置 continuation 计数 |
| `session.updated` | 清理已完成 session |

## 弹性设计

### 自动 continuation

Plugin 在 AI idle 时自动注入 continuation prompt：

```
Continue working toward the active goal.
<objective>...</objective>
<completion_criterion>...</completion_criterion>
```

每 20 次 continuation 自动 compact 会话历史。

### 错误恢复

```
错误次数 0-2: 重试（不同方法）
错误次数 3-4: 跳过（继续剩余工作）
错误次数 5+: 暂停，等待用户介入
```

### 自动恢复

插件重启时自动恢复上次未完成的 session：

```
[auto-resume] Plugin restarted. Resuming previous goal:
Goal: ...
Status: active
Continue working.
```

### 背压检测

每次操作前检查：

- GitHub API rate limit（< 100 则暂停）
- CI 队列长度（>= 10 则暂停）

### 乐观锁

FlowRun 写入时检测 Issue body 是否被其他进程修改，防止并发冲突。

## 安全性

- 子 agent 禁止调用 `goal({op:"create"|"pause"|"resume"|"cancel"})` — 生命周期操作限制在主 session
- 只有 `@goal-verify` 可以调用 `goal({op:"complete"})` — 防止过早完成
- Agent 工具权限由 frontmatter 控制（reviewer 只读，backend/frontend 读写）

## 依赖关系

```
@devcxl/opencode-cabbage
├── @opencode-ai/plugin ^1.3.7    # 插件框架
├── @opencode-ai/sdk ^1.17.14     # SDK v2 client
└── yaml ^2.8.3                   # YAML frontmatter 解析
```

外部依赖：
- `gh` CLI — GitHub 操作（Issues、PRs、CI、Releases）
- `npm` — 发布流程

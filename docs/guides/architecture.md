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
│  │  ┌──────┴─────────────────┴──────────────────┴───────┐ │  │
│  │  │            最小支撑模块（kernel/）                   │ │  │
│  │  │  context profile session-index permission          │ │  │
│  │  └───────────────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │           Agent 团队 (5 agents)                        │  │
│  │  @dev-lifecycle → @architect → @developer             │  │
│  │                    → @reviewer → @goal-verify          │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## 设计原则

> **内核保护高损失写操作，不管理开发方法论。**

- **流程编排交给模型**：阶段顺序、任务拆解、TDD、审查、合并决策由 agent + skill（Prompt）驱动
- **质量验证交给 CI**：测试通过与否由仓库 GitHub Actions workflow 判定
- **确定性内核只做**：goal 状态跟踪、Parent Issue 绑定、自动续接、Context 注入、goal-verify 授权

## 两层架构

### 1. 加载器层 (`src/plugin/`)

负责将 `assets/` 中的资源加载到 OpenCode 配置，并暴露 goal 工具：

| 加载器 | 职责 |
|--------|------|
| `server.ts` | 主工厂：注入 skills/commands/agents、注册 goal 工具、事件处理 |
| `goal.ts` | goal 工具：状态机 + goal-verify 授权 |
| `commands.ts` | 解析 markdown frontmatter，注册 7 个 slash command |
| `skills.ts` | 复制 skills 到固定目录 |
| `agents.ts` | 解析 YAML frontmatter，注册 agent |
| `prompts.ts` | 两级加载（项目 > 内置），提供 prompt 内容 |
| `bootstrap.ts` | 加载启动引导 system prompt |
| `shell.ts` | Agent shell 环境隔离 |
| `prompt-lint.ts` | Prompt 资产一致性检查 |

### 2. 最小支撑模块 (`src/kernel/`)

| 模块 | 职责 |
|------|------|
| `context.ts` | 根 CONTEXT.md 发现/摘要/mtime 缓存刷新 |
| `profile.ts` | AGENTS.md Project Profile 区块解析 |
| `session-index.ts` | parentIssue→session 轻量索引（goal 绑定 + 重启恢复） |
| `permission.ts` | OpenCode permission 匹配语义（最后匹配优先） |
| `mutex.ts` | 按键异步互斥（session-index 并发安全） |

## 核心概念

### Goal（唯一工具）

- 一个 **Flow** = 一个 GitHub Parent Issue，包含目标、验收标准与阶段 checklist（权威源）
- **goal 工具** 在每个会话存储 `{ parentIssueNumber, status, continuationCount, sessionProfile }`
- 目标/验收 **不** 存在 goal 里，从 Parent Issue body 读取（单一事实源）
- 状态机：`create → active ⇄ paused → complete（仅 goal-verify）`
- 进度从 GitHub 实时推导，不持久化 JSON 状态

### 阶段（Stage）

7 个阶段（stage-contract 契约）：

```
setup → requirements → design → tasks → code → review → release（手动）
```

- 阶段完成 = Parent Issue body checklist `- [x] <stage>`
- Release 是独立人工流程，不属于每个 Flow 的自动 Stage

### 权限模型

- **primary 编排器（dev-lifecycle）** 全权：直接执行 push/PR/merge 等高险命令
- **子 agent 只读/受限**：architect 只写 docs；developer 只在 worktree 内开发不 push；reviewer 只读；goal-verify 只读 + 测试（deny publish）
- 复用宿主 `gh auth`，不建设第二套凭据

### Project Context 注入

- 根 `CONTEXT.md` 是领域术语权威
- 插件在 Primary 会话与子 Agent 首消息自动注入内容与 digest（mtime 缓存刷新）
- 术语经用户确认后即时更新；Context 只保存领域语言，不承载实现细节

## 流程全貌

### Goal 状态机

```
                ┌─────────────────────┐
    create ────→│       active        │
                │  (会话绑定 Parent    │ ← idle 自动续接，continuationCount++
                │   Issue，驱动流程)   │
                └─────────┬───────────┘
          pause           │          cancel
      ┌───────────────────┼─────────────────────┐
      ▼                   │                     ▼
┌───────────┐    resume   │             （无状态，goal 移除）
│  paused   │─────────────┘
└───────────┘
                │
                │ complete（仅 goal-verify 可调，且 parent 必须 active）
                ▼
            ┌───────────┐
            │  complete │
            └───────────┘
```

状态转移约束：
- `create`：同一会话已有 active goal 时拒绝
- `pause`：仅 active → paused；`resume`：仅 paused → active（并重置续接计数）
- `cancel`：任意状态移除 goal
- `complete`：仅 `goal-verify` 子 agent 可调用（goal.ts 内置授权），且父会话 goal 必须 active

### 用户主流程（7 个阶段）

| 阶段 | 命令 | 流程 | 产出 |
|------|------|------|------|
| 初始化 | `/setup` | 探测 git/gh → 逐项确认 Profile → 写入根 AGENTS.md | Project Profile |
| 需求 | `/requirements` | 战争迷雾渐进澄清（一次一问）→ 凝固 PRD → gh issue create | PRD + **Parent Issue** |
| 设计 | `/design` | architect 出方案 + ADR → 分支 + PR 合入 | specs + ADR（设计基线） |
| 拆解 | `/tasks` | DAG 拆解（垂直切片）→ gh issue create 子任务 | Sub Issues |
| 编码 | `/code` | worktree + developer 按 flow-tdd 实现 + 本地 commit | 分支提交 |
| 审查 | `/review` | 双轴审查（规范+规格）→ gh pr review → CI 通过后 merge | 合并 PR |
| 发布 | `/release` | 版本提议 → release 分支 + 版本文件 → PR → 合并 + tag | GitHub Release |

- 阶段顺序与完成条件由 `stage-contract` 契约定义（单一来源）
- 阶段完成 = Parent Issue body checklist `- [x] <stage>`；requirements 完成需用户确认
- 设计基线（docs + ADR）合入后才能拆解任务
- Release 为人工流程，不属于自动 Stage

### dev-lifecycle 自动编排

需求确认后，`@dev-lifecycle` 一条命令跑完 `design → tasks → code → review`：

```
1. goal({op:"create", parent_issue_number}) → 读取 Parent Issue 目标
2. Phase 1: 委派 @architect 出方案 + ADR → 分支 + PR 合入（设计基线）
3. Phase 2: 委派 @architect 拆 DAG → gh issue create 建 Sub Issues
4. Phase 3: 按 DAG 拓扑分批并行：
   ├─ 每 task: git worktree add .worktree/<slug> -b feat/<slug>
   │   → 派 @developer 编码（flow-tdd RED→GREEN + 本地 commit，不 push）
   ├─ 编排器: git push + gh pr create（body 含 "Closes #<issue>"）
   ├─ 监听 GitHub Actions workflow 结果（gh run watch）确认测试通过
   ├─ 派 @reviewer 本地双轴审查 → gh pr review
   └─ CI + 审查通过 → gh pr merge --squash --match-head-commit
       → git worktree remove（脏目录提示人工处理）
5. Phase 4: 确认全部合并 → 派 @goal-verify 独立验证
6. goal-verify 验证通过 → goal({op:"complete"})
```

关键机制：
- 每次 idle 自动续接下一阶段（模型驱动，无内核门禁）
- 上下文压力大时自动写 `docs/dev/handoff-<date>.md`，恢复时先读它
- 高风险写命令（push/PR/merge）全部由 primary 编排器执行；子 agent 只读/本地开发
- 测试验证以 GitHub Actions workflow 结果为准（本地 TDD 仅 self-report）

### Agent 权限矩阵

| agent | bash | edit/write | 职责 |
|-------|------|-----------|------|
| `dev-lifecycle` | 全部 allow | 全权 | 编排一切（push/PR/merge/worktree） |
| `architect` | 只读查询 | 只写 docs/assets | 方案、ADR、DAG 拆解 |
| `developer` | 只读查询 | 全权（worktree 内） | TDD 实现 |
| `reviewer` | 只读查询 | 只读 | 双轴审查 |
| `goal-verify` | 查询 + 测试，deny publish | 只读 | 独立验证 + goal complete |

## 事件驱动

插件通过 OpenCode 事件系统驱动自动工作流：

| 事件 | 处理 |
|------|------|
| `session.status (idle)` | 自动 continuation（goal active 时注入续接 prompt） |
| `session.error` | 记录 abort session |
| `message.updated (user)` | 重置 continuation 计数 + 刷新 agent/model 快照 |

## 弹性设计

### 自动 continuation

Plugin 在 AI idle 时自动注入 continuation prompt（含 Project Context 摘要）：

```
Continue working toward the active goal.
Read the Flow Record (Parent Issue #<n>) for the objective and completion criteria.
```

- `continuationCount` 达上限（50）→ 自动 pause，请求用户介入
- 每 20 次 continuation 自动 compact 会话历史
- 用户消息重置计数

### 上下文管理（内化 handoff）

- 上下文压力大 → 自动写 `docs/dev/handoff-<date>.md`（阶段/已完成/待办/下一步）
- 会话恢复 → 先读最新 handoff 文件，结合 Parent Issue 状态继续

### 自动恢复

插件重启时通过 session-index 自动恢复上次未完成的 session：

```
[auto-resume] Plugin restarted. Resuming previous goal:
Flow #<number>
Status: active
Continue working.
```

## 安全性

- 只有 `@goal-verify` 可以 complete goal（goal.ts 内置授权）
- goal-verify 为只读验证 agent（bash deny publish）
- 子 agent 无高险写权限：developer 不 push、reviewer 只读、architect 只写 docs
- worktree 销毁前检查干净状态；脏目录不自动删除

## 依赖关系

```
@devcxl/opencode-cabbage
├── @opencode-ai/plugin    # 插件框架
├── @opencode-ai/sdk       # SDK v2 client
└── yaml                   # YAML frontmatter 解析
```

外部依赖：
- `gh` CLI — GitHub 操作（Issues、PRs、CI、Releases）
- 项目自身的 GitHub Actions release workflow — 实际发布（技术栈无关，不假设 npm）

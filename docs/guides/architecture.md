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
│  │  │  Injection   │  │  Handler    │  │  (5 生命周期) │ │  │
│  │  └──────┬───────┘  └──────┬──────┘  └───────┬───────┘ │  │
│  │         │                 │                  │         │  │
│  │  ┌──────┴─────────────────┴──────────────────┴───────┐ │  │
│  │  │            Thin Kernel（确定性薄内核）                │ │  │
│  │  │  slug  records worktree tdd review release          │ │  │
│  │  │  context profile session-index permission           │ │  │
│  │  └───────────────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │           Agent 团队 (5 agents + 1 goal-verify)       │  │
│  │  @dev-lifecycle → @architect → @developer             │  │
│  │                    → @reviewer → @goal-verify          │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## 三层架构

### 1. 基础设施层 (`src/`)

TypeScript 薄层，职责：

- **插件入口** (`index.ts`) — 导出 `{ id, server }`
- **包路径解析** (`plugin.ts`) — 解析 npm 包根路径
- **主工厂** (`plugin/server.ts`) — 创建 `Plugin` 接口，注入配置、注册事件、暴露工具

### 2. 加载器层 (`src/plugin/`)

负责将 `assets/` 中的资源加载到 OpenCode 配置：

| 加载器 | 职责 |
|--------|------|
| `commands.ts` | 解析 markdown frontmatter，注册 7 个 slash command |
| `skills.ts` | 复制 skills 到固定目录，替换路径引用 |
| `agents.ts` | 解析 YAML frontmatter，注册 agent |
| `prompts.ts` | 两级加载（项目 > 内置），提供 prompt 内容 |
| `bootstrap.ts` | 加载启动引导 system prompt |
| `goal.ts` | 最小 Goal 状态机（parentIssueNumber/status/continuationCount）+ continuation 管理 |

### 3. Thin Kernel（确定性薄内核，`src/kernel/`）

对模型不应自由决定的高风险流程规则实施确定性约束（ADR 0002）：

| 模块 | 职责 |
|------|------|
| `slug.ts` | Functional Slug 派生与校验（拒绝泛化名/非法格式） |
| `records.ts` | Flow/Task Record CRUD（GitHub Issues 权威源）+ evidence 受控 comment |
| `worktree.ts` | worktree 生命周期（创建/复用校验/销毁 preflight，无 --force） |
| `tdd/` | Runtime TDD 纯函数（state/adapter/digest/evaluator/evidence） |
| `review.ts` | 审查与合并门禁（CI/分支保护/风险双层/非作者 approval） |
| `release.ts` | 版本聚合/分类/提议 + tag 不可变校验（技术栈无关） |
| `context.ts` | 根 CONTEXT.md 发现/摘要/mtime 缓存刷新 |
| `profile.ts` | AGENTS.md Project Profile 区块解析 |
| `session-index.ts` | parentIssue→session 轻量索引 + 双 session 拒绝/takeover |
| `caller.ts` | 工具调用者校验原语（角色矩阵 + op 覆盖） |
| `permission.ts` | OpenCode permission 匹配语义（最后匹配优先、deny 置尾） |
| `legacy.ts` | 旧 FlowRun cabinet 检测（不迁移只提示） |

## 核心概念

### Flow / Task Record（GitHub 权威源）

- 一个 **Flow** = 一个 GitHub Parent Issue（Flow Record），包含目标、验收摘要与阶段 checklist
- 一个 **Task** = 一个 GitHub Sub Issue（Task Record），包含验收标准、依赖、TDD 上下文块
- PR 关联 Sub Issue，CI Checks 关联 PR；三者共同构成工程进度权威事实
- **不持久化** FlowRun cabinet 或其他 JSON 状态——进度从 GitHub 实时推导

### 5 个生命周期工具

| 工具 | 职责 |
|------|------|
| `setup_control` | 探测/校验（development-ready / release-ready）/ 生成 workflow 草案 / 确认 Profile |
| `flow_control` | Flow 生命周期（create/status/planning/stage/complete/cancel/takeover）+ legacy 检测 |
| `task_control` | Task 生命周期（create/start/submit/submit-review/merge/cancel/destroy/status） |
| `tdd_checkpoint` | Runtime TDD 证据（RED/GREEN/回归，工具亲执，缺证据拒 PR） |
| `release_control` | 版本提议 / Release PR / 合并打 tag / workflow 监控 |

### Stage（阶段）

5 个逻辑阶段，每个有明确目标与完成条件：

```
requirements → design → tasks → code → review
```

Release 是独立人工流程，不属于每个 Flow 的 Stage。

### 权限模型

- 高风险 git/gh 写操作（worktree 创建/销毁、push、PR、merge、Issue 关闭）只走生命周期工具
- 模型可直接执行只读 git/gh 与本地 edit/add/commit
- Agent permission：allow 只读白名单 + deny 写操作置尾（最后匹配优先）
- 工具内 caller 校验（角色矩阵）+ config 层工具布尔双重门禁
- 复用宿主 `gh auth`，不建设第二套凭据

### Project Context 注入

- 根 `CONTEXT.md` 是领域术语权威
- 插件在 Primary 会话与子 Agent 首消息自动注入内容与 digest（mtime 缓存刷新）
- 术语经用户确认后即时更新；Context 只保存领域语言，不承载实现细节

## 事件驱动

插件通过 OpenCode 事件系统驱动自动工作流：

| 事件 | 处理 |
|------|------|
| `session.status (idle)` | 自动 continuation（进度驱动：有进展继续，停滞 3 次暂停） |
| `session.status (error)` | 错误恢复（工具级瞬时重试，无 generic skip） |
| `session.error` | 记录 abort session |
| `message.updated (user)` | 重置 continuation 计数 |
| `session.updated` | 清理已完成 session |

## 弹性设计

### 自动 continuation

Plugin 在 AI idle 时自动注入 continuation prompt（含 Project Context 摘要）：

```
Continue working toward the active goal.
<objective>...</objective>
<completion_criterion>...</completion_criterion>
```

每 20 次 continuation 自动 compact 会话历史。

### 错误恢复

- Task 失败自动重试最多 3 次，仍失败标记 blocked 并停止下游；其他独立 Tasks 继续
- Review 自动修复最多 3 轮
- 连续 3 次 continuation 无可验证进展才暂停请求人工介入

### 自动恢复

插件重启时通过 session-index 自动恢复上次未完成的 session：

```
[auto-resume] Plugin restarted. Resuming previous goal:
Flow #<number>
Status: active
Continue working.
```

## 安全性

- 子 agent 禁止调用 Flow 生命周期写操作（caller 矩阵：developer 仅 tdd_checkpoint、architect 仅 status 只读、reviewer 无工具）
- 只有 `@goal-verify` 可以完成 Flow（`flow_control{complete-flow}`）
- TDD 硬门禁：缺 evidence 的 PR 被拒绝创建
- 合并门禁：CI checks + 分支保护 + 风险双层判定（只升不降）+ 高风险需非作者人类 approval
- worktree 销毁 preflight：PR 合并 + 干净才自动；脏目录拒绝；无 `--force`

## 依赖关系

```
@devcxl/opencode-cabbage
├── @opencode-ai/plugin ^1.3.7    # 插件框架
├── @opencode-ai/sdk ^1.17.14     # SDK v2 client
└── yaml ^2.8.3                   # YAML frontmatter 解析
```

外部依赖：
- `gh` CLI — GitHub 操作（Issues、PRs、CI、Releases）
- 项目自身的 GitHub Actions release workflow — 实际发布（技术栈无关，不假设 npm）

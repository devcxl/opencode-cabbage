# 架构概览

本文档介绍 opencode-cabbage 的核心架构设计。

> **兼容性：**2.0.0 起插件入口使用 `@opencode/plugin` 2.x（OpenCode v2 插件 API），基于 `Plugin.define` setup、域 transform 与轮次结束事件驱动的自动续接，已在 OpenCode v2.0.28 端到端实测。OpenCode v1 使用 1.x 版本线。

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
│  │           Agent 团队 (6 agents)                        │  │
│  │  @dev-lifecycle → @architect → @developer             │  │
│  │     → @reviewer → @researcher → @goal-verify          │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

## 设计原则

> **内核保护高损失写操作，不管理开发方法论。**

- **流程编排交给模型**：阶段顺序、任务拆解、TDD、审查、合并决策由 agent + skill（Prompt）驱动
- **质量验证交给 CI**：测试通过与否由仓库 GitHub Actions workflow 判定
- **确定性内核只做**：goal 状态跟踪、Parent Issue 绑定、自动续接、Context 注入、goal-verify 授权、
  内置 Cabbage 引擎的释放与变更记录工具（tasks/文档/门禁/归档）

## 两层架构

### 1. 加载器层 (`src/plugin/`)

负责将 `assets/` 中的资源加载到 OpenCode 配置，并暴露 goal 与 cabbage 工具：

| 加载器 | 职责 |
|--------|------|
| `server.ts` | 主工厂：注入 skills/commands/agents、注册 goal 与 cabbage 工具、事件处理 |
| `goal.ts` | goal 工具：状态机 + goal-verify 授权 |
| `cabbage-cli.ts` | 释放捆绑的 Cabbage 引擎（按插件版本隔离）、python 探测与子进程执行 |
| `cabbage-tool.ts` | `cabbage` 工具：变更记录 op 映射与 agent 门控（仅 dev-lifecycle） |
| `install-dir.ts` | 版本化目录安装（锁 + 完整性校验），skills 与引擎共用 |
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
- **goal 工具** 在每个会话存储 `{ parentIssueNumber, status, continuationCount, sessionProfile, tokenBudget, tokensUsed, tokensBaseline, createdAt, statusReason }`
- 目标/验收 **不** 存在 goal 里，从 Parent Issue body 读取（单一事实源）
- 状态机：`create → active ⇄ paused → complete（仅 goal-verify）`；paused 还有三个自动入口：`[BLOCKED:]` 报告、`[DONE:]` 完成报告、token 预算达限
- 进度从 GitHub 实时推导，不持久化 JSON 状态
- create 支持可选 `token_budget`：达限自动 pause（预算护栏，防长跑成本失控）；记账用快照法（最新完成 assistant 轮的 input+reasoning+cache.read+output − 创建时基线，单调不减）
- `edit` op：修改 tokenBudget（传 0 移除）或更换 parentIssueNumber（换 Flow，重置记账 + 索引 rebind）；active/paused 可编辑，complete 只读；budget 达限 paused 后可先 edit 提预算再 resume

### 阶段（Stage）

7 个阶段（契约内嵌在 `@dev-lifecycle` prompt）：

```
setup → requirements → design → tasks → code → review → release（手动）
```

- 阶段完成 = Parent Issue body checklist `- [x] <stage>`
- Release 是独立人工流程，不属于每个 Flow 的自动 Stage

### 权限模型

- **primary 编排器（dev-lifecycle）** 全权：直接执行 push/PR/merge 等高险命令
- **子 agent 只读/受限**：architect 只写 docs；developer 只在 worktree 内开发不 push；reviewer 只读；goal-verify 只读 + 测试（deny publish）
- **子 agent 技能隔离**：`permission.skill` 默认 `deny` 全部 skill，仅放行各自归属技能（architect→design/tasks；developer→code/tdd；reviewer→review；researcher→research；goal-verify 无）
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
                │  (会话绑定 Parent    │ ← 每轮执行结束自动续接，continuationCount++
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
- `create`：同一会话已有 active goal 时拒绝；`token_budget` 为正整数
- `pause`：仅 active → paused；`resume`：仅 paused → active（并重置续接计数，`statusReason='resumed'` 作为 kickoff 信号）
- `cancel`：任意状态移除 goal；`edit`：active/paused 可编辑，complete 只读，子 agent 禁编辑
- `complete`：仅 `goal-verify` 子 agent 可调用（goal.ts 内置授权），且父会话 goal 必须 active
- 自动暂停（非用户触发）：`[BLOCKED:]` 报告（agent 无法推进）→ paused；`[DONE:]` 完成报告（agent 验证通过，等待独立 goal-verify）→ paused；token 预算达限 → paused

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

- 阶段顺序与完成条件由 `@dev-lifecycle` prompt 的《阶段契约》章节定义（单一来源）
- 阶段完成 = Parent Issue body checklist `- [x] <stage>`；requirements 完成需用户确认
- 设计基线（docs + ADR）合入后才能拆解任务
- Release 为人工流程，不属于自动 Stage

### dev-lifecycle 自动编排

`@dev-lifecycle` 先做 **Phase 0 场景分诊**，按输入选择路径（功能流或轻量路径，路由表见 `assets/agents/dev-lifecycle.md`），再按路径编排；功能流一条命令跑完 `design → tasks → code → review`：

```
0. Phase 0: 场景分诊 → 功能流继续下方；非功能路径（修复/hotfix/业务调整/重构/技术债/基础设施/文档/回滚/调研）按轻量路径执行
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

调研等非功能场景：派发 `@researcher` 加载 `flow-research` 产出 `docs/dev/research/<topic>.md`；
异常处理在重试后先派发 `@deep-think`（更强模型）系统审视，再 Pause 求助。
```

关键机制：
- 每轮执行结束（`session.execution.succeeded`）自动续接下一阶段（模型驱动，无内核门禁）
- 上下文压力大时自动写 `docs/dev/handoff-<date>.md`，恢复时先读它
- 高风险写命令（push/PR/merge）全部由 primary 编排器执行；子 agent 只读/本地开发
- 测试验证以 GitHub Actions workflow 结果为准（本地 TDD 仅 self-report）

### Agent 权限矩阵

| agent | bash | edit/write | 技能(skill) | 职责 |
|-------|------|-----------|------|------|
| `dev-lifecycle` | 全部 allow | 全权 | 全部 | 编排一切（push/PR/merge/worktree） |
| `architect` | 只读查询 | 只写 docs/assets | flow-design, flow-tasks | 方案、ADR、DAG 拆解 |
| `developer` | 只读查询 | 全权（worktree 内） | flow-code, flow-tdd | TDD 实现 |
| `reviewer` | 只读查询 | 只读 | flow-review | 双轴审查 |
| `researcher` | 只读 + 网络读取(curl) | 只写 docs/dev/research | flow-research | 调研、事实核查 |
| `goal-verify` | 查询 + 测试，deny publish | 只读 | 无 | 独立验证 + goal complete |

## 事件驱动

插件通过 OpenCode v2 事件系统（`ctx.event.subscribe`）驱动自动工作流：

| 事件 | 处理 |
|------|------|
| `session.execution.succeeded` | 轮次结束 → 自动 continuation（goal active 时注入续接 prompt；子会话 busy、尾部非静默、`[BLOCKED:]` 报告、预算达限均跳过/暂停） |
| `session.execution.interrupted` | `reason=user` → 记录中断并立即持久化 paused；其他原因仅更新活动跟踪 |
| `session.execution.failed` / `session.retry.scheduled` | 活动跟踪（失败不自动续接，避免错误空转） |
| `session.inbox.enqueued (item.type=user)` | 重置 continuation 计数 + 清除中断标记 + 刷新 agent/model 快照 |
| `session.agent.selected` / `session.model.selected` | 刷新 goal 的会话配置快照 |
| `session.created` | 记录父子会话关系（子会话活动闸的事件溯源） |

## 弹性设计

### 自动 continuation

Plugin 在每轮执行结束（`session.execution.succeeded`）时自动注入 continuation prompt（含 Project Context 摘要）：

```
Continue working toward the active goal.
Read the Flow Record (Parent Issue #<n>) for the objective and completion criteria.
```

续接前五道闸（queueContinuation）：

1. **子会话活动闸**：直接子会话（后台 subagent）busy/retry 时跳过——父会话轮次结束不代表任务静默，续接会压过子代理结果注入。V2 无 children 查询 API，改用事件溯源（`session.created` 建关系 + `execution.*` 更新 busy 状态）；重启后内存清空，短暂窗口内可能漏判（可接受降级）
2. **尾部静默检查**：最后一条是 user/synthetic 消息或 assistant 未完成 → 跳过（等这些消息各自触发的新轮次结束事件）
3. **`[BLOCKED:]`/`[DONE:]` 信号报告**：agent 明确无法推进 → 置 paused；agent 完成验证并报告 → 置 paused 等待 goal-verify 独立验证（防空转烧 token 与漏验）；resume 后首次 tick 豁免（防 resume 死路）
4. **token 预算护栏**：`tokensUsed >= tokenBudget` → 置 paused（用户可 edit 提预算后 resume）
5. **续接上限**：`continuationCount` 达 50 → 置 paused，请求用户介入

- 每 20 次 continuation 调用 `session.compact` 原生压缩会话历史
- 用户消息重置计数；显式 `resume` 清除用户中断标记
- **先写后发**：计数先于 synthetic 落盘（崩溃窗口只会少发一次续接，不会因重启 autoResume 双发）；发送失败回滚计数
- **重启双发防护**：autoResume 跳过 30s 内更新过续接的 flow（可能刚续接过），等下一次轮次结束事件常规续接
- **token 记账（会话累计快照）**：create 时记录会话累计 tokens 为基线，`tokensUsed = 当前累计 − 基线`，单调不减；预算为护栏而非账单

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
- 子 agent 技能隔离：`permission.skill` deny 非归属 skill，防越权加载与上下文污染
- worktree 销毁前检查干净状态；脏目录不自动删除

## 依赖关系

```
@devcxl/opencode-cabbage
├── @opencode/plugin       # OpenCode v2 插件框架（Plugin.define / 域 transform / 事件）
└── yaml                   # YAML frontmatter 解析
```

外部依赖：
- `gh` CLI — GitHub 操作（Issues、PRs、CI、Releases）
- 项目自身的 GitHub Actions release workflow — 实际发布（技术栈无关，不假设 npm）

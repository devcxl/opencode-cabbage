# 提示词 Contract-first 重构 — 技术方案

## 1. 概述

对 opencode-cabbage 全量提示词资产进行 Contract-first 重构：修复 10 项 P0 阻断问题，为 9 个 Skill 建立统一 Stage Contract，引入 Task Manifest、Agent 能力矩阵、环境探测和 Prompt 静态 Lint，并完成 FlowRun 接入 Spike。

## 2. 架构

### 2.1 三层改造范围

```
┌─────────────────────────────────────────┐
│  改造层 3：测试基础设施（新增）            │
│  prompt-lint.ts  →  引用完整性 / 能力一致性│
│  scenarios/      →  (后续增强)            │
├─────────────────────────────────────────┤
│  改造层 2：Prompt 资产（合同化）           │
│  9 Skills → Stage Contract                │
│  3 Prompts → _prompts/ 目录               │
│  CONTEXT.md → _context/                   │
│  3 Agents → capabilities 字段             │
│  Task Manifest → manifest.yaml            │
├─────────────────────────────────────────┤
│  改造层 1：Plugin Runtime（P0 修复）      │
│  goal.ts      → Agent 身份校验            │
│  server.ts    → Bootstrap 条件注入        │
│  agents.ts    → capabilities 解析         │
│  prompts.ts   → _prompts/ 写入 skillsDir  │
└─────────────────────────────────────────┘
```

### 2.2 改造不涉及的部分

- `src/flowrun/` — 本轮只做 Spike，不接入 server.ts
- `src/flowrun/merge.ts`、`gate.ts` — 不修改
- `docs/` 非 Prompt 资产（guides、index） — 不修改
- CI workflow、VitePress 配置 — 不修改
- 外部依赖版本 — 不变更

## 3. 数据模型

### 3.1 Stage Contract

每个 Skill 的 Markdown 追加固定段落：

```markdown
## Trigger
由 `/xxx` 命令或 `@dev-lifecycle` Phase N 触发。

## Inputs
- `{issue-number}` — Parent Issue 编号（来源：Goal metadata）
- `{title}` — 功能标题（来源：PRD 文件名）
- `{task-slug}` — 当前任务标识（来源：Task Manifest）

## Preconditions
- `/xxx` 已完成 → `docs/path/file.md` 存在
- gh CLI 已认证

## Procedure
1. ...
2. ...

## Outputs
- `docs/path/file.md` — 输出物描述
- GitHub Issue #N — 关联 Issue

## Failure
- 如果 X 失败 → 记录原因，暂停并通知用户
- 如果 Y 失败 → 重试 1 次后跳过

## Idempotency
- 如果 docs/path/file.md 已存在 → 读取而非重建
- 如果 Issue 已创建 → 更新而非重复创建

## Prohibited Actions
- 不直接 push 到默认分支
- 不使用 git add .
- 不创建与任务无关的文件
```

### 3.2 Task Manifest (`manifest.yaml`)

```yaml
# docs/dev/tasks/{feature-slug}/manifest.yaml
feature: prompt-contract-first-refactor
parent_issue: 48
base_branch: main        # 运行时探测后注入
tasks:
  - id: pr1-role-goal
    title: "角色权限与 Goal 门禁修复"
    depends_on: []
    agent: backend
    capability: modify_files
    estimated_hours: 4
    worktree: ".worktree/pr1-role-goal/"
    branch: "feat/pr1-role-goal"
    expected_files:
      - "src/plugin/goal.ts"
      - "assets/agents/team/reviewer.md"
      - "assets/agents/team/backend.md"
      - "assets/agents/dev-lifecycle.md"
    verify_commands:
      - "npm test -- test/goal.test.ts"
      - "npm run typecheck"
    acceptance: |
      - 只有 goal-verify 可完成 Goal
      - Reviewer Prompt 无 goal complete 指令
      - Worker Prompt 无 gh pr create 指令

  - id: pr2-templates-refs
    title: "模板与引用修复"
    depends_on: [pr1-role-goal]
    ...

  - id: pr3-worktree-safety
    title: "Worktree 安全修复"
    depends_on: [pr2-templates-refs]
    ...

  - id: pr4-git-safety
    title: "Git/GitHub 安全修复"
    depends_on: [pr1-role-goal]
    ...

  - id: pr5-flowrun-spike
    title: "FlowRun 接入 Spike"
    depends_on: [pr1-role-goal]
    ...
```

### 3.3 Agent 能力矩阵

```yaml
# assets/agents/<agent>.md — frontmatter 新增
capabilities:
  create_pr: false
  merge_pr: false
  modify_files: true
  run_tests: true
  push_branch: true
  approve_review: false
  complete_goal: false
```

| Agent | create_pr | merge_pr | modify_files | push_branch | complete_goal |
|-------|:---:|:---:|:---:|:---:|:---:|
| dev-lifecycle | true | true | true | true | false |
| architect | false | false | true | true | false |
| backend | false | false | true | true | false |
| frontend | false | false | true | true | false |
| reviewer | false | false | false | false | false |
| goal-verify | false | false | false | false | true |

### 3.4 环境探测结果

运行时探测结果以 Context 形式注入 Skill：

```markdown
## Runtime Context
- **default_branch**: main
- **package_manager**: npm
- **test_command**: npm test
- **typecheck_command**: npm run typecheck
- **build_command**: npm run build
- **tech_stack**: typescript
- **ci_required_checks**: typecheck, test, build
```

## 4. 关键流程变更

### 4.1 Goal 身份校验

```
goal({op:"complete"})
  → 非 subagent → BLOCKED
  → subagent 且 agent !== "goal-verify" → BLOCKED "Only goal-verify can complete"
  → subagent 且 agent === "goal-verify" → 允许
```

### 4.2 Bootstrap 条件注入

```
chat.message hook:
  if (是 Flow 命令) → 注入 Stage 上下文
  else if (存在 Active Goal) → 注入 Goal 摘要 + 下一步
  else → 不注入
```

### 4.3 Worktree Preflight

```
创建: git worktree add -b "feat/{slug}" ".worktree/{slug}" "{baseBranch}"
清理前:
  1. gh pr view {num} --json merged → 确认已合并
  2. git ls-remote origin feat/{slug} → 确认已推送
  3. git -C .worktree/{slug} status --porcelain → 确认干净
  4. 全部通过 → git worktree remove .worktree/{slug}
```

### 4.4 文档 Planning PR 流程

```
设计/任务文档 → git add docs/{prd,adr,dev/specs,dev/tasks}/
              → git commit → git push origin chore/plan-{feature}
              → gh pr create → 审查 → Merge → 从 main 创建 Task Worktree
```

## 5. Prompt Lint 设计

纯 TypeScript 脚本（`src/plugin/prompt-lint.ts`），零外部依赖：

```typescript
// 检查项
1. 引用完整性 — 扫描所有 .md 中相对路径，验证目标文件存在
2. 能力一致性 — 交叉比对 capabilities 与 permission 字段
3. 硬编码检测 — 搜索 git push origin main/master/dev, git add ., --force
4. Contract 完整性 — 检查每个 SKILL.md 是否包含 8 个必需段落
5. 冲突检测 — gh pr create 只存在于 orchestrator prompt
```

纳入 CI：`npm run prompt-lint` → Vitest 调用 lint 函数 → 失败阻断合并。

## 6. ADR 兼容性检查

### 6.1 ADR 0001（全流程架构）

**兼容**。本次改造不改变全流程阶段顺序（requirements → design → tasks → code → test → review），只增强每个阶段的输出确定性和安全性。

### 6.2 ADR 0004（文档同步与任务目录组织）

**兼容**。Task Manifest 遵循 `YYYY-MM-DD-NNN-slug/` 目录格式，Manifest 文件存放在同一目录下。Changelog 机制不变。

### 6.3 ADR 0005（Worktree 并行开发）

**兼容**。Worktree 创建改为 `-b` 参数，清理增加 Preflight。分支命名和目录结构不变。串行 Task 复用策略 Option A 保留。

## 7. PR 分解与执行顺序

```
pr1-role-goal ──────────────────────────────────────────────────────┐
     │                                                               │
     ├──► pr2-templates-refs ──► pr3-worktree-safety                 │
     │                                                               │
     ├──► pr4-git-safety ────────────────────────────────────────────┤
     │                                                               │
     └──► pr5-flowrun-spike                                          │
                                                                     │
     pr3/pr4/pr5 结束后 ──► pr6-contracts-stage1    (requirements/design/tasks)  │
                        ──► pr7-contracts-stage2    (code/test/review/release/handoff)
                        ──► pr8-prompt-lint
                        ──► pr9-docs-sync
```

| Batch | PR | 内容 | 依赖 |
|-------|-----|------|------|
| 1 | PR1 | 角色/权限/Goal 修复 | 无 |
| 1 | PR4 | Git/GitHub 安全修复 | 无（仅 Prompt，与 PR1 无代码冲突） |
| 1 | PR5 | FlowRun Spike | 无 |
| 2 | PR2 | 模板/引用修复 | PR1 |
| 2 | PR3 | Worktree 安全修复 | PR2 |
| 3 | PR6 | Contract 迁移阶段 1（req/design/tasks） | PR3, PR4 |
| 3 | PR7 | Contract 迁移阶段 2（code/test/review/release/handoff） | PR3, PR4 |
| 4 | PR8 | Prompt Lint + CI 集成 | PR6, PR7 |
| 4 | PR9 | 文档同步 | PR8 |

## 8. 风险与对策

| 风险 | 概率 | 影响 | 对策 |
|------|:---:|------|------|
| ToolContext.agent 未暴露 | 中 | Goal 身份校验只能用 Prompt 层 | 先做 Prompt + assertion，API 支持后补代码校验 |
| capabilities 字段不被 OpenCode 解析 | 低 | Frontmatter 未知字段被路由到 options | 从 options 读取，不做 Schema 要求 |
| 环境探测命令依赖 gh/jq 未安装 | 低 | 探测失败阻塞流程 | 增加 graceful fallback，探测失败不阻塞，使用默认值 |
| 大量 Prompt 重写引入漂移 | 中 | 回归 | 每 PR ≤10 文件，独立审查，Lint 自动检测 |

## 9. 技术选型

| 决策 | 选择 | 理由 |
|------|------|------|
| Stage Contract 格式 | 约定式 Markdown | 零解析器，模型+人均可读 |
| Task 依赖源 | manifest.yaml | 单源，Mermaid/表格自动生成 |
| Agent 能力表达 | Frontmatter capabilities | 与 permission 共处，交叉验证 |
| 环境探测 | Runtime bash + Prompt 注入 | 不增加代码层 |
| Prompt 测试 | 静态 Lint（本轮） | 零 API 成本，纳入 CI |
| Bootstrap | 三层条件注入 | 不污染普通会话 |
| Planning 文档 | 通过 PR 合入 | 遵循 Branch Protection |

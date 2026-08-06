---
name: flow-code
description: 编码实现 — worktree + TDD（flow-tdd 协议）
---

# flow-code

认领 Task Record（Sub Issue），在 worktree 内按 TDD 实现代码与单测。
worktree 创建、PR 提交由 primary 编排器执行，本 skill 定义编码流程。

## 核心流程

1. **创建/复用 worktree**（编排器执行）
   ```bash
   BASE=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
   git worktree add ".worktree/<task-slug>" -b "feat/<task-slug>" "$BASE"
   cd ".worktree/<task-slug>" && pwd
   ```
2. 加载 `flow-tdd` skill，按 Task 的验收标准执行 RED→GREEN cycle（self-report）
3. 本地 `git add`（限定文件）+ `git commit`（多次提交）
4. **不 push、不创建 PR** — 由 primary 编排器统一执行

## 编码约束

- 只改 Task 相关的文件；遵循项目现有代码规范与分层结构
- 遵循工程原则（KISS/YAGNI/DRY/SRP/最小变更，单份引用仓库 AGENTS.md）
- 文档同步：涉及 guides/api/db 变更时随代码同 PR 更新

## TDD 引用

> `flow-tdd` skill 是 TDD 协议的唯一来源，包含完整的 RED→GREEN cycle 状态机、
> abandon-cycle 规则和 final-regression/verification 流程。测试质量由仓库 CI 把关。

## Output
- 本地 commit 就绪（分支推送与 PR 由编排器完成）

## 后续
- **/review** — 审查 PR

## Contract

### Trigger
由 `/code` 命令或 `@dev-lifecycle` Phase 3 触发。

### Inputs
- Task Record（Sub Issue 编号与标题，来源：`/tasks` 产出）

### Preconditions
- `/tasks` 已完成 → Sub Issues 就绪
- 设计基线已合入；前置依赖任务已合并

### Procedure
1. 在 `.worktree/<task-slug>` 创建/复用 worktree（编排器执行）
2. 加载 `flow-tdd`，按 Task 验收标准执行 RED→GREEN cycle
3. 本地 git add + commit（不 push）
4. 交回 primary 编排器 push + 创建 PR

### Outputs
- 本地 commit

### Failure
- worktree 创建失败 → 检查分支冲突或目录残留
- 测试失败 → 修复后重试（不跳过 RED）

### Idempotency
- worktree 已存在 → 校验分支一致性后复用
- 代码已提交 → 追加提交

### Prohibited Actions
- 不 push、不创建 PR、不操作 Issue（由编排器统一执行）
- 不使用 `git add .`（限定变更文件）

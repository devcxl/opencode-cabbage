---
name: flow-code
description: 编码实现 — task_control 创建 worktree + TDD（flow-tdd 协议）
---

# flow-code

认领 Task Record（Sub Issue），在 worktree 内按 TDD 实现代码与单测。
worktree 创建、PR 提交由内核工具 `task_control` 完成，本 skill 不复制 shell 实现。

## 核心：调用 task_control + flow-tdd

1. `task_control{op:"start-task", task_id:"<slug>", ...}` — 创建 worktree + 记录基线 + 冻结 TDD policy
2. 加载 `flow-tdd` skill，按 Task 的 `tdd` 配置执行 RED→GREEN cycle
3. 每个 stage 通过 `tdd_checkpoint` 提交证据（唯一证据源，缺证据的 PR 会被拒绝）
4. 本地 `git add` + `git commit`（多次提交）
5. **不 push、不创建 PR** — 由 primary 的 `task_control{op:"submit-task"}` 完成

## 编码约束

- 只改 Task 相关的文件；遵循项目现有代码规范与分层结构
- 遵循工程原则（KISS/YAGNI/DRY/SRP/最小变更，单份引用仓库 AGENTS.md）
- 文档同步：涉及 guides/api/db 变更时随代码同 PR 更新

## TDD 引用

> `flow-tdd` skill 是 TDD 协议的唯一来源，包含完整的 RED→GREEN cycle 状态机、
> abandon-cycle 规则和 final-regression/verification 流程，以及 `tdd_checkpoint` 各 op 的调用方式。

## Output
- Worktree 已创建（task_control）
- TDD evidence 已提交（tdd_checkpoint）
- 本地 commit 就绪（分支推送与 PR 由 task_control 完成）

## 后续
- **/review** — 审查 PR

## Contract

### Trigger
由 `/code` 命令或 `@dev-lifecycle` Phase 3 触发。

### Inputs
- Task Record（Sub Issue 编号与标题，来源：`/tasks` 产出）

### Preconditions
- `/tasks` 已完成 → Sub Issues 就绪
- Planning Baseline 已合入；前置依赖任务已合并（task_control 门禁）

### Procedure
1. 调用 `task_control{op:"start-task"}` 创建/复用 worktree
2. 加载 `flow-tdd`，按 Task 的 tdd 配置执行 RED→GREEN cycle
3. 通过 `tdd_checkpoint` 提交证据
4. 本地 git add + commit（不 push）
5. 交回 primary 调用 `task_control{op:"submit-task"}` 创建 PR

### Outputs
- Worktree 已创建（`.worktree/<task-slug>/`）
- TDD evidence（Task Record 单评论）
- 本地 commit

### Failure
- worktree 创建失败 → 检查分支冲突或目录残留（task_control 报错）
- 测试失败 → 修复后重试（不跳过 RED）

### Idempotency
- worktree 已存在 → task_control 校验分支一致性后复用
- 代码已提交 → 追加提交

### Prohibited Actions
- 不 push、不创建 PR、不操作 Issue（由 task_control 完成）
- 不使用 `git add .`
- 不绕过 task_control 直接执行 worktree 创建 / PR 创建 / 分支推送

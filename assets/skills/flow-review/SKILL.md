---
name: flow-review
description: 双轴审查（规范 + 规格）→ task_control submit-review / merge-task
---

# flow-review

沿两条轴线审查 PR 代码：规范（是否符合编码标准）和规格（是否实现了原始需求）。
审查结果由 primary 通过 `task_control` 提交与合并，reviewer 本身只读。

## 核心：调用 task_control

1. `task_control{op:"submit-review", pr_number, verdict:"approve"|"request-changes", ...}` — 发布审查结果
2. `task_control{op:"merge-task", pr_number, ...}` — 合并（CI + 分支保护 + 风险分级 + 高风险人类 approval）
3. `task_control{op:"status-task", task_id}` — 查看 Task/PR 状态

reviewer 只读：不直接 `gh pr review` / `gh pr merge`（写操作由 primary 经 task_control 执行）。

## 双轴审查

**规范轴（Normative）** — 代码是否符合文档化的编码标准？
参考 `references/smell-baseline.md` 中的代码气味基线。

**规格轴（Specification）** — 代码是否忠实实现了需求？
对照 PRD（`docs/prd/`）和设计方案（`docs/dev/specs/`）验证。
- 如发现实现与设计偏差 → 追加到 changelog

**TDD Criterion Coverage** — 检查 Task 的 `acceptance_criteria` 是否被 PR 覆盖：
- 对照 Task frontmatter 中的 `acceptance` 数组，逐条核查
- 检查 PR 是否包含每条 criterion 对应的测试或验证
- 检查 `tdd` 配置块中的 `mode` 和 `min_cycles` 是否被遵循
- **明确不检查 commit order** — RED→GREEN 顺序是编码过程约束，reviewer 不审查 commit 历史

## 审查材料获取

代码审查必须在本地分支/worktree 中进行，禁止通过 WebFetch 或浏览器访问远程 PR 页面获取代码。

## Output
- 结构化审查报告（APPROVED / CHANGES_REQUESTED）
- PR 已合并（task_control merge-task，条件满足时）
- Worktree 已清理（task_control merge-task 后 preflight 销毁）

## 后续
- **/release** — 发布（如所有 PR 已合并）

## Contract

### Trigger
由 `/review` 命令或 `@dev-lifecycle` Phase 3 审查步骤触发。

### Inputs
- PR 编号与 Task Record（来源：`/code` 产出）

### Preconditions
- `/code` 已完成 → PR 已创建

### Procedure
1. 在本地 worktree/分支获取 PR diff 与元数据
2. 双轴审查（规范轴 + 规格轴）+ TDD criterion coverage
3. 输出结构化审查报告
4. primary 调用 `task_control{op:"submit-review"}` 发布结果
5. CI 通过后 `task_control{op:"merge-task"}` 合并（工具执行清理）

### Outputs
- 结构化审查报告（APPROVED / CHANGES_REQUESTED）
- PR 已合并（条件满足时）
- Worktree 已清理

### Failure
- Critical/High → request-changes
- Worktree 清理失败 → 记录警告，不阻塞

### Idempotency
- 已合并的 PR → 跳过
- 已审查的 PR → 更新结论

### Prohibited Actions
- **禁止使用 WebFetch 或任何 Web 工具获取远程 PR 代码** — 审查代码时必须本地读取源码文件
- reviewer 不直接执行 `gh pr review` / `gh pr merge`（由 task_control 完成）
- 不使用默认 --force 清理

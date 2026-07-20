---
name: flow-review
description: 双轴审查（规范 + 规格）→ 自动合并
---

# flow-review

沿两条轴线审查 PR 代码：规范（是否符合编码标准）和规格（是否实现了原始需求）。

## Prerequisites
- PR 已创建
- 可选的 `/test` 已完成

## Workflow

### 1. 获取审查材料
```bash
gh pr diff <pr-number>
gh pr view <pr-number> --json title,body,files
```

### 2. 阅读约束来源
- 检查相关 ADR（`docs/adr/`）— 确认代码是否遵循架构决策
- 确认规格来源：commit 消息中的 Issue 引用或 `docs/prd/` / `docs/dev/specs/`

### 3. 文档同步确认
确认 PR 中是否包含文档同步：
- 检查 PR body 是否列出已同步的文档
- 检查 `docs/guides/` 和 `docs/dev/guides/` 是否有相应变更
- 如涉及配置/API 变更但文档未同步 → 标记为阻断性问题

### 4. 双轴审查
并行检查两个维度：

**规范轴（Normative）** — 代码是否符合文档化的编码标准？
参考 `references/smell-baseline.md` 中的代码气味基线。

**规格轴（Specification）** — 代码是否忠实实现了需求？
对照 PRD（`docs/prd/`）和设计方案（`docs/dev/specs/`）验证。
- 如发现实现与设计偏差 → 追加到 `docs/dev/changelog/<YYYY-MM-DD-NNN-slug>.md`

**TDD Criterion Coverage** — 检查 Task 的 `acceptance_criteria` 是否被 PR 覆盖：
- 对照 Task frontmatter 中的 `acceptance` 数组，逐条核查
- 检查 PR 是否包含每条 criterion 对应的测试或验证
- 检查 `tdd` 配置块中的 `mode` 和 `min_cycles` 是否被遵循
- **明确不检查 commit order** — TDD cycle 的 RED→GREEN 顺序是编码过程约束，
  reviewer 不审查 commit 历史是否呈现 RED-first 模式

### 5. 合并前检查
在合并前确认以下项：
- 文档同步已完成（`docs/guides/` 已更新或无需更新）
- changelog 已记录偏差（如有）
- CI 已通过

### 6. 发表审查意见
发现阻断性问题：
```bash
gh pr review <pr-number> --request-changes --body "..."
```
无问题或非阻断性建议：
```bash
gh pr review <pr-number> --approve --body "..."
```

### 7. 等待 CI + 自动合并
```bash
gh pr checks <pr-number> --watch
gh pr merge <pr-number> --squash --delete-branch
```

### 8. 关闭关联 Sub Issue
如果 PR body 未包含 `Closes #<num>`（或 PR 合并后 GitHub 未自动关闭），手动关闭：
```bash
gh issue close <issue-num> --comment "已完成，已合并至 main"
```

### 9. 清理 Worktree
PR 合并后，安全清理对应的 worktree 和分支：

```bash
WORKTREE=".worktree/<task-slug>"
BRANCH="feat/<task-slug>"

# Preflight 检查
echo "=== Worktree 清理 Preflight ==="

# 1. 确认 PR 已合并
PR_NUM=<pr-number>
if ! gh pr view "$PR_NUM" --json merged --jq '.merged' 2>/dev/null | grep -q true; then
  echo "ERROR: PR #$PR_NUM 未合并，跳过清理"
  exit 1
fi

# 2. 确认分支已推送到远程
if git ls-remote --exit-code origin "$BRANCH" >/dev/null 2>&1; then
  echo "分支 $BRANCH 已推送到远程"
else
  echo "WARNING: 分支 $BRANCH 未推送到远程，但 PR 已合并，继续清理"
fi

# 3. 检查 worktree 是否干净
if [ -d "$WORKTREE" ]; then
  DIRTY=$(git -C "$WORKTREE" status --porcelain)
  if [ -n "$DIRTY" ]; then
    echo "WARNING: Worktree 有未提交变更："
    echo "$DIRTY"
    echo "暂停。如需强制清理请手动执行 --force"
    exit 1
  fi

  # 4. 全部通过 → 清理
  git worktree remove "$WORKTREE"
  git branch -D "$BRANCH" 2>/dev/null || true
  echo "Worktree 已清理：$WORKTREE"
else
  echo "Worktree 不存在，跳过清理"
fi
```

> 清理前必须验证 PR 已合并、worktree 干净。只有在所有 preflight 检查通过后才删除。
> 如果 PR 已合并但 worktree 仍有未提交变更，暂停并通知用户，不自动 --force。

## Output
- PR 已审查
- PR 已合并（条件满足时）
- 关联 Sub Issue 已关闭
- changelog 已记录偏差（如有）

## 后续
- **/release** — 发布（如所有 PR 已合并）

## Contract

### Trigger
由 `/review` 命令或 `@dev-lifecycle` Phase 3 审查步骤触发。

### Inputs
- PR 编号（来源：`/code` 产出）

### Preconditions
- `/code` 已完成 → PR 已创建

### Procedure
1. 获取 PR diff 和元数据
2. 双轴审查（规范轴 + 规格轴）
3. 输出结构化审查报告
4. 编排器发布审查结果
5. 等待 CI 通过后合并
6. 关闭关联 Sub Issue
7. 安全清理 Worktree（Preflight）

### Outputs
- 结构化审查报告（APPROVED / CHANGES_REQUESTED）
- PR 已合并（条件满足时）

### Failure
- Critical/High → Request Changes
- Worktree 清理失败 → 记录警告，不阻塞

### Idempotency
- 已合并的 PR → 跳过
- 已审查的 PR → 更新结论

### Prohibited Actions
- 不使用默认 --force 清理
- 不直接执行 gh pr merge（Orchestrator 执行）

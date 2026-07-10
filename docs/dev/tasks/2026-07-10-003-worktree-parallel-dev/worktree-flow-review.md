---
name: "worktree-flow-review"
depends_on: ["worktree-flow-code"]
labels: ["skill"]
worktree_root: ".worktree/worktree-flow-review/"
---

## 目标

改造 `assets/skills/flow-review/SKILL.md`，在 PR 合并后自动清理对应的 worktree 和本地分支。

## 实现要点

### 核心原则

审查只关心 PR diff，worktree 对审查透明。审查流程不变（`gh pr diff` / `gh pr view` 不感知 worktree）。

### 新增步骤

在步骤 6 "关闭关联 Sub Issue" 之后，新增步骤 7：

```markdown
### 7. 清理 Worktree

PR 合并后，清理对应的 worktree 和分支：

```bash
# 从主仓库执行
git worktree remove .worktree/<task-slug> --force
git branch -D feat/<task-slug>
```
```

### 清理时机

PR 合并后立即执行。`--force` 确保即使 worktree 有未提交变更也能清理（因为代码已合并到 main，worktree 内的变更已无意义）。

### 注意事项

- `git worktree remove` 需要从主仓库（非 worktree 内）执行
- 清理前确认 PR 已合并到 main
- 如清理失败（如进程占用），记录警告但不阻塞流程

### 编辑文件

`assets/skills/flow-review/SKILL.md` — 在现有步骤 6 之后新增步骤 7。

## 验收标准

- [ ] flow-review workflow 包含新的步骤 7：清理 Worktree
- [ ] `git worktree remove --force` 成功执行后，`.worktree/<task-slug>/` 目录被删除
- [ ] 对应本地分支 `feat/<task-slug>` 被删除
- [ ] 清理失败时不阻塞后续流程
- [ ] 原有审查步骤（1-6）保持不变

## Worktree

- 路径: `.worktree/worktree-flow-review/`
- 分支: `feat/worktree-flow-review`
- 创建时机: `/code` 阶段首次执行时自动创建
- 清理时机: PR 合并后自动删除
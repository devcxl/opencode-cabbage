---
name: "pr3-worktree-safety"
depends_on: ["pr2-templates-refs"]
labels: ["backend"]
worktree_root: ".worktree/pr3-worktree-safety/"
---

## 目标

修复 Worktree 首次创建失败和清理不安全的两个 P0 问题。

## 实现要点

1. **首次创建**: `git worktree add -b "feat/{slug}" ".worktree/{slug}" "{baseBranch}"`
2. **基础分支探测**: 动态从 `gh repo view --json defaultBranchRef` 或 git refs 获取
3. **清理 Preflight**: PR merged? HEAD reachable? git status clean? → 四步检查
4. **异常处理**: 分支已存在、目录残留、Slug 冲突 → 分情况处理

## 验收标准

- [ ] 分支和目录都不存在时创建成功
- [ ] 基础分支能正确探测（非 main 仓库也正常）
- [ ] 默认路径不自动 `--force` 删除
- [ ] Dirty Worktree 不会被删除
- [ ] 未合并 PR 的 Worktree 不会被删除

## Worktree
- 路径: `.worktree/pr3-worktree-safety/`
- 分支: `feat/pr3-worktree-safety`
- 创建时机: `/code` 阶段首次执行时自动创建
- 清理时机: PR 合并后自动删除

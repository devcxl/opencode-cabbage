---
name: "worktree-gitignore"
depends_on: []
labels: ["skill"]
worktree_root: ".worktree/worktree-gitignore/"
---

## 目标

验证 `.gitignore` 已包含 `.worktree/`，确保 worktree 目录不会被版本控制跟踪。

## 实现要点

1. 检查 `.gitignore` 文件确认包含 `.worktree/` 行（当前已包含）
2. 如需在 `.gitignore` 中追加 `.worktree/`，使用 `echo` 追加
3. 执行 `git status` 确认不显示 `.worktree/` 目录内容

```bash
# 验证 .gitignore 包含 .worktree/
grep -q '.worktree/' .gitignore && echo "OK" || echo "MISSING"

# 如缺失则追加
# echo '.worktree/' >> .gitignore
```

## 验收标准

- [ ] `.gitignore` 包含 `.worktree/` 行
- [ ] `git status` 不显示 `.worktree/` 目录内容
- [ ] 若 `.gitignore` 有修改，已提交并创建 PR

## Worktree

- 路径: `.worktree/worktree-gitignore/`
- 分支: `feat/worktree-gitignore`
- 创建时机: `/code` 阶段首次执行时自动创建
- 清理时机: PR 合并后自动删除
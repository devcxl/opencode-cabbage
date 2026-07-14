---
name: "pr4-git-safety"
depends_on: []
labels: ["backend"]
worktree_root: ".worktree/pr4-git-safety/"
---

## 目标

消除直接 push 默认分支、`git add .` 和默认 `--force` 三个安全隐患。

## 实现要点

1. **Planning PR**: 设计/任务文档统一通过 `chore/plan-{feature}` 分支创建 PR 合入
2. **显式暂存**: 替换 `git add .` 为基于 Task 输出文件的显式 `git add` 列表
3. **预暂存检查**: 提交前检查密钥、超大文件、任务范围外文件
4. **所有硬编码检测**: 搜索 Prompt 中 `git push origin main/master/dev` 并替换为动态分支

## 验收标准

- [ ] 所有 Prompt 中无 `git push origin main/master/dev` 硬编码
- [ ] 无 `git add .` 指令
- [ ] 提交前展示待暂存文件列表
- [ ] Planning PR 流程正确（分支 → push → PR → merge）

## Worktree
- 路径: `.worktree/pr4-git-safety/`
- 分支: `feat/pr4-git-safety`
- 创建时机: `/code` 阶段首次执行时自动创建
- 清理时机: PR 合并后自动删除

---
name: "worktree-flow-code"
depends_on: ["worktree-gitignore"]
labels: ["skill"]
worktree_root: ".worktree/worktree-flow-code/"
---

## 目标

改造 `assets/skills/flow-code/SKILL.md`，实现核心的 worktree 工作流：创建/复用 worktree、在 worktree 内完成编码→单测→PR 全流程。

## 实现要点

### 改造前流程

```
git checkout -b feat/<task-slug> → 编码 → npm test → git commit → gh pr create
```

### 改造后流程

```
Step 1: 检查 worktree 是否存在
  ├─ 存在 → 跳过创建，直接进入 Step 3
  └─ 不存在 → Step 2

Step 2: 创建 worktree
  git worktree add .worktree/<task-slug> feat/<task-slug>

Step 3: 安装依赖（在 worktree 内）
  cd .worktree/<task-slug>
  npm install

Step 4: 编码 + 单测（在 worktree 内）
  npm test

Step 5: 提交 + 推送 + 创建 PR（在 worktree 内）
  git add .
  git commit -m "feat(<scope>): <title>"
  git push origin feat/<task-slug>
  gh pr create --title "<title>" --body-file docs/dev/handoff/pr-body.md

Step 6: 文档同步检查（原有步骤，不变）
```

### 关键约束

- 所有操作（编码、单测、git commit、git push）均在 worktree 路径内执行
- `git push` 从 worktree 内推送与主仓库行为完全一致
- worktree 内的 `npm install` 安装独立 node_modules，不影响主仓库
- 如果 worktree 已存在（如串行 task 复用），跳过创建步骤

### 编辑文件

`assets/skills/flow-code/SKILL.md` — 替换现有分支创建和编码流程为 worktree 工作流。

## 验收标准

- [ ] flow-code SKILL.md 包含 worktree 创建/复用检查逻辑
- [ ] 编码、单测、提交、推送、PR 创建均在 worktree 路径内执行
- [ ] `npm install` 在 worktree 内独立执行，不污染主仓库
- [ ] worktree 已存在时跳过创建步骤
- [ ] 文档同步检查步骤保持不变

## Worktree

- 路径: `.worktree/worktree-flow-code/`
- 分支: `feat/worktree-flow-code`
- 创建时机: `/code` 阶段首次执行时自动创建
- 清理时机: PR 合并后自动删除
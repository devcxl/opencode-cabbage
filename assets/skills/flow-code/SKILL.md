---
name: flow-code
description: 分支 → 编码 + 单测 → PR 提交（Worktree 模式）
---

# flow-code

认领 Sub Issue，创建 worktree，实现代码+单测，提交 PR。

## Prerequisites
- `/tasks` 已完成 → Sub Issues 就绪
- 阅读 `docs/adr/` 确保实现与 ADR 兼容
- 确认 task 的 `worktree_root` 字段（来自 task 文件 frontmatter）

## Workflow

### 1. 选择任务
选择一个可执行的 Sub Issue（前置依赖已满足）。

### 2. 检查 ADR 约束
阅读相关 ADR，确保实现方案不违反已有架构决策。

### 3. 创建/复用 Worktree
```bash
# 探测默认分支
BASE=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name' 2>/dev/null || git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@' || echo "main")

# 检查和创建 worktree
WORKTREE=".worktree/<task-slug>"
BRANCH="feat/<task-slug>"

if [ -d "$WORKTREE" ]; then
  # Worktree 目录已存在 → 验证一致性
  EXISTING=$(git -C "$WORKTREE" rev-parse --abbrev-ref HEAD 2>/dev/null)
  if [ "$EXISTING" != "$BRANCH" ]; then
    echo "ERROR: $WORKTREE exists but tracks branch '$EXISTING' (expected '$BRANCH')"
    exit 1
  fi
  echo "Worktree 已存在，复用：$WORKTREE"
else
  # 检查分支是否已存在
  if git show-ref --verify "refs/heads/$BRANCH" >/dev/null 2>&1; then
    # 分支已存在，检查是否已合并
    if git branch --merged "$BASE" | grep -q "$BRANCH"; then
      git branch -D "$BRANCH"
    else
      echo "ERROR: 分支 '$BRANCH' 已存在，请先处理"
      exit 1
    fi
  fi
  # 创建 worktree + 分支
  git worktree add -b "$BRANCH" "$WORKTREE" "$BASE"
fi

# 进入 worktree
cd "$WORKTREE"
```
### 4. 安装依赖

```bash
npm install
```

### 5. 编码 + 单测
```bash
# 实现代码 + 单元测试
npm test
```

### 6. 文档同步检查
完成编码后，逐项检查以下文档是否需要同步更新：

```
## 文档同步检查清单
□ guides/quickstart.md — 安装方式或前置条件有变化吗？
□ guides/configuration.md — 新增/修改了配置项吗？
□ guides/usage.md — 命令或行为有变化吗？
□ guides/architecture.md — 架构或流程有变化吗？
□ docs/dev/guides/contributing.md — 开发流程有变化吗？
```

- 逐项评估，无需修改的跳过
- 需要修改的文档随代码一起提交到同一个 PR
- PR body 中列出已同步的文档

### 7. 提交 PR
```bash
# 在 worktree 内执行

# 根据 task 预期文件和 git status 确定待暂存文件
# Task 文件通常包含 frontmatter expected_files 字段
git status --short

# 显式暂存任务相关文件（不是 git add .）
# 示例：git add src/plugin/goal.ts test/goal.test.ts assets/agents/team/reviewer.md
git add <file1> <file2> ...

# 提交前检查：确保无密钥、无超大文件、无任务范围外文件
git diff --cached --name-only

git commit -m "feat(<scope>): <title>"
git push origin feat/<task-slug>
mkdir -p docs/dev/handoff
echo "Closes #<issue-num>" > docs/dev/handoff/pr-body.md
gh pr create --title "<title>" --body-file docs/dev/handoff/pr-body.md
```

### 8. 更新开发文档
如涉及 API 变更 → 更新 `docs/dev/api/`
如涉及数据模型变更 → 更新 `docs/dev/db/`

## Output
- Worktree 已创建/复用（`.worktree/<task-slug>/`）
- 代码已推送
- PR 已创建并关联 Sub Issue（PR body 含 `Closes #<issue-num>`）
- 文档同步 checklist 已完成
- 已同步的文档随 PR 提交
- dev docs 已更新

## 上下文管理
如果上下文窗口压力大，使用 `../flow-handoff` 打包进度。

## 后续
- **/test** — 触发 CI E2E 测试
- **/review** — 审查 PR

## Contract

### Trigger
由 `/code` 命令或 `@dev-lifecycle` Phase 3 触发。

### Inputs
- Sub Issue 编号（来源：`/tasks` 产出）
- task 文件 frontmatter 中的 `worktree_root`（来源：task 文件）

### Preconditions
- `/tasks` 已完成 → Sub Issues 就绪
- 前置依赖任务已合并

### Procedure
1. 选择依赖已满足的 Sub Issue
2. 创建或复用 Worktree（`git worktree add -b`）
3. 安装依赖 → 编码 + 单测 → commit + push
4. 编排器创建 PR

### Outputs
- Worktree 已创建（`.worktree/<task-slug>/`）
- 代码已推送
- PR 已创建（Orchestrator 执行）

### Failure
- Worktree 创建失败 → 检查分支冲突或目录残留
- 测试失败 → 修复后重试

### Idempotency
- Worktree 已存在 → 复用
- 代码已提交 → 追加提交

### Prohibited Actions
- Worker 不创建 PR、不操作 Issue
- 不使用 `git add .`
- 不直接 push 到默认分支

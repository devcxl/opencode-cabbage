---
name: flow-code
description: 分支 → 编码 + 单测 → PR 提交
---

# flow-code

认领 Sub Issue，创建分支，实现代码+单测，提交 PR。

## Prerequisites
- `/tasks` 已完成 → Sub Issues 就绪
- 阅读 `docs/adr/` 确保实现与 ADR 兼容

## Workflow

### 1. 选择任务
选择一个可执行的 Sub Issue（前置依赖已满足）。

### 2. 检查 ADR 约束
阅读相关 ADR，确保实现方案不违反已有架构决策。

### 3. 分支 → 编码 → 单测
```bash
git checkout -b feat/<task-slug>
# 实现代码 + 单元测试
npm test
```

### 4. 文档同步检查
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

### 5. 提交 PR
```bash
git commit -m "feat(<scope>): <title>"
mkdir -p docs/dev/handoff
echo "Closes #<issue-num>" > docs/dev/handoff/pr-body.md
gh pr create --title "<title>" --body-file docs/dev/handoff/pr-body.md
```

### 6. 更新开发文档
如涉及 API 变更 → 更新 `docs/dev/api/`
如涉及数据模型变更 → 更新 `docs/dev/db/`

## Output
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

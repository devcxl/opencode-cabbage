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

### 3. 双轴审查
并行检查两个维度：

**规范轴（Normative）** — 代码是否符合文档化的编码标准？
参考 `references/smell-baseline.md` 中的代码气味基线。

**规格轴（Specification）** — 代码是否忠实实现了需求？
对照 PRD（`docs/prd/`）和设计方案（`docs/dev/specs/`）验证。

### 4. 发表审查意见
发现阻断性问题：
```bash
gh pr review <pr-number> --request-changes --body "..."
```
无问题或非阻断性建议：
```bash
gh pr review <pr-number> --approve --body "..."
```

### 5. 等待 CI + 自动合并
```bash
gh pr checks <pr-number> --watch
gh pr merge <pr-number> --squash --delete-branch
```

### 6. 关闭关联 Sub Issue
如果 PR body 未包含 `Closes #<num>`（或 PR 合并后 GitHub 未自动关闭），手动关闭：
```bash
gh issue close <issue-num> --comment "已完成，已合并至 main"
```

## Output
- PR 已审查
- PR 已合并（条件满足时）
- 关联 Sub Issue 已关闭

## 后续
- **/release** — 发布（如所有 PR 已合并）

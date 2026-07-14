---
name: "pr1-role-goal"
depends_on: []
labels: ["backend"]
worktree_root: ".worktree/pr1-role-goal/"
---

## 目标

修复 Reviewer 权限与职责冲突、Worker PR 创建职责冲突、Goal 提前完成三个 P0 问题。

## 实现要点

1. **Reviewer 权限**: frontmatter `permission: {bash: "gh pr view|diff|checks", write: deny, edit: deny}`，只做只读审查，不写文件不调 goal complete
2. **Worker 职责**: backend/frontend 移除 `gh pr create`，只负责编码+测试+push
3. **Orchestrator 职责**: dev-lifecycle 不再要求 worker 创建 PR，orchestrator 自己创建
4. **Goal 身份校验**: `goal.ts` 增加 agent 名称检查，仅 goal-verify 可 complete
5. **Agent capabilities**: 3 个 agent frontmatter 新增 `capabilities` 字段

## 验收标准

- [ ] Reviewer Prompt 中无 `gh pr merge`、`goal({op:"complete"})`、文件写入指令
- [ ] Worker Prompt 中无 `gh pr create`、`gh issue`
- [ ] dev-lifecycle Prompt 中 worker 调用不再要求创建 PR
- [ ] `goal({op:"complete"})` 只有 goal-verify 可执行，其他 agent 被拒绝
- [ ] 所有 agent capabilities 与 permission 一致

## Worktree
- 路径: `.worktree/pr1-role-goal/`
- 分支: `feat/pr1-role-goal`
- 创建时机: `/code` 阶段首次执行时自动创建
- 清理时机: PR 合并后自动删除

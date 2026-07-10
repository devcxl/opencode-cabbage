# Worktree 并行开发支持

## 概述

为 dev-lifecycle 全流程添加 git worktree 支持，使 DAG 中无依赖关系的 task 可以同时在独立 worktree 中并行开发，互不干扰。

## 用户故事

- 作为**开发流程编排器（dev-lifecycle）**，我希望在 DAG 并行阶段自动为每个 task 创建独立的 worktree，避免分支切换导致的工作区冲突
- 作为**开发者/贡献者**，我希望每个 task 有独立的 node_modules、暂存区和构建产物，互不影响
- 作为**项目维护者**，我希望 worktree 在 task 完成后自动清理，不留残留

## In Scope

1. **Worktree 生命周期管理**
   - 在 `.worktree/<task-slug>/` 下创建 worktree
   - 每个 worktree 自动创建独立分支 `feat/<task-slug>`
   - 主仓库不受 worktree 操作影响
   - PR 合并后自动删除 worktree

2. **flow-code 技能改造**
   - 创建 worktree（如不存在）
   - 在 worktree 内编码 + 单测
   - 从 worktree 提交 PR
   - task 完成后清理 worktree

3. **dev-lifecycle 编排器改造**
   - Phase 3（并行编码实现）按 DAG batch 创建 worktree 组
   - 并行派发 agent 到各 worktree
   - 串行 task 复用同一 worktree（或基于主分支重建）

4. **flow-tasks 技能调整**
   - 任务 frontmatter 增加 `worktree_root` 字段（指向 `.worktree/<task-slug>/`）
   - task body 声明 worktree 路径

5. **flow-review 技能调整**
   - 审查时理解 worktree 结构（PR diff 不受 worktree 影响）
   - 合并后触发 worktree 清理

## Out of Scope

- 不改造 flow-design 阶段（设计阶段无需 worktree）
- 不引入额外的 worktree 管理 CLI 工具 — 使用原生 `git worktree`
- 不支持跨多个 git 仓库的 worktree（仅限于本项目内）
- 不支持 worktree 的持久化开发（如 task 被打断后重新 attach）

## 验收标准

- [ ] DAG batch 中 3 个无依赖 task 可同时创建 3 个独立 worktree
- [ ] 每个 worktree 有独立的分支、node_modules、暂存区
- [ ] 在 worktree 内完成编码 + 单测 + PR 提交全流程
- [ ] PR 合并后 worktree 自动删除
- [ ] 主仓库工作区不受并行 worktree 操作影响
- [ ] 串行 task（有依赖关系）在 worktree 中顺序执行

## 技术约束

- 使用 `git worktree add` 原生命令
- worktree 目录统一在 `.worktree/<task-slug>/`（项目根目录下，会被 `.gitignore` 排除）
- worktree 分支名 = `feat/<task-slug>`
- 需要确保 CI/CD 不受 worktree 影响（PR 基于分支，CI 只关心分支代码）
- `npm install` 在 worktree 中需要独立执行（每个 worktree 有独立 node_modules）
- `.worktree/` 加入 `.gitignore`

## 优先级

| 项 | 优先级 |
|----|--------|
| flow-code 改造（worktree 创建/编码/清理） | P0 |
| dev-lifecycle 编排器 Phase 3 改造 | P0 |
| flow-tasks frontmatter 调整 | P1 |
| flow-review 清理触发 | P1 |
| flow-code 支持串行 task 复用 worktree | P1 |

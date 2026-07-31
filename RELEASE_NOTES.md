# Release Notes — v1.0.0

## Breaking Changes

- **Thin Kernel 架构重构**：删除 FlowRun 持久化状态机与旧命令/skill/文档冗余。工程状态以 GitHub Issues/PRs/Checks 为唯一权威事实。
- **不再兼容旧 Flow**：旧架构（FlowRun cabinet）检测到会提示，需使用旧插件版本 0.x 完成；不自动迁移。
- **命令收敛**：9 个命令 → 7 个（删除 `/test`、`/handoff`）；skills 10 个 → 8 个（删除 flow-handoff、flow-test）。
- **内置 Context 注入删除**：领域术语统一由项目根 `CONTEXT.md` 提供并自动注入。

## Features

- **5 个生命周期工具**：`setup_control` / `flow_control` / `task_control` / `tdd_checkpoint` / `release_control`，高风险 git/gh 写操作确定性收敛到工具。
- **Functional Slug 内核派生**：模型只提交英文功能标题，内核派生并校验 slug/branch/worktree，拒绝 `Task 001` 等泛化名。
- **Runtime TDD 硬门禁**：工具亲执 RED/GREEN/回归，证据存 Task Record 受控评论，缺证据拒绝创建 PR。
- **Worktree 生命周期**：创建/复用校验/销毁 preflight（无 `--force`）。
- **根 CONTEXT.md 自动注入**：Primary 与所有子 Agent 首消息携带术语表内容与 digest。
- **AGENTS.md Project Profile**：项目特定测试/版本/发布约定由 `/setup` 探测确认。
- **风险分级自动合并**：CI + 分支保护 + 风险双层判定（只升不降）+ 高风险需非作者人类 approval。
- **技术栈无关 Release**：版本提议/Release PR/tag push 由 `release_control` 执行，实际发布走项目 GitHub Actions release workflow。
- **双轴并行 Review**：同一 reviewer 对每个 PR 并行 Specification/Quality 审查。
- **backend/frontend 合并为 developer**：技术栈无关实现 agent。

## 兼容性

- 需要 `gh` CLI 已认证（复用宿主凭据，不再隔离）。
- 需要根 `AGENTS.md` 的 Project Profile（`/setup` 生成）与 CI/release workflow。
- Node.js >= 24。

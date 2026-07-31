# ADR 0002: 采用薄工作流内核（Thin Kernel + Project Context）

**状态:** Accepted
**日期:** 2026-08-01

## 背景

opencode-cabbage 处于危险的中间态：约 2900 行 FlowRun/TDD 运行时代码已实现并通过 468 个单测，但没有任何 prompt/agent 指引调用它们（`flow_control`、`tdd_checkpoint` 在全部 assets 中零引用）。与此同时 README 与 guides 仍把这些能力描述为已驱动流程。核心问题：Prompt 实际走 `Goal + gh CLI` 与 FlowRun 状态机双轨互不联通；目标项目根 `CONTEXT.md` 未发现、创建、更新或一致性检查；worktree/branch slug 由模型自由发挥，低质量模型产出 `Task 001`；Goal、FlowRun cabinet、session-state、Sub Issue、task .md、manifest 六处状态源；`tdd_checkpoint` 未注册，RED/GREEN 证据靠模型自报。

## 决策

采用 **Thin Kernel + Project Context** 架构，作为 major release 清晰切断旧架构：

- GitHub Parent Issues、Sub Issues、PRs、Checks 作为工程状态的唯一权威事实，删除持久化 FlowRun cabinet 与 manifest/task md。
- 用 5 个确定性生命周期工具（`setup_control`、`flow_control`、`task_control`、`tdd_checkpoint`、`release_control`）约束 slug、Task、Worktree、Runtime TDD、Review/Merge、Release 等不可由模型自由决定的高风险动作。
- 目标仓库根 `CONTEXT.md` 作为领域语言权威，自动注入 Primary 与所有子 Agent；术语经用户确认后即时更新。
- 行为变更强制 Runtime TDD，证据存 Task Record 单一评论，缺证据禁止创建 PR。
- 项目通用策略内置插件默认值；项目特定验证/发布约定由 `/setup` 探测并写入根 `AGENTS.md` 的 Markdown Profile。
- Release 技术栈无关，实际发布必须走项目自己的 GitHub Actions release workflow。

## 备选方案

| 方案 | 说明 | 否决理由 |
|------|------|---------|
| 完整 FlowRun 平台 | 全面接入阶段状态机、manifest、TDD runtime、broker 凭据隔离 | 约 2900 行死代码需全部接线，且重复 GitHub 状态；与"更简单、减少冗余"目标冲突 |
| 纯 Prompt 流程 | 删除 FlowRun，全部由 skill 文本约束 | 无法可靠约束低质量模型：跳步骤、照抄占位符、把编号当名称（正是 `Task 001` 根因） |
| 先只修 Context | 仅让项目 CONTEXT.md 进入现有 skills | 不解决双轨、slug、状态漂移和死代码问题 |

## 后果

- **正向**：工程状态单一权威源（GitHub），消除双轨误导与状态漂移；slug/branch/worktree 确定性派生，弱模型无法生成 `Task 001`；TDD 门禁真实可执行；Context 全程参与避免术语漂移。
- **正向**：删除大量死代码与重复 prompt，降低维护面；低风险 PR 自动 merge 缩短交付周期。
- **风险**：删除死代码可能引入回归——缓解：保留纯函数测试作为规格，逐批删除并保持既有 468 测试通过。
- **风险**：依赖 GitHub 状态可用性与 OpenCode permission 语义——缓解：adversarial 测试锁定工具与权限行为。
- **风险**：旧 Flow 用户困惑——缓解：major 版本清晰提示 legacy FlowRun，不自动迁移。
- **风险**：自动 merge 的安全边界——缓解：分支保护 + required checks + 高风险任务必须非作者人类 approval。

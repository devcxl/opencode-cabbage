# Adopt a thin workflow kernel

opencode-cabbage 采用 Thin Kernel：以 GitHub Parent Issues、Sub Issues、PRs 和 Checks 作为工程状态的权威事实，只用确定性工具约束 slug、Task、Worktree、Runtime TDD、Review/Merge 和 Release 等不可由模型自由决定的高风险动作。选择该方案是因为纯 Prompt 无法可靠约束低质量模型，而完整 FlowRun 平台会重复 GitHub 状态并引入过高的实现与维护复杂度；Project Context 则由目标仓库根 `CONTEXT.md` 提供并自动注入整个 Flow。

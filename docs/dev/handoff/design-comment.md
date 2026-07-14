## 技术方案

三层改造：Plugin Runtime（P0 修复）→ Prompt 资产（Contract-first）→ 测试基础设施（Prompt Lint）。

关键设计决策：
- Stage Contract：约定式 Markdown（8 个固定段落）
- Task Manifest：manifest.yaml 作为依赖唯一权威源
- Agent 能力矩阵：capabilities 字段 + permission 交叉验证
- 环境探测：运行时 bash + Prompt 注入
- Bootstrap：三层条件注入
- FlowRun：先做 Spike，再决策

## ADR

- [ADR 0006](/adr/2026-07-15-prompt-contract-first) — Prompt 资产 Contract-first 约定式 Markdown
- [ADR 0007](/adr/2026-07-15-flowrun-spike) — FlowRun 先做接入 Spike 再决定完整接入

## PR 分解

9 个 PR，4 个 Batch：角色/权限/Goal → 模板/引用/Worktree → Contract 迁移 → Lint + 文档同步。

完整文档：docs/dev/specs/prompt-contract-first-refactor.md

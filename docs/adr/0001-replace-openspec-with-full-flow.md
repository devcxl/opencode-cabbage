# ADR 0001: 从 OpenSpec 重写为全流程开发插件

**状态:** Accepted
**日期:** 2026-07-07

## 背景

原 opencode-cabbage 插件实现的是 OpenSpec 工作流（propose → specs → design → tasks → apply → archive），聚焦于变更管理和规格文档。该模式仅覆盖开发流程的前半段，缺少编码、测试、审查、发布等环节。

## 决策

完全重写，替代 OpenSpec，覆盖完整开发生命周期：需求 → 设计 → 任务拆解 → 编码 → 测试 → 审查 → 发布。

## 关键变化

| 维度 | 旧 (OpenSpec) | 新 (全流程) |
|------|---------------|-------------|
| 产出目录 | `openspec/` | `docs/{prd,adr,dev}/` |
| 命令 | 4 个 opsx-* 命令 | 9 个命令 |
| 交互 | 纯 spec 管理 | 交互 + 自动编排 |
| Agent | 无 | 1 个编排器 + 4 个 subagent |
| 外部集成 | 无 | GitHub 全链路 (Issues/PRs/CI/Releases) |
| 产物留存 | 仅 specs | PRD + ADR + 开发文档 |

## 后果

- 正向：覆盖完整流程，用户无需在多个工具间切换
- 正向：自动编排减少手动操作
- 风险：功能范围扩大增加了维护复杂度
- 风险：对外部工具（gh CLI、npm）的依赖增加

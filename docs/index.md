# @devcxl/opencode-cabbage

全流程开发 OpenCode 插件 — 覆盖需求→设计→任务→编码→测试→审查→发布完整开发生命周期，支持自动编排与并行 Subagent。

## 快速链接

| 文档 | 说明 |
|------|------|
| [快速开始](guides/quickstart.md) | 5 分钟上手 |
| [配置指南](guides/configuration.md) | 完整配置说明 |
| [使用指南](guides/usage.md) | 命令详解与最佳实践 |
| [架构概览](guides/architecture.md) | 插件设计与核心概念 |
| [贡献指南](dev/guides/contributing.md) | 如何参与开发 |

## 命令一览

| 命令 | 阶段 | 产出 |
|------|------|------|
| `/setup` | 初始化 | docs/ 目录结构、环境验证 |
| `/requirements` | 需求 | PRD → `docs/prd/` + GitHub Issue |
| `/design` | 设计 | 技术方案 + ADR → `docs/dev/specs/` + `docs/adr/` |
| `/tasks` | 任务拆解 | DAG 任务 + Sub Issues → `docs/dev/tasks/` |
| `/code` | 编码 | 分支 + 代码 + 单测 + PR |
| `/test` | 测试 | 触发 CI + 监控 + 汇报 |
| `/review` | 审查 | 双轴审查 + 自动合并 |
| `/release` | ⚠️ 手动发布 | 版本 → Changelog → Release → npm publish |
| `/handoff` | 交接 | 打包上下文，跨会话传递 |

## 快速安装

```json
// opencode.json
{
  "plugin": ["@devcxl/opencode-cabbage"]
}
```

插件启动后自动注入 9 个 slash command、9 个 flow skill、5 个 agent。

## 两种模式

- **手动模式** — 按顺序逐一执行命令，适合精细控制
- **自动模式** — 需求确认后输入 `@dev-lifecycle`，全自动完成剩余流程

# @devcxl/opencode-cabbage

全流程开发 OpenCode 插件 — 覆盖需求→设计→任务→编码→测试→审查→发布完整开发生命周期，支持自动编排与并行 Subagent。

[![npm version](https://img.shields.io/npm/v/@devcxl/opencode-cabbage)](https://www.npmjs.com/package/@devcxl/opencode-cabbage)
[![CI](https://github.com/devcxl/opencode-cabbage/actions/workflows/ci.yml/badge.svg)](https://github.com/devcxl/opencode-cabbage/actions/workflows/ci.yml)
[![GitHub Pages](https://github.com/devcxl/opencode-cabbage/actions/workflows/pages.yml/badge.svg)](https://devcxl.github.io/opencode-cabbage)

---

## 安装

```json
// opencode.json
{
  "plugin": ["@devcxl/opencode-cabbage"]
}
```

插件启动后自动注入 9 个 slash command、9 个 flow skill、5 个 agent。

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

## 快速开始

```bash
# 1. 安装
npm install @devcxl/opencode-cabbage

# 2. 在 opencode.json 中添加
# { "plugin": ["@devcxl/opencode-cabbage"] }

# 3. 在 OpenCode 中执行
# /setup → /requirements → @dev-lifecycle
```

## 两种模式

- **手动模式** — 按顺序逐一执行命令，适合精细控制
- **自动模式** — 需求确认后输入 `@dev-lifecycle`，全自动完成剩余流程

## 架构

```
src/                          # TypeScript 薄层
├── index.ts                  # 插件入口
├── plugin.ts                 # 包路径解析
└── plugin/
    ├── server.ts             # 主工厂：注入 skills/commands/agents
    ├── commands.ts           # Command 加载器
    ├── skills.ts             # Skill 加载器
    ├── prompts.ts            # Prompt 加载器
    ├── bootstrap.ts          # 启动引导
    └── agents.ts             # Agent 注入

assets/                       # 运行时资源
├── commands/                 # 9 个 slash command
├── skills/                   # 9 个 flow-* skill
├── agents/                   # 5 个 agent 定义
├── context/                  # 领域词汇表
└── prompts/                  # 引导提示词 + 模板
```

## 文档

| 文档 | 链接 |
|------|------|
| 快速开始 | [docs/guides/quickstart.md](docs/guides/quickstart.md) |
| 配置指南 | [docs/guides/configuration.md](docs/guides/configuration.md) |
| 使用指南 | [docs/guides/usage.md](docs/guides/usage.md) |
| 架构概览 | [docs/guides/architecture.md](docs/guides/architecture.md) |
| 贡献指南 | [docs/dev/guides/contributing.md](docs/dev/guides/contributing.md) |

## 许可

MIT

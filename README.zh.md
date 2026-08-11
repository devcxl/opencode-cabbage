<div align="center">
  <h1>@devcxl/opencode-cabbage</h1>
  <p>全流程开发 OpenCode 插件 — 覆盖需求、设计、任务、编码、测试、审查和发布完整开发生命周期，支持自动编排与并行 Subagent。</p>
  <p>
    <a href="https://github.com/devcxl/opencode-cabbage/actions/workflows/ci.yml"><img src="https://github.com/devcxl/opencode-cabbage/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI"></a>
    <a href="https://github.com/devcxl/opencode-cabbage/actions/workflows/release-draft.yml"><img src="https://github.com/devcxl/opencode-cabbage/actions/workflows/release-draft.yml/badge.svg" alt="Release"></a>
    <a href="https://github.com/devcxl/opencode-cabbage/actions/workflows/release-publish.yml"><img src="https://github.com/devcxl/opencode-cabbage/actions/workflows/release-publish.yml/badge.svg" alt="Publish to npm"></a>
    <a href="https://www.npmjs.com/package/@devcxl/opencode-cabbage"><img src="https://img.shields.io/npm/v/@devcxl/opencode-cabbage" alt="npm version"></a>
    <a href="https://www.npmjs.com/package/@devcxl/opencode-cabbage"><img src="https://img.shields.io/npm/dm/@devcxl/opencode-cabbage" alt="npm downloads"></a>
    <a href="https://devcxl.github.io/opencode-cabbage"><img src="https://github.com/devcxl/opencode-cabbage/actions/workflows/pages.yml/badge.svg?branch=main" alt="GitHub Pages"></a>
  </p>
  <p><a href="README.md">English</a> | 简体中文</p>
</div>

---

## 安装

```json
// opencode.json
{
  "plugin": ["@devcxl/opencode-cabbage"]
}
```

插件启动后自动注入 7 个 slash command、8 个 flow skill、5 个 agent 与 1 个 goal 工具。

## 命令一览

| 命令 | 阶段 | 产出 |
|------|------|------|
| `/setup` | 初始化 | `docs/` 目录结构、Project Profile、CI/release workflow 校验 |
| `/requirements` | 需求 | PRD → `docs/prd/` + Draft Parent Issue |
| `/design` | 设计 | 技术方案 + 必要 ADR → `docs/dev/specs/` + `docs/adr/` |
| `/tasks` | 任务拆解 | DAG 任务 + Sub Issues（GitHub 权威源） |
| `/code` | 编码 | Task + PR（TDD 由 CI 把关） |
| `/review` | 审查 | 双轴审查 + 自动合并 |
| `/release` | ⚠️ 手动发布 | 版本提议 → Release PR → tag push → workflow 监控 |

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
├── plugin/                   # 加载器 + goal 工具
│   ├── server.ts             # 主工厂：注入 skills/commands/agents、goal 工具、Context、自动续接
│   ├── goal.ts               # goal 工具（状态管理 + goal-verify 授权）
│   ├── commands.ts           # Command 加载器
│   ├── skills.ts             # Skill 加载器
│   ├── prompts.ts            # Prompt 加载器
│   ├── bootstrap.ts          # 启动引导
│   ├── agents.ts             # Agent 注入
│   ├── shell.ts              # Agent shell 环境隔离
│   └── prompt-lint.ts        # Prompt 资产一致性检查
└── kernel/                   # 最小支撑模块
    ├── context.ts            # 根 CONTEXT.md 发现/注入
    ├── profile.ts            # AGENTS.md Project Profile 解析
    ├── session-index.ts      # Flow→session 索引（goal 绑定 + 重启恢复）
    ├── permission.ts         # 权限匹配语义
    └── mutex.ts              # 按键异步互斥

assets/                       # 运行时资源（纯 Prompt 流程）
├── commands/                 # 7 个 slash command
├── skills/                   # 8 个 flow-* skill（Prompt 驱动，直接 git/gh）
├── agents/                   # 5 个 agent 定义
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

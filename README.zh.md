<div align="center">
  <h1>@devcxl/opencode-cabbage</h1>
  <p>面向 OpenCode v2.3+ 的全流程开发插件 — 融合 OpenSpec 活规格沉淀与 Matt Pocock 工程工作流，原生对接 OpenCode 内置 <code>/goal</code>，纯 TypeScript 零 Python 依赖。</p>
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

## OpenCode 兼容性

> **要求 OpenCode v2（已在 OpenCode v2.3.0 + `@opencode/plugin@^2.3.2` 端到端实测）。** 基于 V2 `Plugin.define` 入口、原生 `opencode.goal` RPC、`experimental.idle` 后台任务感知钩子与域 transform。OpenCode v1 用户请继续使用 `1.x` 版本线。

## 安装

```bash
opencode plugin add @devcxl/opencode-cabbage
```

该命令会安装插件并写入全局配置（`plugins: ["@devcxl/opencode-cabbage"]`）。重启 OpenCode 或执行 `opencode reload` 后生效。

插件启动后自动注入 7 个 `/flow-*` 命令（避让 OpenCode v2.3 内置 `/review`、`/goal`、`/init`）、12 个 flow skill、6 个 agent 与纯 TS 版 `cabbage` 变更记录工具：

- **复用内置 `/goal`**：需要无人值守连续推进时，直接使用 OpenCode 原生 `/goal`（支持 `/goal pause|resume|clear`）。插件通过 `opencode.goal` RPC 与 `experimental.idle` 钩子识别状态并自动注入上下文，不再自建冲突的续接循环。
- **保留内置 `/review`**：日常快速查看本地未提交改动或分支继续用原生 `/review`；Cabbage 的双轴 PR 审查与自动合并走 `/flow-review`。

## 内置变更记录（纯 TypeScript Cabbage 引擎）

插件内置纯 TS 变更记录与文档校验引擎（`src/cabbage/`），**不再需要 Python 3.10+ 或 PyYAML**：

- **快车道与留痕路径分流**：单 Task 小修、局部重构、文档小改直接走快车道；跨模块或高风险改动（`api`、`database`、`security`、`deployment`）才启用 `.cabbage/changes/<id>/` 进行分阶段验证、合并门禁与 OpenSpec 语义同步。
- **单一任务账本**：大功能流只认 GitHub Parent/Sub Issues，不再生成或回写本地 task Markdown 与 `DAG.md`。
- **统一活规格目录**：系统当前行为统一沉淀在 `docs/specs/`（含 `Testing Decisions`），重大决策记入 `docs/adr/`。

## 命令一览

| 命令 | 阶段 | 产出 |
|------|------|------|
| `/flow-setup` | 初始化 | `AGENTS.md` Project Profile、环境就绪检查 |
| `/flow-requirements` | 需求 | PRD → `docs/prd/` + GitHub Parent Issue |
| `/flow-design` | 设计 | 系统规格（`docs/specs/`）+ `Testing Decisions` + 必要 ADR（`docs/adr/`） |
| `/flow-tasks` | 任务拆解 | 垂直切片 Task Plan → GitHub Sub Issues（单一任务账本） |
| `/flow-code` | 编码 | Worktree + 行为 TDD + PR |
| `/flow-review` | 审查 | 双轴审查（规格轴 + 规范轴）+ 自动合并 |
| `/flow-release` | ⚠️ 手动发布 | 版本提议 → Release PR → tag push → GitHub Actions 发布 |

## 快速开始

```bash
# 1. 安装
opencode plugin add @devcxl/opencode-cabbage

# 2. 在 OpenCode 中执行
# /flow-setup → /flow-requirements → @dev-lifecycle（可配合 /goal 自动续跑）
```

## 架构

```
src/                          # 纯 TypeScript OpenCode v2.3+ 插件
├── index.ts                  # 插件入口
├── plugin.ts                 # 包路径解析
├── cabbage/                  # 纯 TS 变更记录与活规格校验引擎（零 Python 依赖）
│   ├── engine.ts             # init/new/impact/verify/gate/validate/sync/archive/adopt
│   ├── validate.ts           # 标题/占位符/Mermaid 围栏/相对链接与锚点校验
│   └── workflows.ts          # change/incident 工作流定义与统一文档映射
├── plugin/                   # 加载器 + 原生钩子 + 内置工具
│   ├── server.ts             # 主工厂：skills/commands/agents/tools、context 与 experimental.idle 钩子
│   ├── builtin-goal.ts       # OpenCode v2.3 opencode.goal RPC 读取器与空闲守卫
│   ├── cabbage-tool.ts       # `cabbage` 工具（agent 门控）
│   ├── install-dir.ts        # 版本化目录安装
│   ├── commands.ts           # /flow-* Command 加载器
│   ├── skills.ts             # Skill 加载器
│   ├── prompts.ts            # Prompt 加载器
│   ├── bootstrap.ts          # 启动引导
│   ├── agents.ts             # Agent 注入与原生权限渲染
│   ├── shell.ts              # Agent shell 环境隔离
│   └── prompt-lint.ts        # Prompt 资产一致性检查
└── kernel/                   # 支撑模块
    ├── context.ts            # 根 CONTEXT.md 发现/注入
    ├── profile.ts            # AGENTS.md Project Profile 解析
    └── permission.ts         # 权限匹配语义

assets/                       # 运行时资源
├── commands/                 # 7 个 /flow-* slash command
├── skills/                   # 12 个 flow-* skill
├── agents/                   # 6 个 agent 定义
└── prompts/                  # 引导提示词
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

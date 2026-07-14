# 配置指南

本文档详细说明 opencode-cabbage 的所有配置选项。

## 安装配置

### 基础安装

```json
// opencode.json
{
  "plugin": ["@devcxl/opencode-cabbage"]
}
```

### 自定义覆盖

插件启动后会自动注入 slash command、skills 和 agents。你可以通过 `opencode.json` 覆盖任何注入项：

```json
{
  "plugin": ["@devcxl/opencode-cabbage"],
  "command": {
    "/my-custom-requirements": {
      "template": "自定义需求分析模板...",
      "description": "自定义需求命令"
    }
  },
  "agent": {
    "architect": {
      "description": "自定义架构师",
      "mode": "subagent",
      "color": "#ff5722",
      "prompt": "自定义 prompt..."
    }
  },
  "skills": {
    "paths": ["./my-custom-skills"]
  }
}
```

> 插件不会覆盖已存在的配置 — 如果你在 `opencode.json` 中定义了同名 command 或 agent，插件的注入将被跳过。

## 插件自动注入的配置

### 9 个 Slash Command

| 命令 | 触发 agent | 说明 |
|------|-----------|------|
| `/setup` | — | 初始化：检测 gh CLI、配置 GitHub、创建 docs/ |
| `/requirements` | — | 需求访谈 → PRD → GitHub Issue |
| `/design` | `@architect` | 技术方案 + ADR |
| `/tasks` | `@architect` | DAG 任务拆解 → Sub Issues |
| `/code` | — | 分支 → 编码 + 单测 → PR |
| `/test` | — | 触发 CI → 监控 → 汇报 |
| `/review` | `@reviewer` | 双轴审查 → 自动合并 |
| `/release` | — | 版本 → Changelog → Release → npm publish |
| `/handoff` | — | 打包上下文，跨会话传递 |

每个 command 对应一个 `flow-*` skill，定义在 `assets/skills/` 目录中。

### 5 个 Agent

| Agent | 模式 | 角色 |
|-------|------|------|
| `@dev-lifecycle` | primary | 全流程编排器，自动串联各阶段 |
| `@architect` | subagent | 架构设计、技术方案、DAG 拆解 |
| `@backend` | subagent | 后端代码 TDD 实现 |
| `@frontend` | subagent | 前端代码 TDD 实现 |
| `@reviewer` | subagent | 只读代码审查，输出结构化报告 |
| `@goal-verify` | subagent | 独立验证 Goal 完成状态（唯一可调用 `goal({op:"complete"})`） |

另有内置 Agent：`@architect`、`@backend`、`@frontend`。

### 9 个 Flow Skills

| Skill | 对应命令 | 用途 |
|-------|---------|------|
| `flow-setup` | `/setup` | 环境初始化 |
| `flow-requirements` | `/requirements` | 需求分析 |
| `flow-design` | `/design` | 技术设计 |
| `flow-tasks` | `/tasks` | 任务拆解 |
| `flow-code` | `/code` | 编码实现 |
| `flow-test` | `/test` | CI 测试 |
| `flow-review` | `/review` | 代码审查 |
| `flow-release` | `/release` | 发布 |
| `flow-handoff` | `/handoff` | 上下文交接 |

Skills 被复制到系统临时目录（`/tmp/opencode-cabbage-skills-*`）中运行，不会污染项目目录。

## FlowRun 引擎配置

FlowRun 是插件的自动编排引擎，状态存储在 GitHub Issue body 中。经 Spike 验证（2026-07-15），阶段性接入中。

### FlowRun 状态

```
planned → running → blocked/merging → completed/cancelled
```

### 7 个阶段

`requirements → design → tasks → code → test → review → merge`

每个阶段有准入/准出检查：

- **准入**：前序阶段必须完成（status: pass）
- **准出**：所有 checkpoints 通过、required artifacts 就绪

### Task DAG

任务支持依赖关系。只有所有依赖任务已合并，当前任务才能开始：

```yaml
task-1:
  dependsOn: []          # 无依赖，可先执行
task-2:
  dependsOn: [task-1]    # 依赖 task-1
task-3:
  dependsOn: [task-1]    # 依赖 task-1，可与 task-2 并行
task-4:
  dependsOn: [task-2, task-3]  # 依赖前两者都完成
```

### PR 合并检查点

每个 PR 必须通过 6 个检查点才能自动合并：

| 检查点 | 说明 |
|--------|------|
| localChecks | 本地代码检查（类型检查、lint、测试） |
| ciChecks | CI 流水线通过 |
| reviewerApproval | reviewer 审查通过 |
| goalVerification | goal-verify 验证通过 |
| branchProtection | main 分支保护规则满足 |
| mergeResult | 合并操作成功 |

### 弹性配置

| 参数 | 默认值 | 说明 |
|------|--------|------|
| maxRuntime | 86400000 (24h) | FlowRun 最大运行时间 |
| continuationCount | 50 | 自动 continuation 最大次数 |
| errorRetryCount | 3 → skip, 5 → pause | 错误重试策略 |
| compactionThreshold | 20 | 每 20 次 continuation 自动 compact |

## 文档目录结构

插件自动创建并管理以下文档目录：

```
docs/
├── prd/              # 产品需求文档
├── adr/              # 架构决策记录
├── dev/
│   ├── specs/        # 技术方案
│   ├── tasks/        # 任务定义
│   ├── api/          # API 文档
│   ├── db/           # 数据库设计
│   ├── guides/       # 开发指南
│   └── handoff/      # 交接文档
└── index.md          # 本站首页
```

## 环境要求

| 工具 | 版本要求 | 用途 |
|------|---------|------|
| Node.js | >= 18 | 运行环境 |
| npm | >= 9 | 包管理 |
| gh CLI | >= 2.0 | GitHub 操作（Issues/PRs/CI/Releases） |
| Git | >= 2.0 | 版本控制 |

## 高级：自定义 Prompt 覆盖

插件支持两级 prompt 加载：项目级 > 内置级。

在项目目录下创建 `.opencode/opencode-cabbage/prompts/<name>.md` 即可覆盖内置 prompt：

```
.opencode/
└── opencode-cabbage/
    └── prompts/
        ├── bootstrap.md      # 覆盖启动引导
        ├── PRD-FORMAT.md     # 覆盖 PRD 格式
        └── ADR-FORMAT.md     # 覆盖 ADR 格式
```

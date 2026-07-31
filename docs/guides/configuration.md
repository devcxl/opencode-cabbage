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

### 7 个 Slash Command

| 命令 | 触发 agent | 说明 |
|------|-----------|------|
| `/setup` | — | 初始化：检测 gh CLI、Project Profile、CI/release workflow |
| `/requirements` | — | 需求访谈 → PRD → Draft Parent Issue |
| `/design` | `@architect` | 技术方案 + 必要 ADR（planning worktree） |
| `/tasks` | `@architect` | DAG 任务拆解 → Sub Issues |
| `/code` | — | Task 编码 + Runtime TDD → PR |
| `/review` | `@reviewer` | 双轴审查 → 自动合并 |
| `/release` | — | 版本提议 → Release PR → tag push → workflow 监控 |

每个 command 对应一个 `flow-*` skill，定义在 `assets/skills/` 目录中；所有命令共享单一 Stage contract（`assets/prompts/stage-contract.md`）。

### 5 个 Agent

| Agent | 模式 | 角色 |
|-------|------|------|
| `@dev-lifecycle` | primary | 全流程编排器，自动串联各阶段 |
| `@architect` | subagent | 架构设计、技术方案、DAG 拆解（仅 planning worktree 文档可写） |
| `@developer` | subagent | 技术栈无关代码 TDD 实现（仅 worktree 内可写） |
| `@reviewer` | subagent | 只读代码审查，输出结构化报告 |
| `@goal-verify` | subagent | 独立验证 Flow 完成状态（唯一可调用 `flow_control{complete-flow}`） |

### 9 个 Flow Skills

| Skill | 对应命令 | 用途 |
|-------|---------|------|
| `flow-setup` | `/setup` | 环境初始化 |
| `flow-requirements` | `/requirements` | 需求分析 |
| `flow-design` | `/design` | 技术设计 |
| `flow-tasks` | `/tasks` | 任务拆解 |
| `flow-code` | `/code` | 编码实现 |
| `flow-tdd` | — | TDD 协议唯一来源（tdd_checkpoint op 映射） |
| `flow-review` | `/review` | 代码审查 |
| `flow-release` | `/release` | 发布 |

Skills 被复制到固定目录（`~/.config/opencode/cabbage/skills`）中运行，不会污染项目目录。

## Thin Kernel 工具

### 5 个生命周期工具

| 工具 | 职责 |
|------|------|
| `setup_control` | probe / generate-workflows / confirm-profile（readiness 报告） |
| `flow_control` | create-flow / status / planning-start / planning-pr / stage / complete-flow / cancel / takeover |
| `task_control` | create-task / start-task / submit-task / submit-review / merge-task / cancel / destroy / status |
| `tdd_checkpoint` | cycle-start / red / green / final-regression / final-verification / abandon / status / not-applicable / exempt |
| `release_control` | propose-version / open-release-pr / merge-release-pr / monitor |

### 5 个 Stage

`requirements → design → tasks → code → review`

每个阶段有前置门禁（由工具校验）：

- **requirements**：需求基线须用户确认一次
- **design**：产出技术方案 + 必要 ADR；高风险方案在 design→tasks 间暂停确认
- **tasks**：Planning Baseline 合并后才能创建 Sub Issues
- **code**：Planning Baseline 已合并、依赖 Task 已 merged、并行 < 5
- **review**：CI checks + 分支保护 + 风险双层判定 + 高风险非作者 approval

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

### 合并门禁

PR 合并前必须通过：

| 检查点 | 说明 |
|--------|------|
| CI checks | 全部 SUCCESS（statusCheckRollup） |
| branchProtection | main 分支保护规则存在 |
| 风险双层判定 | 模型初判 + 内核按 diff 升级（只升不降） |
| 高风险 approval | 非作者人类 APPROVED review（高风险任务） |
| mergeResult | 合并操作成功（--match-head-commit） |

### 弹性配置

| 参数 | 默认值 | 说明 |
|------|--------|------|
| 并行上限 | 5 | 同时运行的 Task 数 |
| Task 重试 | 3 | 失败自动重试次数 |
| Review 轮次 | 3 | 自动修复上限 |
| 停滞判定 | 3 | 连续无进展 continuation 次数后暂停 |
| compactionThreshold | 20 | 每 20 次 continuation 自动 compact |

## 文档目录结构

插件自动创建并管理以下文档目录：

```
docs/
├── prd/              # 产品需求文档
├── adr/              # 架构决策记录
├── dev/
│   ├── specs/        # 技术方案
│   ├── tasks/        # 任务定义（历史归档）
│   ├── api/          # API 文档
│   ├── db/           # 数据库设计
│   └── guides/       # 开发指南
└── index.md          # 本站首页
```

工程状态以 GitHub Issues/PRs/Checks 为权威事实，`docs/dev/tasks/` 仅保留历史任务记录。

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

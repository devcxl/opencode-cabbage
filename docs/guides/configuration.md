# 配置指南

本文档详细说明 opencode-cabbage 的所有配置选项。

## 安装配置

### 基础安装

```bash
opencode plugin add @devcxl/opencode-cabbage
```

等价于在全局 `opencode.json` 中手动写入：

```json
{
  "plugins": ["@devcxl/opencode-cabbage"]
}
```

### 自定义覆盖

插件启动后会自动注入 slash command、skills 和 agents。你可以通过 `opencode.json` 覆盖任何注入项：

```json
{
  "plugins": ["@devcxl/opencode-cabbage"],
  "commands": {
    "my-custom-requirements": {
      "template": "自定义需求分析模板...",
      "description": "自定义需求命令"
    }
  },
  "agents": {
    "architect": {
      "description": "自定义架构师",
      "mode": "subagent",
      "color": "#ff5722",
      "system": "自定义 prompt..."
    }
  },
  "skills": ["./my-custom-skills"]
}
```

> 插件不会覆盖用户已存在的同名 agent（缺位才注册）。command 注册在 OpenCode V2 中为 transform 式（无同名跳过能力），自定义同名命令可能被插件注册覆盖——建议使用不同名称。

## 插件自动注入的配置

### 7 个 Slash Command

| 命令 | 触发 agent | 说明 |
|------|-----------|------|
| `/setup` | — | 初始化：探测环境、确认 Project Profile |
| `/requirements` | — | 需求访谈 → PRD → Parent Issue |
| `/design` | `@architect` | 技术方案 + 必要 ADR → 设计 PR |
| `/tasks` | `@architect` | DAG 任务拆解 → Sub Issues |
| `/code` | `@developer` | Task 编码 + TDD → PR |
| `/review` | `@reviewer` | 双轴审查 → 合并 |
| `/release` | — | 版本提议 → Release PR → tag push → workflow 监控 |

每个 command 对应一个 `flow-*` skill，定义在 `assets/skills/` 目录中；所有命令共享单一 Stage contract（`assets/prompts/stage-contract.md`）。

### 6 个 Agent

| Agent | 模式 | 角色 |
|-------|------|------|
| `@dev-lifecycle` | primary | 全流程编排器，自动串联各阶段（全权执行 git/gh） |
| `@architect` | subagent | 架构设计、技术方案、DAG 拆解（只写 docs/assets） |
| `@developer` | subagent | 技术栈无关代码 TDD 实现（worktree 内开发，不 push） |
| `@reviewer` | subagent | 只读代码审查，输出结构化报告 |
| `@researcher` | subagent | 独立调研与事实核查（产出带引用的调研文档） |
| `@goal-verify` | subagent | 独立验证 Flow 完成状态（唯一可 complete goal） |

### 12 个 Flow Skills

| Skill | 对应命令 | 用途 |
|-------|---------|------|
| `flow-setup` | `/setup` | 环境初始化 + Profile 确认 + 存量文档接入（adopt） |
| `flow-requirements` | `/requirements` | 需求分析 |
| `flow-design` | `/design` | 技术设计 + ADR/RFC 内容标准 |
| `flow-tasks` | `/tasks` | 任务拆解 |
| `flow-code` | `/code` | 编码实现 |
| `flow-tdd` | — | TDD 协议唯一来源（advisory，self-report） |
| `flow-review` | `/review` | 代码审查 |
| `flow-release` | `/release` | 发布 |
| `flow-research` | — | 调研与事实核查（由 @researcher 加载） |
| `flow-change` | — | 变更记录：tasks + 专项文档 → 验证/门禁/归档（内置 Cabbage 引擎） |
| `flow-incident` | — | 事故复盘：incident → postmortem → 预防措施落地 |
| `flow-docs` | — | 当前状态文档治理：编号目录、链接、图表、站点 |

Skills 安装到固定目录（`~/.config/opencode/cabbage/skills@<version>/`，按插件版本隔离），并通过 V2 原生 skill 注册（references 相对路径随目录解析），不会污染项目目录。

### 2 个工具：goal 与 cabbage

插件注册两个工具。`goal` 用于会话级 Flow 状态跟踪：

| op | 说明 |
|----|------|
| `create` | 建立 goal（绑定 Parent Issue 编号） |
| `get` | 读取当前 goal 状态 |
| `pause` / `resume` | 暂停 / 恢复 goal |
| `cancel` | 取消 goal |
| `complete` | 标记完成（仅 `goal-verify` 可调用） |

目标与验收标准从 Parent Issue body 读取，不存储在 goal 中。

`cabbage` 用于变更记录（内置 Cabbage 引擎，需机器具备 Python 3.10+），仅 `dev-lifecycle` 可调用：

| op | 说明 |
|----|------|
| `init` | 初始化 `.cabbage/`（工作流、CI 模板、vendored CLI） |
| `adopt` | 盘点 docs 树之外的 Markdown → `.cabbage/adoption-report.md`（只读盘点，迁移手动） |
| `new` | 创建记录（`type`: change / incident） |
| `status` / `next` | 记录列表 / 阶段就绪与阻塞 |
| `impact` | 声明风险标记（design/rfc/adr/api/database/security/deployment） |
| `verify` / `gate` | 阶段验证 / 门禁（阶段 ID、merge、archive） |
| `validate` | 结构校验 |
| `sync` / `archive` | 同步当前文档 / 收尾归档 |
| `tasks` / `discard` | 任务清单视图 / 废弃记录 |

`archive` 不检查 Git 合并状态，须人工确认合并后执行；`change.yaml` 与 `state.json` 由 CLI 管理，不得手工编辑。

## 阶段契约

7 个阶段，顺序推进（stage-contract 为单一来源）：

```
setup → requirements → design → tasks → code → review → release（手动）
```

- 阶段完成 = Parent Issue body checklist `- [x] <stage>`
- requirements 完成需用户确认一次
- 设计基线（docs + ADR）合入后才能拆解任务
- 测试质量由仓库 CI workflow 把关，插件不重复执行

## Task DAG

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

DAG 依赖由编排器（dev-lifecycle）维护，按拓扑顺序分批执行。

## 文档目录结构

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

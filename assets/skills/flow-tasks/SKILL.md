---
name: flow-tasks
description: DAG 任务拆解 → Task Record（task_control）
---

# flow-tasks

将设计方案拆解为 DAG（有向无环图）任务，并用 `task_control{op:"create-task"}` 创建 Task Record（GitHub Sub Issue）。

## 核心：调用 task_control

`task_control{op:"create-task", title:"<英文功能标题>", acceptance_criteria:"<JSON>", ...}` 创建 Sub Issue。
内核负责 slug 派生与校验、标题规范（R3）、关联 Parent Issue——创建动作全部收敛到工具内。

## DAG 拆解

#### 拆解前自检

1. **能否用一个任务完成？** — 如果功能足够内聚，不强拆多个任务
2. **拆开后能否独立验证？** — 每个任务必须有独立的验收标准
3. **拆开后耦合是否最低？** — 两个任务共享大量数据结构/模块 → 合并

#### 反模式

| 反模式 | 示例 | 正确做法 |
|--------|------|----------|
| 技术分层拆分 | "建表任务" → "DAO 任务" → "Service 任务" | 垂直切片：一个任务包含完整链路 |
| 过度拆分 | 一个 CRUD 拆成四个任务 | 一个 CRUD 就是一个任务 |
| 预留式拆分 | "先搭框架，后面任务再填内容" | 不要有空壳任务 |

DAG 使用 Mermaid 语法绘制，保存为 `docs/dev/tasks/<YYYY-MM-DD-NNN-slug>/DAG.md`。

## 任务定义文件

每个任务一个文件 `docs/dev/tasks/<task-name>.md`，frontmatter 含 `test_commands` / `verify_commands` / `tdd` 配置块 / `acceptance` 结构化验收标准。
这些字段是 `flow-tdd` skill 的输入（RED→GREEN cycle、final-regression、final-verification）。

## Output
- `docs/dev/tasks/*.md` — 独立任务文件
- GitHub Sub Issues（由 task_control 创建，依赖关系在 body 中声明）

## 后续
- **/code** — 认领 Sub Issue 开始编码

## Contract

### Trigger
由 `/tasks` 命令或 `@dev-lifecycle` Phase 2 触发。

### Inputs
- `docs/dev/specs/<title>.md` — 技术方案
- Flow Record 编号

### Preconditions
- `/design` 已完成 → 技术方案和 ADR 存在（Planning Baseline 已合入）

### Procedure
1. 基于技术方案拆解 DAG（Mermaid 图 + 任务文件）
2. 为每个任务调用 `task_control{op:"create-task"}` 创建 Sub Issue
3. 任务文件随 Planning PR 合入默认分支

### Outputs
- `docs/dev/tasks/<feature-slug>/` — DAG 与任务文件
- GitHub Sub Issues（含依赖声明）

### Failure
- DAG 存在环形依赖 → 阻止并报告
- Sub Issue 创建失败 → 记录失败项

### Idempotency
- 任务文件已存在 → 读取并更新
- Sub Issue 已创建 → 内核检测同名冲突（未合并分支/worktree）并拒绝

### Prohibited Actions
- 不跳过 DAG 依赖检查
- 不绕过 task_control 手工创建 Sub Issue（由 create-task 完成）
- 不直接 push 到默认分支

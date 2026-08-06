---
name: flow-tasks
description: DAG 任务拆解 → GitHub Sub Issues
---

# flow-tasks

将设计方案拆解为 DAG（有向无环图）任务，并用 gh 创建 GitHub Sub Issue（Task Record），关联 Parent Issue。

## 核心流程

基于技术方案拆解 DAG 后，为每个任务创建 Sub Issue：

```bash
gh issue create --parent <parent-issue-number> \
  --title "<英文功能标题>" \
  --body "# Task: <slug>\n\n## Acceptance Criteria\n- [ ] <id>: <描述> [tdd]\n\n## Dependencies\n- #<依赖任务编号>\n\nCloses 约定：PR body 含 \"Closes #<issue>\" 以在合并时关闭本 Sub Issue"
```

标题使用英文功能短语（kebab-case），作为分支名 `feat/<slug>` 的基准。

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

每个任务一个文件 `docs/dev/tasks/<task-name>.md`，frontmatter 含 `test_commands` / `verify_commands` / `acceptance` 结构化验收标准。
这些字段是 `flow-tdd` skill 的输入（RED→GREEN cycle、final-regression、final-verification）。

## Output
- `docs/dev/tasks/*.md` — 独立任务文件
- GitHub Sub Issues（依赖关系在 body 中声明）

## 后续
- **/code** — 认领 Sub Issue 开始编码

## Contract

### Trigger
由 `/tasks` 命令或 `@dev-lifecycle` Phase 2 触发。

### Inputs
- `docs/dev/specs/<title>.md` — 技术方案
- Parent Issue 编号

### Preconditions
- `/design` 已完成 → 技术方案和 ADR 存在（设计基线已合入）

### Procedure
1. 基于技术方案拆解 DAG（Mermaid 图 + 任务文件）
2. 为每个任务用 gh 创建 Sub Issue（关联 Parent Issue，body 声明依赖）
3. 任务文件合入默认分支

### Outputs
- `docs/dev/tasks/<feature-slug>/` — DAG 与任务文件
- GitHub Sub Issues（含依赖声明）

### Failure
- DAG 存在环形依赖 → 阻止并报告
- Sub Issue 创建失败 → 记录失败项

### Idempotency
- 任务文件已存在 → 读取并更新
- Sub Issue 已创建 → 复用其编号而非重复创建

### Prohibited Actions
- 不跳过 DAG 依赖检查
- 不创建重复 Sub Issue
- 不直接 push 到默认分支

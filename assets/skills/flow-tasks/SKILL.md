---
name: flow-tasks
description: 将技术方案拆解为可独立实现的 tracer-bullet Task Plan 与 DAG
---

# flow-tasks

将设计方案拆解为 Task Plan 与 DAG（有向无环图）。每个 Task 都是一条完整但狭窄的行为切片，可以交给一个 fresh-context developer agent 独立实现和验证。

本 skill 只定义任务拆解与 Task Plan 产出。`@architect` 不创建 GitHub Issue、不操作 GitHub lifecycle；调用方负责检查并发布 Task Plan。

## Task 拆解规则

每个 Task 必须：

1. 交付一个可以观察或验证的新行为。
2. 是垂直切片，而不是 Controller / Service / DAO 等技术分层。
3. 可以交给一个 fresh-context developer agent 独立理解和实现。
4. 完成以后仓库处于可工作的状态，而不是为下一个 Task 留空壳。
5. `Blocked By` 只声明“前者未完成时，本 Task 无法开始”的真实阻塞关系。

每个 Task 应适合一个 fresh-context developer agent：

- 不需要读取整个 Flow 历史才能理解。
- Task、Design 与 repository context 足够开始工作。
- 正常情况下不需要再次进行架构设计。
- 可以在一次独立开发循环中实现、测试、提交。

## 何时拆分

不要为了制造并行度而拆 Task。

如果一个行为高度内聚、修改范围集中、一个 fresh context 可以完成，且没有独立可验证的中间行为，则保持为一个 Task。

如果一个 Task 同时包含三个以上相互独立的“用户可以……”行为，应考虑按这些可独立验证的行为拆分。

拆分前检查：

1. **能否用一个 Task 完成？** — 足够内聚时不强拆。
2. **拆开后能否独立验证？** — 每个 Task 都必须交付可观察行为。
3. **是否真的阻塞？** — 只有无法开始的前置关系才进入 DAG。
4. **拆开后耦合是否更低？** — 大量共享同一数据结构或模块时优先合并。

## Behavior-preserving Pre-refactor

行为 Task 的唯一例外是必要的 behavior-preserving pre-refactor：当现有结构使后续行为无法在一个可测试、可工作的垂直切片中安全实现时，可以先建立一个重构 Task。

Pre-refactor 必须同时满足：

- 不改变现有可观察行为，并用回归验证证明行为保持。
- 自身完成后仓库保持可工作，不留下迁移一半的状态。
- 只消除阻碍后续行为的具体结构问题，不搭通用框架、不预留未来扩展点。
- 后续行为确实无法安全开始时，才将 pre-refactor 声明为 blocking edge。

仅仅“这样更整洁”或“以后可能复用”不构成 pre-refactor。优先直接交付行为切片。

Pre-refactor 的 `Builds` 应说明“保持哪个现有行为不变，并消除哪个阻碍后续行为的具体结构问题”，不能写成文件或类的修改清单。

## 反模式

| 反模式 | 示例 | 正确做法 |
|--------|------|----------|
| 技术分层拆分 | `create-session-table` → `implement-session-service` → `implement-session-api` | `create-and-restore-session` |
| 测试单独成 Task | `add-session-tests` | 测试随行为切片一起交付 |
| 过度拆分 | 一个内聚 CRUD 拆成多个 Task | 保持为一个可独立验证的 Task |
| 预留式拆分 | 先搭框架，后续 Task 再填内容 | 每个 Task 完成后仓库都可工作 |
| 虚假依赖 | 因修改相邻文件而声明依赖 | 仅声明不完成前者就无法开始的依赖 |

## Task 定义

每个 Task 保存为 `docs/dev/tasks/<task-name>.md`，是 developer 使用的 **Agent Implementation Contract**：

`task-name` 使用简短的英文 kebab-case 行为短语，并作为后续 `feat/<task-name>` 分支名的基准。

```markdown
---
issue: null
test_commands:
  - <targeted test command>
verify_commands:
  - <verification command>
---

# <task-slug>

## Builds

<这个 Task 完成后，哪个端到端行为真正可以工作？>

## Acceptance Criteria

- [ ] <可观察行为>
- [ ] <边界或异常行为>
- [ ] <回归要求>

## Blocked By

- <blocking-task-slug>
- 或 None

## Implementation Notes

<只记录真正限制实现方式的重要设计决策；不要复制具体实现步骤。>
```

`Builds` 必须直接说明完成后的可工作行为。`Acceptance Criteria` 是 `flow-tdd` 使用的行为规格；`test_commands` 与 `verify_commands` 只放在 Task 文件中。

Task 的行为测试必须沿用 Design `Testing Decisions` 中约定的 Test Seam。Task 不重新设计 Seam；如果既有 Seam 无法验证该行为，应返回 Design Gap，由调用方在当前 stage 完成 amendment。

### Design Gap

存量 Design 缺少 `Testing Decisions` 时，不回退 lifecycle stage，也不生成半成品 Task Plan。返回给调用方：

```markdown
## Design Gap

- Current Stage: tasks
- Design File: <docs/dev/specs/...>
- Missing Behaviors:
  - <缺少 Test Seam 或 Observable Result 的行为>
- Existing Context: <已发现的公共 Interface 与测试惯例；没有则写 None>
- Required Amendment: 为以上行为补充 Testing Decisions
```

调用方在当前 tasks 阶段完成 Design Amendment 后，重新执行 Task Planning。`@architect` 不在 flow-tasks 内自行修改测试设计。

规划阶段尚无 Issue 编号，`Blocked By` 使用 task slug。发布后由调用方将其更新为真实 `#<issue-number>`；无依赖时写 `None`。

## DAG

DAG 使用 Mermaid 语法，保存为 `docs/dev/tasks/<YYYY-MM-DD-NNN-slug>/DAG.md`。

- 节点对应行为 Task，不对应技术层。
- 边只表示真实 blocking edge。
- 发布前必须检查环形依赖。
- 发布后将 Task 节点与依赖更新为真实 Issue 编号。

## GitHub 发布边界

GitHub Sub Issue 是协作与生命周期记录，正文只提取 Task 中用户可读的内容：

```markdown
## Builds

...

## Acceptance Criteria

- [ ] ...

## Blocked By

None
```

不得把 `issue`、`test_commands`、`verify_commands` 或内部实现说明复制到 GitHub Issue。

发布由调用方执行：

- 普通 Flow：`@dev-lifecycle` 检查后自动发布。
- 高风险 Flow：展示 Task Plan，用户确认后发布。
- 用户主动 `/tasks`：展示 Task Plan，等待用户确认后发布。
- `@architect`：产出并返回 Task Plan 后停止，不执行发布。

## Output

- `docs/dev/tasks/*.md` — Agent Implementation Contracts
- `docs/dev/tasks/<YYYY-MM-DD-NNN-slug>/DAG.md` — Task DAG
- 返回给调用方的 Task Plan 摘要与拓扑顺序

## 后续

- `@dev-lifecycle` 检查并发布 GitHub Sub Issues
- **/code** — 按 Task DAG 进入编码阶段

## Contract

### Trigger
由 `/tasks` 命令或 `@dev-lifecycle` Phase 2 委派 `@architect` 触发。

### Inputs
- `docs/dev/specs/<title>.md` — 技术方案
- 相关 PRD 与 ADR
- Parent Issue 编号

### Preconditions
- `/design` 已完成，技术方案和 ADR 存在

### Procedure
1. 读取设计基线与必要的 repository context。
2. 读取 Design `Testing Decisions`，确认关键行为已有公共 Test Seam；缺失时返回 Design Gap 并停止，不生成或更新 Task 文件。
3. 识别可独立验证的 tracer-bullet 行为切片；仅在必要时增加 behavior-preserving pre-refactor。
4. 为每个 Task 定义 `Builds`、`Acceptance Criteria`、`Blocked By` 与必要的 `Implementation Notes`。
5. 生成 Task 文件与 Mermaid DAG。
6. 检查技术分层式拆分、空壳 Task、虚假依赖、臆测性 pre-refactor 与环形依赖。
7. 返回 Task Plan、文件路径与拓扑顺序；不创建 GitHub Issue。

### Outputs
- Task 定义文件
- Task DAG
- 供调用方检查与发布的 Task Plan
- 或结构化 Design Gap（存量 Design 缺少 Testing Decisions 时）

### Failure
- 无法从设计中确定可验证行为 → 暂停并指出缺失信息
- Design Amendment 后仍缺少稳定 Test Seam → 报告未解决的 Design Gap，由调用方暂停当前阶段
- DAG 存在环形依赖 → 阻止并报告
- Task 无法由 fresh-context developer 独立理解 → 重新拆分或补足契约

### Idempotency
- Task 文件已存在 → 读取并更新，不创建重复定义
- 已有 `issue` 编号 → 保留并交给调用方核验，不重复发布

### Prohibited Actions
- 不按技术层拆分 Task
- 不为制造并行度而拆分 Task
- 不创建完成后不可工作的空壳 Task
- 不用 pre-refactor 包装搭框架、清理代码或预留扩展点
- 不把非阻塞关系写入 `Blocked By`
- `@architect` 不执行 `gh issue create`、`git push`、PR、merge 或 worktree 操作

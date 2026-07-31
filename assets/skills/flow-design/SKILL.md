---
name: flow-design
description: 技术方案设计 → 方案文档 + ADR（planning worktree + Planning PR）
---

# flow-design

基于 PRD 进行技术方案设计，architect 在 planning worktree 产出 CONTEXT.md + PRD + Design + ADR，
并由 `flow_control` 通过 Planning PR 合入形成 Planning Baseline。

## 核心：调用 flow_control

1. `flow_control{op:"planning-start"}` — 创建 planning worktree `.worktree/planning-<slug>`（architect 在此写文档）
2. 在 planning worktree 内产出：根 `CONTEXT.md` 术语更新 + `docs/prd/<title>.md` + `docs/dev/specs/<title>.md` + `docs/adr/<date>-<slug>.md`
3. `flow_control{op:"planning-pr"}` — 对 planning worktree 变更创建 Planning PR（合并后 = Planning Baseline）

worktree 创建与 Planning PR 创建均由内核工具完成，创建动作全部收敛到工具内。

## 设计约束

技术方案必须遵循以下原则：

1. **首选最简单方案** — 如果两个方案都能满足 PRD，选更简单的
2. **不引入不必要的新技术** — 不要因为"这个技术很流行"而使用它
3. **方案自检** — 每个设计决策必须能回答"为什么不用更简单的替代方案？"
4. **ADR 记录简化决策** — 如果选择复杂方案，必须在 ADR 中说明为何简单方案不够

## CONTEXT.md 术语

阅读项目根 CONTEXT.md（领域术语权威，已自动注入内容与 digest）；
设计中发现的新术语经用户确认后写入根 CONTEXT.md（术语权威）。

## Output
- `docs/dev/specs/<title>.md` — 技术方案
- `docs/adr/<date>-<slug>.md` — ADR 决议
- 根 CONTEXT.md 术语更新（如发现新术语）
- Planning PR（由 flow_control 创建）

## 后续
- **/tasks** — 基于设计方案拆解为 DAG 任务

## Contract

### Trigger
由 `/design` 命令或 `@dev-lifecycle` Phase 1 触发。

### Inputs
- `docs/prd/<title>.md` — 上游 PRD（来源：requirements 阶段产出）
- Flow Record 编号（来源：requirements 阶段产出）

### Preconditions
- `/requirements` 已完成 → PRD 与 Flow Record 存在
- requirements 基线已用户确认

### Procedure
1. 调用 `flow_control{op:"planning-start"}` 创建 planning worktree
2. 阅读 PRD、已有 ADR、根 CONTEXT.md 术语
3. 输出技术方案到 `docs/dev/specs/<title>.md`
4. 记录 ADR 到 `docs/adr/<YYYY-MM-DD>-<slug>.md`
5. 调用 `flow_control{op:"planning-pr"}` 创建 Planning PR

### Outputs
- 技术方案 + ADR（planning worktree 内）
- Planning PR（Planning Baseline 的一部分）

### Failure
- ADR 与已有决策冲突 → 记录冲突并标注
- Planning PR 创建失败 → 通知用户手动处理

### Idempotency
- 技术方案已存在 → 读取并更新
- ADR 已存在 → 不重复创建
- planning worktree 已存在 → 复用（工具校验分支一致性）

### Prohibited Actions
- 不绕过 flow_control 手工创建 worktree / Planning PR（由内核工具完成）
- 不跳过 ADR 兼容性检查
- 不直接 push 到默认分支

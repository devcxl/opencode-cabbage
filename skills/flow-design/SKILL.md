---
name: flow-design
description: 技术方案设计 → 方案文档 + ADR → Planning PR
---

# flow-design

基于 PRD 进行技术方案设计，产出方案文档与 ADR，并通过 Planning PR 合入形成设计基线。

## 核心流程

1. **创建工作分支**（在默认分支基础上）
   ```bash
   BASE=$(gh repo view --json defaultBranchRef --jq '.defaultBranchRef.name')
   git checkout $BASE && git pull origin $BASE
   git checkout -b "feat/<slug>-design"
   ```
2. **产出文档**：
   - 根 `CONTEXT.md` 术语更新（如发现新领域术语）
   - `docs/prd/<title>.md`（PRD 确认版）
   - `docs/dev/specs/<title>.md`（技术方案）
   - `docs/adr/<date>-<slug>.md`（ADR 决议）
3. **提交并创建 Planning PR**
   ```bash
   git add -A && git commit -m "docs: <slug> design baseline"
   git push -u origin "feat/<slug>-design"
   gh pr create --base $BASE --head "feat/<slug>-design" \
     --title "design: <slug>" --body "Planning Baseline for <slug>"
   ```
4. **合入基线**：PR 合并后即形成设计基线（Planning Baseline），后续任务拆解以此为前置。

## 设计约束

技术方案必须遵循以下原则：

1. **首选最简单方案** — 如果两个方案都能满足 PRD，选更简单的
2. **不引入不必要的新技术** — 不要因为"这个技术很流行"而使用它
3. **方案自检** — 每个设计决策必须能回答"为什么不用更简单的替代方案？"
4. **ADR 记录简化决策** — 如果选择复杂方案，必须在 ADR 中说明为何简单方案不够

## CONTEXT.md 术语

阅读项目根 CONTEXT.md（领域术语权威，已自动注入内容与 digest）；
设计中发现的新术语经用户确认后写入根 CONTEXT.md。

## Output
- `docs/dev/specs/<title>.md` — 技术方案
- `docs/adr/<date>-<slug>.md` — ADR 决议
- 根 CONTEXT.md 术语更新（如发现新术语）
- Planning PR（合入后 = 设计基线）

## 后续
- **/tasks** — 基于设计方案拆解为 DAG 任务

## Contract

### Trigger
由 `/design` 命令或 `@dev-lifecycle` Phase 1 触发。

### Inputs
- `docs/prd/<title>.md` — 上游 PRD（来源：requirements 阶段产出）
- Parent Issue 编号（来源：requirements 阶段产出）

### Preconditions
- `/requirements` 已完成 → PRD 与 Parent Issue 存在
- requirements 基线已用户确认

### Procedure
1. 基于默认分支创建工作分支
2. 阅读 PRD、已有 ADR、根 CONTEXT.md 术语
3. 输出技术方案到 `docs/dev/specs/<title>.md`
4. 记录 ADR 到 `docs/adr/<YYYY-MM-DD>-<slug>.md`
5. 提交并创建 Planning PR

### Outputs
- 技术方案 + ADR
- Planning PR

### Failure
- ADR 与已有决策冲突 → 记录冲突并标注
- Planning PR 创建失败 → 通知用户手动处理

### Idempotency
- 技术方案已存在 → 读取并更新
- ADR 已存在 → 不重复创建
- 分支已存在 → 检出后追加提交

### Prohibited Actions
- 不跳过 ADR 兼容性检查
- 不直接 push 到默认分支（写操作走分支 + PR）

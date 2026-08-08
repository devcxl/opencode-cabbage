---
name: flow-requirements
description: 渐进式需求澄清 → PRD → Parent Issue
---

# flow-requirements

通过渐进式需求澄清将松散想法凝固为 PRD，并创建 Parent Issue（Flow Record）作为后续阶段的权威来源。

## 核心理念：战争迷雾（Fog of War）

需求澄清不是一次性穷举——只定义**前沿**（当前可见的待决策问题），逐个解决，每解决一个迷雾推开一层，直到所有关键决策已定，PRD 自然成形。

## Phase A：创建决策映射

在 `docs/dev/decision-map.md` 创建映射，追踪所有待决策问题（Ticket 含 slug / Blocked by / Status / Type / Question / Answer）。初始只创建 2–4 个前沿 Ticket，不试图穷举。

Ticket 类型：Grilling（与用户对话澄清）/ Research（查文档）/ Prototype（低保真验证）。
Research 型 Ticket → 派发 `@agent-researcher` 加载 `flow-research` skill 产出调研文档后，据结论 resolved。

## Phase B：渐进式解决

- 每次只处理**一个**已解除阻塞的 Ticket；处理前 Claim（`Status: in-progress`）
- Grilling 型：**一次只问一个问题**，每个问题给出推荐答案，沿决策树分支深入
- 追问技巧："然后呢？"（第 3 层才触及本质）、"如果不做这个会怎样？"（验证优先级）、"谁来判断做对了？"（明确验收）
- 解决后 `Status: resolved` 并记录 Answer；检查是否有新问题浮现 → 追加 Ticket
- 循环直到所有前沿 Ticket 已 resolved

## Phase C：凝固为 PRD

从 Decision Map 的 Answer 提炼为 PRD，保存到 `docs/prd/<title>.md`。

## Phase D：创建 Parent Issue

用 gh 创建 Parent Issue（Flow Record），作为目标与验收标准的权威来源：

```bash
gh issue create --title "<英文功能标题>" --body "<目标 + 验收标准>"
```

标题使用英文功能短语（kebab-case），后续分支名、目录名以其为基准。

## CONTEXT.md 术语发现

需求澄清中发现的领域术语写入根 `CONTEXT.md`（术语权威）。发现新术语或冲突时暂停提问，用户确认后更新。

## Output
- `docs/dev/decision-map.md` — 决策映射（PRD 生成后可删除）
- `docs/prd/<title>.md` — PRD
- Parent Issue（Flow Record）

## 下一阶段
- **/design** — 基于 PRD 进行技术设计

## Contract

### Trigger
由 `/requirements` 命令或 `@agent-dev-lifecycle` 触发。

### Inputs
- 用户提供的功能描述（来自消息文本）

### Preconditions
- gh CLI 可用

### Procedure
1. 锚定核心问题，创建 Decision Map
2. 渐进式解决所有前沿 Ticket（Grilling / Research / Prototype）
3. 迷雾推至足够远 → 凝固为 PRD
4. 记录领域术语到 CONTEXT.md
5. 用 gh issue create 创建 Parent Issue

### Outputs
- `docs/dev/decision-map.md`
- `docs/prd/<title>.md`
- Parent Issue

### Failure
- gh 未认证 → 提示用户 `gh auth login` 后重试
- Issue 创建失败 → 记录错误，不阻塞 PRD 写入

### Idempotency
- Decision Map 已存在 → 从中断点继续
- PRD 文件已存在 → 更新而非覆盖
- Parent Issue 已创建 → 复用其编号而非重复创建

### Prohibited Actions
- 不跳过 Phase A 和 Phase B 直接输出 PRD
- 不一次问多个问题
- 不创建重复的 Parent Issue（复用已有编号）

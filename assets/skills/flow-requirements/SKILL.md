---
name: flow-requirements
description: 渐进式需求澄清 → PRD 输出 → GitHub Issue 创建
---

# flow-requirements

通过 Decision Map 驱动的渐进式需求澄清，将松散想法逐步凝固为 PRD 并创建 GitHub Issue。

## 核心理念：战争迷雾（Fog of War）

需求澄清不是一次性穷举——你无法在动手前预测所有问题。正确的方式是：

- 只定义**前沿**（当前可见的待决策问题）
- 逐个解决前沿问题，每解决一个，迷雾推开一层，新问题浮现
- 直到前沿推至足够远，所有关键决策已定，PRD 自然成形

## Prerequisites

- `/setup` 已完成（gh CLI 可用，docs 目录就绪）

---

## Phase A：创建决策映射

**目标**：把用户的松散想法转化为结构化的待决策问题清单。

### A1. 锚定核心问题

先问第一个问题，锁定需求的核心：

> "这个需求最终要解决什么问题？不做会怎样？"

不要同时问多个问题。得到回答后再继续。

### A2. 构建 Decision Map

根据回答，在 `docs/dev/decision-map.md` 创建决策映射。映射是一个紧凑的 Markdown 文件，用于追踪所有待决策问题。

**映射结构：**

```markdown
# Decision Map: <需求标题>

## <ticket-slug>: <问题简述>

Blocked by: <slug>, <slug>  （无依赖则省略此行）
Status: open
Type: Grilling | Research | Prototype

### Question
<一句话描述需要决策的问题>

### Answer
<解决后填写>
```

**规则：**
- `slug` 是 dash-case 短标识符，在映射内唯一，读起来像微型标题（如 `core-scenario`、`data-model`、`auth-strategy`）
- 初始只创建 2–4 个**前沿 Ticket**——即当前能直接开始解决的，不要试图穷举
- 前沿之外的问题暂时不写，等迷雾推开后再添加
- 有依赖关系的 Ticket，用 `Blocked by` 声明前置条件

**Ticket 类型：**

| Type | 用途 | 执行方式 |
|------|------|----------|
| **Grilling**（默认） | 需要和用户对话澄清的决策 | 见 Phase B - Grilling 方法 |
| **Research** | 需要查阅文档、API、代码库 | 调研 → 输出摘要 → 记录答案 |
| **Prototype** | 需要低保真原型来验证方案 | 创建原型 → 确认 → 记录答案 |

---

## Phase B：渐进式解决

**规则：**
- 每次只处理**一个**已解除阻塞的 Ticket（`Status: open` 且所有 `Blocked by` 的 Ticket 已 `resolved`）
- 处理前先 **Claim**：将 `Status` 设为 `in-progress`，保存映射
- 根据 Ticket 的 `Type` 选择执行方式
- 解决后将 `Status` 设为 `resolved`，在 `Answer` 中记录结论
- 每解决一个 Ticket，检查是否有新问题浮现 → 插入新 Ticket（标注 `Blocked by`）
- 循环直到所有前沿 Ticket 已 resolved

### B1. Grilling 型 Ticket 的执行方法

对 Grilling 型 Ticket，采用逐层拷问方法：

**核心原则：**
- **一次只问一个问题**。同时问多个问题会让人困惑。
- 沿决策树的每条分支逐一深入，逐个解决决策之间的依赖关系。
- **每个问题必须给出推荐答案**，不能只提问不表态。
- 得到用户反馈后再继续下一个问题。

**追问技巧：**
1. **"然后呢？"** — 前 2 个回答通常只是表面，追问到第 3 层才触及本质
2. **"如果不做这个会怎样？"** — 验证真实优先级
3. **"谁来判断这个做对了？"** — 明确决策者和验收标准
4. **"和现有功能的关系？"** — 发现隐藏的依赖和冲突
5. **"这个简单"或"这个以后再说"** — 标记为 out-of-scope，避免遗漏

**覆盖维度：**
每个 Grilling Ticket 在拷问过程中应覆盖以下维度（按需，不是每个都要问完）：
- 用户故事与业务价值
- 边界条件与异常场景
- 验收标准（追问到可验证的程度）
- 技术约束（语言/框架、部署环境、性能要求）
- 优先级：P0（必须）/ P1（重要）/ P2（锦上添花）

**结束条件：**
当用户对某个决策分支的回答不再引出新问题时，该分支已澄清完毕。标记 `Status: resolved`，填写 `Answer`。

### B2. Research 型 Ticket 的执行方法

1. 明确调研目标：需要回答什么问题？
2. 查阅相关文档、API 参考、代码库
3. 输出简短摘要到 `Answer`
4. 标记 `Status: resolved`

### B3. Prototype 型 Ticket 的执行方法

1. 明确验证目标：这个原型要证明什么？
2. 创建低保真原型（提纲、草图、桩代码）
3. 和用户确认方案是否符合预期
4. 结论写入 `Answer`，标记 `Status: resolved`

### B4. 迷雾检查

每解决一个 Ticket 后，检查是否推开迷雾：

- **有新问题浮现？** → 在映射末尾追加新 Ticket，标注正确的 `Blocked by` 边
- **之前的决策因此变更？** → 更新或标记相关 Ticket
- **前沿是否已推至足够远？** → 所有关键决策已定 → 进入 Phase C

---

## Phase C：凝固为 PRD

当所有前沿 Ticket 均已 `resolved`，且没有新的关键问题浮现时，将 Decision Map 凝固为 PRD。

### PRD 生成规则

不是凭空编写，而是从 Decision Map 的 `Answer` 中提炼：

1. 将每个 Ticket 的 `Question` + `Answer` 映射为 PRD 的对应章节
2. 补充：背景、非功能性需求、风险
3. 从 Grilling 过程中标记的 out-of-scope 项，记录到 `docs/dev/out-of-scope.md`

### PRD 文档路径

保存到 `docs/prd/<title>.md`。

### Out-of-Scope 记录

将在澄清过程中明确排除的需求记入 `docs/dev/out-of-scope.md`：
- 说明排除原因
- 便于后续回顾，避免重复讨论

---

## Phase D：创建 GitHub Issue

```bash
mkdir -p tmp
gh issue create \
  --title "<PRD Title>" \
  --label "enhancement" \
  --body-file docs/prd/<title>.md
```

---

## 多会话协作

如果需求澄清跨越多个会话，Decision Map 已持久化在 `docs/dev/decision-map.md`。后续会话：

1. 加载整个映射作为上下文
2. 找到第一个 `Status: open` 且已解除阻塞的 Ticket
3. Claim → 解决 → 迷雾检查 → 重复
4. 每个会话最多解决一个 Ticket，结束时输出下一步指令

**会话结束时的 Handoff 格式：**

> **Next steps** — N 个 Ticket 已解除阻塞: `<slug>`, `<slug>`
>
> 继续解决下一个已解除阻塞的 Ticket：
> ```
> /requirements ，继续推进 Decision Map（docs/dev/decision-map.md）
> ```

---

## Output

- `docs/dev/decision-map.md` — 决策映射（需求阶段临时文件，PRD 生成后可删除）
- `docs/prd/<title>.md` — PRD 文档
- `docs/dev/out-of-scope.md` — 排除范围记录
- GitHub Parent Issue

## 下一阶段

- **/design** — 基于此 PRD 进行技术设计

---

## Contract

### Trigger

由 `/requirements` 命令或 `@dev-lifecycle` Phase 0 触发。

### Inputs

- 用户提供的功能描述（来自消息文本）

### Preconditions

- `/setup` 已完成（gh CLI 可用，docs 目录就绪）

### Procedure

1. 锚定核心问题，创建 Decision Map
2. 渐进式解决所有前沿 Ticket（Grilling / Research / Prototype）
3. 迷雾推至足够远 → 凝固为 PRD
4. 记录 Out of Scope
5. 创建 Parent GitHub Issue

### Outputs

- `docs/dev/decision-map.md` — 决策映射
- `docs/prd/<title>.md` — PRD 文档
- `docs/dev/out-of-scope.md` — 排除范围记录
- GitHub Parent Issue

### Failure

- gh CLI 不可用 → 提示先执行 /setup
- Issue 创建失败 → 记录错误，不阻塞 PRD 写入

### Idempotency

- 如果 Decision Map 已存在 → 从中断点继续，不重新创建
- 如果 PRD 文件已存在 → 更新而非覆盖
- 如果 Parent Issue 已创建 → 追加评论而非重复创建

### Prohibited Actions

- 不跳过 Phase A 和 Phase B 直接输出 PRD
- 不一次问多个问题
- 不省略 Out of Scope 记录

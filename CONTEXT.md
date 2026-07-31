# opencode-cabbage

opencode-cabbage 提供一套从需求澄清到交付的软件开发流程，并以确定性内核约束高风险动作。

## Language

**Flow（流程）**:
从需求澄清到变更合并的一次完整开发过程。

**Stage（阶段）**:
Flow 中目标和完成条件明确的一个逻辑环节。
_Avoid_: 将 Stage 限定为 slash command

**Thin Kernel（薄内核）**:
对模型不应自由决定的高风险流程规则实施确定性约束的最小能力集合。
_Avoid_: 完整流程平台、纯 Prompt 流程

**Project Context（项目上下文）**:
目标项目持续维护的规范领域术语及术语关系。
_Avoid_: 会话上下文、插件内置术语表

**Project Profile（项目配置）**:
目标项目在 AGENTS.md 中确认的验证与发布约定。
_Avoid_: 插件通用默认值、流程执行状态

**Flow Record（流程记录）**:
描述 Flow 目标、验收条件并组织其 Task Records 的 GitHub Parent Issue。
_Avoid_: FlowRun JSON、Goal metadata

**Functional Slug（功能短语）**:
由 Flow 或 Task 所交付功能派生的稳定、可读、唯一的短标识符。
_Avoid_: Task 001、task-1、仅含序号的名称

**Task Record（任务记录）**:
描述单个可交付任务及其依赖、验收条件和执行状态的 GitHub Sub Issue。
_Avoid_: Task Markdown、manifest task、FlowRun task state

**Worktree Lifecycle（Worktree 生命周期）**:
一个 Flow 或 Task 的 Worktree 从创建、复用校验到安全销毁的完整过程。

**Planning Baseline（规划基线）**:
创建 Task Records 前已经确认并合并的需求、领域语言与技术设计集合。

**Release（发布）**:
将一个或多个已完成 Flow 的变更交付给使用者的独立人工流程。
_Avoid_: 每个 Flow 必经的 Stage

**Corrective Flow（纠正流程）**:
针对已合并回归，以恢复已确认行为为目标的轻量 Flow。
_Avoid_: 修改原 Flow 的完成历史

**Setup（初始化）**:
在首个 Flow 开始前建立项目流程运行前提的一次性准备过程。
_Avoid_: Flow Stage

## Relationships

- 一个 **Flow** 包含多个有序 **Stage**
- **Thin Kernel** 约束每个 **Stage** 中不可由模型自由决定的高风险动作
- 每个 **Stage** 读取 **Project Context**；确认的新术语和关系即时写回
- **Project Profile** 为 **Thin Kernel** 提供项目特定的验证与发布约定
- 每个 **Flow** 只有一个 **Flow Record**
- 每个可交付任务只有一个 **Task Record**
- **Flow Record** 和 **Task Record** 都使用英文功能标题，**Thin Kernel** 据此派生并校验 **Functional Slug**
- 一个 **Flow** 或任务的 **Functional Slug** 唯一确定其 **Worktree Lifecycle** 身份
- **Task Record** 是任务定义和执行状态的权威来源
- **Flow Record**、**Task Record**、关联 PR 和 Checks 共同构成工程进度的权威事实
- **Planning Baseline** 合并后才能创建对应的 **Task Records**
- 一个 **Corrective Flow** 链接导致回归的原 **Flow**，但不改变原 Flow 的完成状态
- 一个 **Release** 可以包含一个或多个已完成 **Flow**
- **Setup** 必须在项目的首个 **Flow** 之前完成

## Example dialogue

> **Dev:** “模型可以为任务直接填写 `Task 001` 并创建 Worktree 吗？”
> **Domain expert:** “不可以。模型描述任务交付的功能，薄内核据此确定 Functional Slug 并管理完整的 Worktree Lifecycle。”

## Flagged ambiguities

- “Context”曾同时表示会话上下文、插件内置术语表和目标项目领域词汇表；本流程中的 **Project Context** 专指目标项目维护的领域语言。
- “Stage”曾被限定为 slash command；现统一为逻辑环节，命令只是可能的触发方式。

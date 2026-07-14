---
name: flow-handoff
description: 打包上下文，跨会话传递进度
---

# flow-handoff

当上下文窗口压力过大或需要跨会话传递进度时使用。

## 何时使用
- 上下文窗口接近极限（约 80k+ tokens）
- 需要切换到另一个任务再回来
- 当前阶段等待外部输入无法继续

## Workflow

### 1. 打包当前状态
创建 handoff 文档，记录：

```markdown
# Handoff: <流程/阶段名>

## 上下文
- 项目: <项目名>
- 当前阶段: <stage>
- 已完成的工作: <列表>
- 未完成的决策: <列表>

## 关键产出
- <已产出的文件/Issue/PR 列表>

## 下一步
1. <下一步行动>
2. <需要用户输入的问题>

## 待办
- [ ] <待完成任务>
```

### 2. 保存 Handoff 文件
保存到 `docs/dev/handoff-<YYYY-MM-DD>.md`。

### 3. 指示用户
告知用户：在下次会话中可以直接引用该 handoff 文件以恢复上下文。

## Output
- `docs/dev/handoff-<date>.md`

## Contract

### Trigger
由 `/handoff` 命令触发。上下文窗口接近极限或需跨会话传递进度时使用。

### Inputs
- 当前 Goal 状态（来源：Goal metadata）

### Preconditions
- 存在 Active Goal

### Procedure
1. 打包当前流程状态（阶段、任务、进度）
2. 列出已完成和待完成项
3. 确定下一步骤
4. 保存到 handoff 文件

### Outputs
- `docs/dev/handoff-<date>.md` — 交接文件

### Failure
- 无 Goal → 仅输出当前会话摘要

### Idempotency
- 同一天多次执行 → 覆盖前一次 handoff

### Prohibited Actions
- 不修改代码或文档

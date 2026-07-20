---
name: flow-tdd
description: TDD Prompt 协议 — Phase A Advisory 层，定义 RED→GREEN self-reported 流程
---

# flow-tdd

TDD（Test-Driven Development）Prompt 协议，为所有编码阶段提供统一的 TDD 流程约束。
本 skill 是 TDD 协议的唯一来源，其他 skills 和 agents 通过引用本协议获得一致的 TDD 行为。

## Advisory Procedure

Phase A Advisory 层协议：Agent 自行遵循 TDD 流程并 self-report 状态，无需工具拦截。

### Cycle 状态机

```
            ┌─────────────┐
            │ cycle-start │ ← 开始新的 TDD 循环
            └──────┬──────┘
                   │
                   ▼
            ┌─────────────┐
            │    red      │ ← 编写/更新测试，验证测试失败（RED）
            └──────┬──────┘
                   │
                   ▼
            ┌─────────────┐
            │   green     │ ← 最小实现使测试通过（GREEN），可在此阶段重构
            └──────┬──────┘
                   │
        ┌──────────┼──────────┐
        ▼          ▼          ▼
   ┌─────────┐ ┌─────────┐ ┌──────────────┐
   │ 下一个   │ │ abandon │ │ 所有 cycle   │
   │ cycle   │ │ -cycle  │ │ 完成         │
   └─────────┘ └─────────┘ └──────┬───────┘
                                  │
                                  ▼
                          ┌──────────────────┐
                          │ final-regression │ ← 运行全部测试，确认无回归
                          └────────┬─────────┘
                                   │
                                   ▼
                          ┌───────────────────┐
                          │ final-verification│ ← 对照 acceptance_criteria 逐条验证
                          └───────────────────┘
```

### cycle-start

开始一个新的 RED→GREEN 循环。Agent 在开始实现前声明当前 cycle 的目标（要实现的测试/功能）。

**self-report 格式：**
```
## TDD cycle-start
- cycle: <序号>
- target: <本 cycle 要实现的功能/测试描述>
```

### red

编写或更新测试用例，验证测试在当前实现下失败。

**约束：**
- 测试必须有明确的 fail/pass 边界
- 测试运行命令必须与 `test_commands` 中定义的一致
- 记录测试失败输出作为 RED evidence

**self-report 格式：**
```
## TDD red
- test: <测试名称>
- command: <运行命令>
- result: FAIL（预期）
```

### green

编写最小实现使 RED 阶段编写的测试通过。可在此阶段进行局部重构（消除重复、改善命名等），但不应扩展范围。

**约束：**
- 只写使当前测试通过的最少代码
- 不新增与当前 test 无关的功能
- 重构仅限于当前 cycle 涉及的代码

**self-report 格式：**
```
## TDD green
- test: <测试名称>
- command: <运行命令>
- result: PASS
- changes: <涉及的文件列表>
```

### abandon-cycle

当发现当前 cycle 的目标不合理、设计有缺陷或需要回退时，废弃当前 cycle 的所有修改。

**触发条件：**
- RED 阶段发现测试设计有误
- GREEN 阶段发现需要根本性重新设计
- 发现更简单的替代方案

**流程：**
1. 放弃当前 cycle 的修改（`git checkout -- <files>` 或 `git stash drop`）
2. 记录 abandon 原因
3. 重新从 cycle-start 开始

**self-report 格式：**
```
## TDD abandon-cycle
- cycle: <序号>
- reason: <废弃原因>
```

### final-regression

所有 cycle 完成后，运行项目全部测试套件，确认无回归。

**约束：**
- 必须运行 `test_commands` 中定义的全部命令
- 所有测试必须通过
- 如有失败 → 修复（不要求新 cycle，但需记录修复内容）

**self-report 格式：**
```
## TDD final-regression
- passed: <通过的测试数>
- failed: <失败的测试数>
- total: <测试总数>
```

### final-verification

对照 Task 的 `acceptance_criteria` 逐条验证，确认全部满足。

**self-report 格式：**
```
## TDD final-verification
- criteria_total: <总数>
- criteria_met: <已满足>
- criteria_pending: <未满足>
```

## Runtime Procedure

> **Phase C 启用** — 以下为 Runtime Enforcement 协议占位，当前阶段不生效。
>
> Phase C 将引入 `tdd_checkpoint` 工具在运行时拦截 RED/GREEN 状态切换，
> 并将 evidence 写入 FlowRun 存储。Agent 不直接调用这些工具的时机和方式
> 由 Phase C 的 `tdd_checkpoint` 工具实现决定。

<!--
Phase C 启用后的 Runtime Procedure:
1. cycle-start → tdd_checkpoint({ stage: "cycle-start", task_id })
2. red → tdd_checkpoint({ stage: "red", evidence: test_output, task_id })
3. green → tdd_checkpoint({ stage: "green", evidence: test_output, task_id })
4. abandon-cycle → tdd_checkpoint({ stage: "abandon-cycle", reason, task_id })
5. final-regression → tdd_checkpoint({ stage: "final-regression", evidence: full_test_output, task_id })
6. final-verification → tdd_checkpoint({ stage: "final-verification", evidence: criteria_checklist, task_id })
-->

## Contract

### Trigger
由编码阶段（`flow-code`）自动触发。Agent 在开始编码任务时加载 `flow-tdd` skill 获取 TDD 流程约束。

### Inputs
- Task 定义中的 `acceptance_criteria`（来源：`flow-tasks` 产出）
- Task 定义中的 `test_commands`（来源：`flow-tasks` 产出）
- Task 定义中的 `verify_commands`（来源：`flow-tasks` 产出）
- Task 定义中的 `tdd` 配置块 — `mode`（`strict`/`advisory`）、`min_cycles`（来源：`flow-tasks` 产出）

### Preconditions
- Task 文件存在，包含 `acceptance_criteria`、`test_commands`、`tdd` 配置块
- 测试运行环境就绪（`npm install` 已完成）

### Procedure
1. 读取 Task 的 `acceptance_criteria`、`test_commands`、`verify_commands`
2. **Advisory Mode**：为每个验收标准识别对应的测试用例
3. 执行 `cycle-start` → 声明当前 cycle 目标
4. 执行 `red` → 编写测试，验证失败
5. 执行 `green` → 最小实现，验证通过
6. 重复 cycle 直到所有 criterion 覆盖
7. 执行 `final-regression` → 运行全部测试
8. 执行 `final-verification` → 逐条对照 acceptance_criteria

### Outputs
- 每个 cycle 的 self-report（提交到 commit message 或 PR body）
- `final-regression` 报告（测试通过/失败统计）
- `final-verification` 报告（criterion 覆盖情况）

### Failure
- RED 阶段测试意外通过 → 检查测试是否有意义，可能需要 abandon-cycle
- GREEN 阶段测试持续失败 → 检查实现逻辑，记录失败原因
- final-regression 失败 → 修复回归，不要求新 cycle
- final-verification 未全部满足 → 返回未完成的 criterion，补充 cycle

### Idempotency
- 同一 cycle 重复执行 → 以最后一次结果为准
- final-regression 重复执行 → 覆盖上次结果

### Prohibited Actions
- 不跳过 RED 阶段直接进入 GREEN
- 不跳过 final-regression 直接 commit
- 不在 abandon-cycle 后保留修改
- 不修改 `tdd` 配置块中的 `mode` 和 `min_cycles` 值

---
name: flow-tdd
description: 公共 Test Seam 上的行为 TDD — RED→GREEN 状态机 + self-report 证据
---

# flow-tdd

TDD（Test-Driven Development）Prompt 协议，为所有编码阶段提供统一的 TDD 流程约束。
本 skill 是 TDD 协议的唯一来源，其他 skills 和 agents 通过引用本协议获得一致的 TDD 行为。

## 核心原则

测试是行为规格：通过 Design `Testing Decisions` 约定的公共 Test Seam 验证可观察行为，而不是验证内部实现。只要公共行为不变，重构 Module 内部实现不应导致测试失败。

每个 TDD cycle 是一个最窄行为切片：

```text
确定 Test Seam 与一个行为
        ↓
写一个行为测试
        ↓
RED
        ↓
最小实现
        ↓
GREEN
        ↓
下一个行为
```

### 好测试

- 名称描述调用者或用户可以完成什么，而不是调用了哪个内部方法。
- 只通过约定的公共 Test Seam 触发并观察行为。
- 期望值来自 Acceptance Criteria、已知正确示例或其他独立来源。
- 实现重构但行为不变时仍然通过。

### 反模式

- **实现耦合** — 测试私有方法、内部协作对象、调用次数或调用顺序。
- **侧信道验证** — 绕过公共 Seam 读取数据库或内部状态来证明行为。
- **循环论证** — 用与实现相同的算法重新计算期望值。
- **水平批量** — 先写完全部测试再实现；应按一个行为测试 → 一个最小实现逐次推进。
- **为 mock 造抽象** — 仅允许在真实系统边界按既有 Interface 替换外部依赖，不为测试方便新增生产 Seam。

## Advisory Procedure

Agent 自行遵循 TDD 流程并 self-report 状态。测试质量由仓库 CI 把关，内核不强制证据。

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
            │   green     │ ← 最小实现使测试通过（GREEN），仅做局部行为保持整理
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
                          │ final-verification│ ← 对照 Acceptance Criteria 逐条验证
                          └───────────────────┘
```

### cycle-start

开始一个新的 RED→GREEN 循环。Agent 在实现前从 Design `Testing Decisions` 读取 Test Seam，并声明本 cycle 的一个可观察行为。

**self-report 格式：**
```
## TDD cycle-start
- cycle: <序号>
- behavior: <本 cycle 要交付的可观察行为>
- test_seam: <约定的公共 Test Seam>
- test: <通过该 Seam 验证行为的测试名称>
```

### red

编写或更新测试用例，验证测试在当前实现下失败。

**约束：**
- 测试必须有明确的 fail/pass 边界
- 测试名称描述行为，且只通过 cycle-start 声明的 Test Seam 触发和观察结果
- RED 必须因目标行为尚未实现而失败，不能把环境、语法或夹具错误当作证据
- 测试运行命令必须与 Task 的 `test_commands` 中定义的一致
- 记录测试失败输出作为 RED evidence

**self-report 格式：**
```
## TDD red
- test: <测试名称>
- command: <运行命令>
- result: FAIL（预期）
```

### green

编写最小实现使 RED 阶段的行为测试通过。可进行局部、行为保持的整理，但不得改变约定的 Test Seam 或扩展范围。

**约束：**
- 只写使当前测试通过的最少代码
- 不新增与当前 test 无关的功能
- 重构仅限于当前 cycle 涉及的代码
- 不为通过测试而暴露内部状态、增加仅供测试使用的生产接口或改成实现细节断言

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
- 必须运行 Task `test_commands` 中定义的全部命令
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

对照 Task 的 `Acceptance Criteria` 逐条验证，确认每项都由公共 Test Seam 上的行为测试或 `verify_commands` 证明。

**self-report 格式：**
```
## TDD final-verification
- criteria_total: <总数>
- criteria_met: <已满足>
- criteria_pending: <未满足>
```

## Contract

### Trigger
由编码阶段（`flow-code`）自动触发。Agent 在开始编码任务时加载 `flow-tdd` skill 获取 TDD 流程约束。

### Inputs
- Task 文件中的 `Builds` 与 `Acceptance Criteria`（来源：`flow-tasks`）
- Task frontmatter 中的 `test_commands` 与 `verify_commands`
- Design `Testing Decisions` 中约定的 Test Seam 与 Observable Result

### Preconditions
- Task 文件存在，包含 `Builds`、`Acceptance Criteria`、`test_commands`
- Design 已为目标行为定义公共 Test Seam；存量 Design 缺失时先向 primary 返回 Design Gap，由兼容门在当前 stage 补齐
- 测试运行环境就绪（worktree 内依赖已安装）

### Procedure
1. 读取 Task 的 `Builds`、`Acceptance Criteria`、`test_commands`、`verify_commands`。
2. 读取 Design `Testing Decisions`，确认目标行为的 Test Seam 与 Observable Result。
3. 选择一个尚未满足的行为，执行 `cycle-start` 声明 behavior、test_seam 与 test。
4. 执行 `red` → 只写该行为测试，验证因行为缺失而失败，记录 self-report。
5. 执行 `green` → 编写最小实现，验证通过，记录 self-report。
6. 按一个行为切片一个 cycle 重复，直到所有 Acceptance Criteria 被覆盖。
7. 执行 `final-regression` → 运行全部测试。
8. 执行 `final-verification` → 通过 Test Seam 或 `verify_commands` 逐条验证 Acceptance Criteria。

### Outputs
- 每个 cycle 的 self-report
- `final-regression` 报告（测试通过/失败统计）
- `final-verification` 报告（criterion 覆盖情况）

### Failure
- RED 阶段测试意外通过 → 检查测试是否有意义，可能需要 abandon-cycle
- RED 因环境、语法或夹具错误失败 → 修复测试基础设施，不能计为 RED evidence
- 只能通过内部实现观察目标行为 → 停止编码并向 primary 返回 Design Gap，不自行修改 Design、不回退 lifecycle stage
- GREEN 阶段测试持续失败 → 检查实现逻辑，记录失败原因
- final-regression 失败 → 修复回归，不要求新 cycle
- final-verification 未全部满足 → 返回未完成的 criterion，补充 cycle

### Idempotency
- 同一 cycle 重复执行 → 以最后一次结果为准
- final-regression 重复执行 → 覆盖上次结果

### Prohibited Actions
- 不跳过 RED 阶段直接进入 GREEN
- 不测试私有方法、内部调用次数、内部调用顺序或未约定的侧信道
- 不一次批量编写多个行为测试后再统一实现
- 不为了 mock 或测试方便新增生产抽象
- 不跳过 final-regression 直接 commit
- 不在 abandon-cycle 后保留修改
- 不伪造测试结果（实际运行命令后再 self-report）

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

## 设计语言

技术方案使用以下语言描述可测试设计：

- **Module** — 具有 Interface 与 Implementation 的模块，不限定为函数、类或包。
- **Interface** — 调用者正确使用 Module 必须知道的全部信息，包括输入输出、约束、错误与副作用。
- **Seam** — 可以通过 Interface 观察或替换行为的位置，也是测试验证行为的公共边界。
- **Adapter** — 在 Seam 处满足 Interface 的具体实现。
- **Depth** — Interface 越小、背后隐藏的有效复杂性越多，Module 越深。

设计时必须检查：

1. Interface 是否保持小而完整，并把复杂性留在 Module 内部，而不是泄漏给多个调用者。
2. 调用者与测试是否可以通过同一个 Seam 使用和验证行为。
3. 是否真的需要新的 Seam。一个 Adapter 只代表假设的 Seam；只有存在真实替换需求或多个 Adapter 时才引入抽象。
4. 是否出现只做透传的浅 Module、`FooService/FooServiceImpl` 式空壳抽象或为未来预留的 Interface。

## Testing Decisions

技术方案必须包含 `Testing Decisions`，在进入 Task Planning 前为每个关键行为明确：

```markdown
## Testing Decisions

### <behavior>

- Test Seam: <用于触发并观察行为的公共 Interface>
- Observable Result: <通过该 Seam 可观察的结果或错误>
- Test Level: <与仓库现有测试体系一致的最窄有效层级>
```

Test Seam 应描述公共行为边界，例如 Session API，而不是 `SessionRepositoryImpl.restore()` 等实现细节。优先复用现有 Seam；不要为了方便 mock 而创建生产抽象。

## 存量 Design Amendment

当 tasks、code 或 review 阶段发现旧技术方案缺少 `Testing Decisions` 时，调用方可以在**保持当前 lifecycle stage 不变**的前提下委派 `@architect` 补齐设计：

1. 读取 Design Gap、原技术方案、相关 PRD / ADR 与 repository context。
2. 优先识别仓库已有的公共 Interface 和测试惯例，不为了补字段创建新 Seam。
3. 只向原技术方案补充缺失行为的 `Testing Decisions`，不重写其他设计内容。
4. 返回已修改文件和补充的 behavior / Test Seam / Observable Result。

如果补齐过程暴露新的架构取舍或多个无法直接判断的 Seam 方案，停止 amendment 并把决策交给用户；不得静默扩大设计。Design Amendment 不回退 goal stage、不重复勾选阶段，也不单独创建新的 lifecycle 状态。

Design Amendment 是兼容子流程，覆盖本 skill 的普通发布流程：不创建 design 分支、Planning PR 或新 ADR。`@architect` 只修改技术方案，primary 负责在当前 stage 保存变更并把补充内容传给后续 agent。

## CONTEXT.md 术语

阅读项目根 CONTEXT.md（领域术语权威，已自动注入内容与 digest）；
设计中发现的新术语经用户确认后写入根 CONTEXT.md。

## Output
- `docs/dev/specs/<title>.md` — 技术方案（包含 Module / Interface 设计与 Testing Decisions）
- `docs/adr/<date>-<slug>.md` — ADR 决议
- 根 CONTEXT.md 术语更新（如发现新术语）
- Planning PR（合入后 = 设计基线）

## 后续
- **/tasks** — 基于设计方案拆解为 DAG 任务

## Contract

### Trigger
由 `/design` 命令、`@dev-lifecycle` Phase 1，或存量 Flow 的 Testing Decisions 兼容门触发。

### Inputs
- `docs/prd/<title>.md` — 上游 PRD（来源：requirements 阶段产出）
- Parent Issue 编号（来源：requirements 阶段产出）

### Preconditions
- `/requirements` 已完成 → PRD 与 Parent Issue 存在
- requirements 基线已用户确认

### Procedure
普通 design 流程：

1. 基于默认分支创建工作分支
2. 阅读 PRD、已有 ADR、根 CONTEXT.md 术语
3. 识别 Module、Interface 与真实 Seam，检查深度、局部性和抽象必要性
4. 为关键行为定义 Testing Decisions，明确公共 Test Seam 与可观察结果
5. 输出技术方案到 `docs/dev/specs/<title>.md`
6. 记录 ADR 到 `docs/adr/<YYYY-MM-DD>-<slug>.md`
7. 提交并创建 Planning PR

存量 Design Amendment 改用“存量 Design Amendment”章节的受限流程，不执行以上分支、ADR 与 Planning PR 步骤。

### Outputs
- 技术方案（包含 Testing Decisions）+ ADR
- Planning PR

### Failure
- ADR 与已有决策冲突 → 记录冲突并标注
- 关键行为没有稳定的公共 Test Seam → 暂停设计，先调整 Interface 或明确缺失决策
- Planning PR 创建失败 → 通知用户手动处理

### Idempotency
- 技术方案已存在 → 读取并更新
- 已有完整 `Testing Decisions` → 不重复 amendment
- ADR 已存在 → 不重复创建
- 分支已存在 → 检出后追加提交

### Prohibited Actions
- 不跳过 ADR 兼容性检查
- 不创建只有一个假设 Adapter、没有真实替换需求的 Seam
- 不以实现方法、私有协作对象或调用顺序作为 Test Seam
- 不直接 push 到默认分支（写操作走分支 + PR）

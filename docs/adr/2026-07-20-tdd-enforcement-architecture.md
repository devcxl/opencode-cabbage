# ADR 0008: TDD 强制约束架构 — Task-local PR Gate、三层约束模型与单 Orchestrator

**状态:** Proposed  
**日期:** 2026-07-20  
**上级:** [ADR 0001](/adr/0001-replace-openspec-with-full-flow)（全流程插件架构）、[ADR 0006](/adr/2026-07-15-prompt-contract-first)（Prompt Contract-first）、[ADR 0007](/adr/2026-07-15-flowrun-spike)（FlowRun 阶段性接入）

## 背景

当前 `canAutoMergeTask()`（`src/flowrun/merge.ts:91`）内部调用全局 `canMerge()`（`src/flowrun/gate.ts:113`），而 `canMerge()` 要求 `FlowRun.status` 为 `running` 或 `merging` **且** `review` Stage 为 `pass`。这造成两个问题：

1. **语义矛盾**：`dev-lifecycle` 在 `code` 阶段内逐 Task 创建 PR、审查、合并，但 `canMerge()` 前置要求 review Stage 已完成——时间顺序上 review 尚未发生，永远无法通过。
2. **阻塞依赖链**：Task A 合并前必须等待全局 review Stage 完成，而 review Stage 完成又等待所有 Task 完成——形成循环依赖，第一个 Task 永远无法合并。

此外，当前代码不存在结构化的 TDD 约束。Agent 通过 Prompt 接收 TDD 指引，但没有机器可验证的 evidence，也没有跨阶段（Task 完成、PR 创建、仓库 CI）的约束分层。

## 决策

### 1. Task-local PR Gate 与全局 Stage 解耦

**选择**：新增独立 `canMergeTaskPR()`，全局 `canMerge()` 退化为 Flow 收尾确认。

```text
v1（现状）:
  canAutoMergeTask → canMerge（要求 review Stage pass）
  → 单个 Task 无法在全局 review 前合并

v2:
  canMergeTaskPR（Task-local）  → 只检查该 Task 状态 + 该 PR checkpoints
  canMerge（全局，保留）        → 仅在所有 Task merged 后的 flow_run finalize 中使用
```

**`canMergeTaskPR()` 规则**：

| 条件 | 结果 |
|------|------|
| Task 状态 ≠ `reviewing` | 阻断 |
| 该 PR 的 TDD compliance ≠ `pass`/`waived` | 阻断 |
| 该 PR 的 CI required checks 未通过 | 阻断 |
| 该 PR 的 review 未 approved | 阻断 |
| Branch Protection 未启用 | 阻断 |
| `flow_pr merge` 执行前 remote head ≠ 验证时的 SHA | `--match-head-commit` 阻断 |

全局 `canMerge()` 保留但语义变更：只要求所有 Task 为 `merged`，不再要求 review Stage 为 `pass`。全局 Stage（review/test/merge）由 `flow_run finalize` 在 Task 全部合并后聚合写入，是审计层，不阻碍 Task 级合并。

**备选方案**：删除全局 `canMerge()`，只保留 Task-local Gate。  
**拒绝理由**：Flow 收尾仍需全局一致性确认，且现有仓库的 Branch Protection 检测依赖全局视角。

### 2. 三层 TDD 约束模型

**选择**：TDD 约束分离为三个独立层级，每层有明确的能力边界。

| 层级 | 执行位置 | 约束方式 | 证明边界 |
|------|----------|----------|----------|
| **Advisory** | Skill Prompt、Agent instruction | 模型遵循统一 TDD 协议 | Agent 收到了协议，不证明执行 |
| **Runtime Enforced** | `tdd_checkpoint` 工具、FlowRun Gate、Task evidence | RED→GREEN cycle evidence 存储 + Gate 阻断 + `flow_pr merge` 前置检查 | 插件在运行路径中强制了 TDD cycle |
| **Repository Quality** | GitHub Actions CI、Branch Protection required checks | 当前 PR head 的 test/verify/coverage 必须通过可信 CI | 当前 head 的测试质量，不证明历史 TDD 过程 |

**关键边界**：
- Runtime 层的 evidence（cycle、regression、verification）由 `tdd_checkpoint` 工具写入，Agent 直接调用。但若 Agent 与 broker 共用同一 GitHub 凭证，Runtime enforcement 只能称为**流程约束**，不能称为**可信仓库证明**。
- Repository Quality 层必须在 CI 上使用独立 GitHub App 或 Ruleset required workflow；Agent 不能自行发布同名 CI status 冒充。
- 三层之间不互相替代：Runtime RED/GREEN evidence 不能替代 CI test pass；CI pass 也不能替代 TDD cycle evidence。

**Advisory → Runtime 切换**：新 Task 默认 `enforcement: runtime`，但仅当凭证隔离就绪（Worker 无 GitHub 写凭证、broker 独立持 token）后才实际生效；否则降级为 advisory。

### 3. 单 Orchestrator 约束

**选择**：v2 明确只支持每个 FlowRun 一个活跃 orchestrator 进程。

**理由**：
- GitHub Issue body 不支持真正 CAS（Compare-And-Swap），无法实现跨进程原子写入。
- 当前 `writeFlowRunWithLock()` 仅在进程内做 keyed mutex，不提供跨进程隔离。
- 多 orchestrator 需要外部事务存储或 append-only event store，超出 v2 范围。

**并发规则**：
- 同一进程内按 Parent Issue 使用 keyed mutex 串行所有 FlowRun/Task/Evidence 写入。
- 并行 Subagent 的 evidence 更新通过同一 broker 排队。
- 检测到其他进程 revision 变化时暂停 FlowRun，要求人工恢复；不自动覆盖或合并。
- `flow_run start` 验证 Goal-FlowRun 绑定：已绑定其他 FlowRun 返回 `GOAL_FLOW_CONFLICT`。

## 后果

### 正向

- Task 可以在 code 阶段独立合并 PR，解除全局 review Stage 的循环依赖。
- 有依赖的 Task（如 Task B 依赖 Task A 合并后的产物）可以顺序推进，不等待所有 Task 完成。
- TDD 约束从口头协议升级为机器可验证的三层门禁，每层有明确的能力边界和不可互代的关系。
- 单 orchestrator 约束消除并发覆盖风险，简化实现和测试复杂度。

### 风险

- `canMergeTaskPR()` 与 `canMerge()` 共存期间需要确保两者不互调（`canMergeTaskPR` 不能调 `canMerge`），否则旧循环依赖未真正解除。
- 凭证隔离未就绪前，Runtime enforcement 实际降级为 advisory，但 Task policy 仍标记 `runtime`；需明确监控和审计此降级状态。
- 单 orchestrator 限制意味着多用户或多终端并发开发同一 Feature 时不支持；未来多实例支持需要重写持久化层。
- 仓库 CI 和 Branch Protection 需要使用者自行配置；插件检测到缺失时只能阻断自动合并，不能自动创建保护规则。

### 验证要求

- "两个有依赖 Task 的全链路测试"：Task A 先合并 PR，Task B 随后变为 ready 并合并，全程不触发全局 review Stage gate。
- `canMergeTaskPR()` 单元测试覆盖所有阻断路径。
- `flow_pr merge` 在 remote head 与 verified SHA 不匹配时被 `--match-head-commit` 阻断。
- 凭证隔离就绪前，Runtime enforcement 启动时检测到 ambient GitHub 写凭证，自动降级为 advisory 并记录原因。

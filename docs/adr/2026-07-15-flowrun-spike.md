# ADR 0007: FlowRun 先做接入 Spike，再决定完整接入

**状态:** Accepted
**日期:** 2026-07-15
**上级:** [ADR 0001](/adr/0001-replace-openspec-with-full-flow)

## 背景

`src/flowrun/` 模块（约 700 行，7 个子模块）实现了完整的状态机、Gate、Merge Checkpoint、审计追踪和弹性机制，但 `src/plugin/server.ts` 未引用任何 FlowRun 模块。当前运行时仅使用 Goal 系统（3 状态 active/paused/complete）做简单状态管理，实际编排能力远低于设计预期。

同时，文档（`docs/guides/architecture.md`、`docs/guides/configuration.md`）持续声称 FlowRun 是"全自动编排引擎"并已驱动流程，与代码真实状态矛盾。

## 决策

### 先做接入 Spike，再根据结果做最终决策

**Spike 目标**：
1. 验证 Goal 与 FlowRun 的状态边界——Goal 管理会话存活，FlowRun 管理 Stage/Task/Gate/PR Checkpoint
2. 实现 PoC 最小接入路径——能创建 FlowRun、能计算 Ready Tasks、Gate 正确阻止、Checkpoint 未通过时禁止 Merge
3. 评估接入成本——需要修改 server.ts 的事件处理、Goal 转换逻辑和 session metadata 结构

**Spike 范围**（PR5）：
- 在 `server.ts` 中接入 `createInitialFlowRun` 和 `readFlowRun`
- 在 `queueContinuation` 中注入 FlowRun 状态摘要（替代当前仅 Goal 状态）
- 实现 `canStartTask` 和 `getReadyTasks` 的实际调用
- 验证 `validatePRCheckpoints` 在合并路径中的可用性
- 不修改 Goal 系统的对外 API（goal tool 不变）

**评估标准**：

| 标准 | 阈值 |
|------|------|
| PoC 测试通过 | FlowRun 创建、Ready Tasks 计算、Gate 阻止、Checkpoint 拦截全链路 |
| 现有测试不回归 | 125 个测试全部通过 |
| 代码侵入性 | server.ts 增量 < 80 行，不重写事件循环 |
| 文档对账 | 如果决定暂缓接入，所有声称已驱动的文档必须修正 |

**最终决策选项**（Spike 后确定）：

| 选项 | 条件 | 后续 |
|------|------|------|
| A. 完整接入 FlowRun | PoC 通过 + 代码侵入可控 | 后续 Sprint 逐步接入所有阶段 |
| B. 重写后接入 | PoC 通过但架构不理想 | 设计新接入方案，保留 FlowRun 核心逻辑 |
| C. 删除 FlowRun，简化为 Goal 增强 | PoC 发现不可逾越的阻碍 | 删除 `src/flowrun/`，在 Goal 系统上扩展 |

### 在决策完成前，文档先纠偏

所有声称"FlowRun 已驱动自动编排"的文档（`architecture.md`、`configuration.md`）必须修改为"FlowRun 为设计中的编排引擎，当前编排由 Goal 系统 + Agent 协作驱动"。

## 后果

### 正向

- 基于证据而非假设做架构决策
- Spike 失败成本可控（一个 PR，可 revert）
- 文档与代码状态对齐，不再误导使用者

### 风险

- Spike 中发现的不可逾越障碍可能导致 FlowRun 被放弃，700 行代码成为沉没成本
- 如果选择重写后接入，需要额外的架构设计时间

## Spike 结果与最终决策（2026-07-15）

### Spike 验证结果

- ✅ `canStartTask`: 正确基于依赖状态和 FlowRun 状态控制任务启动
- ✅ `getReadyTasks`: 正确计算依赖全部 merged 且状态为 pending/ready 的任务
- ✅ `canStartStage` / `canCompleteStage`: 正确按阶段顺序控制
- ✅ `validatePRCheckpoints`: 正确验证 6 个检查点状态
- ✅ `canAutoMergeTask`: 正确基于 FlowRun 状态 + PR Checkpoint + Branch Protection 判断
- ✅ 141 个测试通过（16 个新增 + 125 个现有不回归）

### 最终决策：阶段性接入 FlowRun（Option A）

**接入范围**：
1. Continuation Prompt 注入 FlowRun 状态摘要（替代仅 Goal 状态）
2. PR 审查合并路径接入 `validatePRCheckpoints` 和 `canAutoMergeTask`
3. 不修改 goal tool 对外 API

**状态边界**：
- Goal：管理会话存活（active/paused/complete）
- FlowRun：管理阶段/任务/Gate/PR Checkpoint 细节
- 两者共存，Goal 是 FlowRun 的上层控制器

**不在本轮接入**：
- FlowRun 替换 Goal 成为唯一状态机
- 全自动阶段编排（由 Agent prompt 驱动阶段转换）
- FlowRun Issue 持久化自动写入

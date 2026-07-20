# TDD 集成技术方案 v2.1：运行时证据与分层质量门禁

> 状态：Draft（依据 v1 审查及 v2 读者测试重写）  
> 日期：2026-07-20  
> 兼容决策：ADR 0006（Prompt Contract-first）、ADR 0007（FlowRun 阶段性接入）  
> 实施状态：本文中的 Schema v2、运行时工具和受控 PR 操作均为拟新增能力，当前代码尚未实现。

---

## 一、结论与能力边界

本方案把“TDD 过程约束”和“最终代码质量门禁”明确分开：

| 能力 | 执行位置 | 能证明什么 | 不能证明什么 |
|------|----------|------------|--------------|
| TDD Advisory | Skill、Agent、Reviewer | Agent 收到了统一的 TDD 协议 | Agent 确实按顺序执行 |
| TDD Runtime Enforced | 专用工具、Task evidence、FlowRun Gate | 插件观察到有效的 RED→GREEN cycle，并在插件路径中阻断违规 Task/PR | 用户没有从插件外部绕过 |
| Repository Quality Enforced | GitHub Actions、required checks、Branch Protection | 当前 PR head 的测试和可选 coverage 通过 | 历史开发过程一定遵循 TDD |

**v2 的最终目标是：TDD 在插件运行路径中强制，当前 head 的测试质量在仓库中强制。**

只有引入凭证隔离的可信远程执行器或 GitHub App，并让其签发 TDD attestation，才能宣称“TDD Repository Enforced”。该能力不属于本方案实施范围，不能由本地 Agent 使用同一 `gh` 凭证发布一个同名 status 来冒充。

核心原则：

> Prompt 负责指导；专用工具负责采证；Task 保存权威证据；FlowRun Gate 负责阻断；CI 只负责当前 head 的测试与 coverage。

---

## 二、当前实现事实

以下事实决定了必须先接通运行时，再提升默认约束级别：

- `src/plugin/server.ts` 当前只驱动 Goal continuation，没有调用 FlowRun Gate。
- `canCompleteTask()` 当前只检查 Task 是否为 `running`。
- `TaskState` 只有 `testCommands` 和自由文本 `acceptance`，没有 TDD policy/evidence。
- `PRCheckpoints` 没有 TDD 或 coverage checkpoint。
- `CURRENT_SCHEMA_VERSION` 为 `1`，validator 不迁移或注入默认值。
- `assets/skills/` 没有随包发布的 `tdd` skill。
- Agent `capabilities` 只是描述性元数据；`server.ts` 只应用 `tools`。
- 当前 `writeFlowRunWithLock()` 是比较后写入，不是真正的跨进程 CAS。
- `test/plugin/server-flowrun.test.ts` 是纯函数 Spike，不代表生产调用链已接通。
- `canAutoMergeTask()` 依赖全局 `canMerge()`，但当前 `dev-lifecycle` 在 code 阶段内逐 Task 创建、审查和合并 PR，两者语义不一致。

因此，v2 不把新增纯 Gate 函数当作“已经强制”。只有真实 server 入口和外部副作用路径都接入 Gate 后，才能把 Task enforcement 从 `advisory` 切换为 `runtime`。

---

## 三、目标、非目标与已确认决策

### 3.1 目标

1. 新建 Task 默认 `mode: strict`。
2. `strict + runtime` 下，每个标记为 TDD 的验收条件都有有效 RED→GREEN cycle。
3. Task 完成前必须通过最终 committed-head regression。
4. PR 创建必须幂等，PR head 变化后旧验证自动失效。
5. Coverage 默认关闭，启用后作为独立质量门禁。
6. Schema v1→v2 可迁移、幂等、可诊断。
7. TDD 协议随 npm 包发布，不依赖外部 skill。
8. 支持 `relaxed` 和 `bypass`，但降级必须在 Task 启动前获得可信审批。

### 3.2 非目标

1. 不证明 Agent 的主观思考过程。
2. 不解析 git commit order。
3. 不用测试文件数、代码行数比例或 commit message 证明 TDD。
4. v2 首期只支持 Vitest strict adapter。
5. 不通过本地 Agent 凭证发布“可信 TDD status”。
6. 不在本方案中重写 Goal 或整个全局 Stage 模型。
7. 不自动修改使用者仓库的 Branch Protection。

### 3.3 已确认决策

| 决策项 | 结论 |
|--------|------|
| 新 Task 默认模式 | `strict` |
| Coverage | 默认关闭，显式配置后启用 |
| Commit order | 不作为证据 |
| Goal API | 保持 `create/get/pause/resume/cancel/complete` 对外形态 |
| 旧 v1 Task | 迁移为 `relaxed/bypass + advisory`，不追溯伪造 strict 合规 |
| Skill | 新增随包发布的 `flow-tdd` |
| 权威状态源 | Manifest 是启动前配置源；Task policy/evidence 是启动后的运行时权威源 |

---

## 四、模式、约束级别与判定真值表

### 4.1 Task TDD Mode

| Mode | 用途 |
|------|------|
| `strict` | 可自动验证行为；要求完整 TDD cycle |
| `relaxed` | 历史任务、测试框架暂不支持 strict adapter，或只要求回归测试 |
| `bypass` | 无可自动测试行为，例如纯视觉稿；必须提供替代验证和审批 |

### 4.2 Task Enforcement

Task 只使用两个 enforcement 值：

- `advisory`：缺失 evidence 产生 warning，不阻断。
- `runtime`：缺失 evidence 阻断 Task 完成、PR 创建和插件自动合并。

仓库级 CI/Branch Protection 是 FlowRun/仓库配置，不是单个 Task 的 enforcement 值，避免多个 Task 对同一仓库保护规则产生冲突。

### 4.3 判定真值表

| Mode | 必需配置 | Advisory 结果 | Runtime 通过条件 | 最终 evidence 状态 |
|------|----------|---------------|--------------------|--------------------|
| `strict` | runner、test/implementation patterns、至少一个 `verification: tdd` 的 criterion、test commands | 缺口记 warning | 每个 TDD criterion 都有有效 cycle；最终 regression 通过 | `pass` |
| `relaxed` | test commands、结构化 exception/approval | 缺口记 warning | 最终 regression 通过；不要求 cycle | `pass` |
| `bypass` | 结构化 exception/approval、替代验证 | 缺口记 warning | 替代验证完成；不要求 runner/cycle/regression | `waived` |

通用规则：

- `strict` 必须至少有一个 TDD criterion，且**所有** TDD criterion 均被 cycle 覆盖。
- `verification: regression` 的 criterion 由最终 regression 覆盖。
- `verification: manual` 仅允许 `bypass`，并需要审批引用。
- `bypass` 只豁免 TDD 专项条件，不跳过 Build、Review、Goal 或仓库 required checks。
- Task 启动后 policy 冻结，Worker 分支修改不能改变当前 Gate。

---

## 五、数据模型

### 5.1 结构化验收条件

```typescript
export interface AcceptanceCriterion {
  id: string
  description: string
  verification: "tdd" | "regression" | "manual"
}
```

自由文本无法机器关联 cycle。Schema v2 将 `TaskState.acceptance` 迁移为 `acceptanceCriteria`；新 Task 必须使用稳定 ID。

### 5.2 Policy

```typescript
export type TddMode = "strict" | "relaxed" | "bypass"
export type TddEnforcement = "advisory" | "runtime"

export interface TddRunnerPolicy {
  adapter: "vitest"
  baseCommand: string
  timeoutMs: number
  executionInputPatterns: string[]
}

export type TddApproval =
  | {
      kind: "planning-pr"
      repo: string
      prNumber: number
      reviewId: number
      approver: string
      mergedCommitSha: string
      policyDigest: string
    }
  | {
      kind: "issue-comment"
      repo: string
      issueNumber: number
      commentId: number
      approver: string
      commentBodyDigest: VersionedDigest
      policyDigest: string
    }
  | {
      kind: "legacy-migration"
      fromSchemaVersion: 1
    }

export type AlternativeValidation =
  | { validationId: string; kind: "command"; command: TaskCommand }
  | { validationId: string; kind: "manual"; description: string }

export interface TddException {
  reason: string
  alternativeValidation: AlternativeValidation[]
  approval: TddApproval
}

export interface ReworkApproval {
  reworkRevision: number
  kind: "refactor"
  headSha: string
  treeSha: string
  reviewerSessionId: string
  reviewerMessageId: string
  contentDigest: VersionedDigest
  policyDigest: string
}

export interface TddReworkEvidence {
  reworkRevision: number
  kind: "behavior" | "refactor"
  affectedCriterionIds: string[]
  status: "started" | "evidence-ready" | "pass" | "fail"
  startHeadSha: string
  approval: ReworkApproval | null
}

export interface TddPolicy {
  mode: TddMode
  enforcement: TddEnforcement
  runner: TddRunnerPolicy | null
  testFilePatterns: string[]
  implementationFilePatterns: string[]
  generatedArtifactPatterns: string[]
  exception: TddException | null
  source: {
    manifestPath: string
    revisionSha: string
  }
}
```

规则：

- focused test 命令由 adapter 根据冻结 policy 构造；请求不能传任意 shell command。
- `testFilePatterns` 应包含测试、fixture 和 snapshot。
- `implementationFilePatterns` 用于确认 GREEN 确实伴随生产行为变化。
- Runtime 对普通 approval 在线验证 repo、PR merged 状态或评论作者权限，并校验 `policyDigest`。
- `legacy-migration` 只由迁移器生成，不能由 Manifest 作者选择。

审批不只绑定 `TddPolicy`，而是绑定完整冻结契约：

```typescript
export interface FrozenTaskPolicyPayload {
  taskId: string
  acceptanceCriteria: AcceptanceCriterion[]
  testCommands: TaskCommand[]
  verifyCommands: TaskCommand[]
  tddPolicyWithoutApprovalAndRevision: unknown
  coveragePolicy: CoveragePolicy | null
  manifestPath: string
}
```

`policyDigest` 使用 `jcs-sha256-v1`：对 `FrozenTaskPolicyPayload` 执行 RFC 8785 JSON Canonicalization 后计算 SHA-256。排除 approval 和合并后才确定的 `source.revisionSha`，避免循环引用。Planning PR body/批准评论必须包含 `TDD-Policy-Digest: sha256:<digest>`。

Planning PR approval 必须满足：base 为默认分支、exact head 获得 `maintain/admin` 用户的 APPROVED review、reviewId/approver 可查询、合并 commit 包含 digest 对应的 Manifest。Issue comment approval同样校验 repo、作者权限、评论内容 digest 和 policy digest。

### 5.3 Command Evidence

```typescript
export type TddFailureKind =
  | "assertion"
  | "missing-behavior"
  | "infrastructure"
  | "timeout"
  | "unknown"

export interface VersionedDigest {
  algorithm: "sha256-content-v1" | "sha256-output-v1" | "git-tree-v1"
  value: string
}

export interface TddCommandEvidence {
  command: string
  testSelector: string | null
  exitCode: number | null
  failureKind: TddFailureKind | null
  testsCollected: number | null
  testsFailed: number | null
  startedAt: string
  finishedAt: string
  durationMs: number
  changedFiles: string[]
  outputDigest: VersionedDigest
  workspaceDigest: VersionedDigest
  executionInputDigest: VersionedDigest
  summary: string
}
```

### 5.4 Task Start 与 Cycle Evidence

```typescript
export interface TddTaskStartEvidence {
  status: "pending" | "pass" | "fail"
  headSha: string | null
  treeSha: string | null
  startedAt: string | null
}

export interface TaskExecutionBinding {
  branch: string
  baseSha: string
  startHeadSha: string
  worktreeId: string
  sessionId: string
}

export interface TddCycleEvidence {
  cycleId: string
  criterionId: string
  reworkRevision: number
  status: "started" | "red" | "pass" | "failed" | "abandoned"
  startWorkspaceDigest: VersionedDigest
  testFiles: string[]
  redTestDigest: VersionedDigest | null
  redAttempts: TddCommandEvidence[]
  greenAttempts: TddCommandEvidence[]
}

export interface TddRegressionEvidence {
  status: "pending" | "pass" | "fail" | "skipped"
  headSha: string | null
  treeSha: string | null
  reworkRevision: number
  runs: TddCommandEvidence[]
}

export interface FinalVerificationEvidence {
  status: "pending" | "pass" | "fail"
  headSha: string | null
  treeSha: string | null
  runs: TddCommandEvidence[]
}

export type AlternativeValidationEvidence =
  | {
      validationId: string
      kind: "command"
      status: "pass" | "fail"
      headSha: string
      treeSha: string
      reworkRevision: number
      evidence: TddCommandEvidence
    }
  | {
      validationId: string
      kind: "manual"
      status: "pass" | "fail"
      headSha: string
      treeSha: string
      reworkRevision: number
      reviewRef: string
      reviewer: string
      contentDigest: VersionedDigest
      policyDigest: string
      summary: string
    }

export interface TddEvidence {
  revision: number
  reworkRevision: number
  status:
    | "not-recorded"
    | "pending"
    | "in-progress"
    | "pass"
    | "fail"
    | "waived"
  taskStart: TddTaskStartEvidence
  cycles: TddCycleEvidence[]
  regression: TddRegressionEvidence
  verification: FinalVerificationEvidence
  alternativeValidation: AlternativeValidationEvidence[]
  reworks: TddReworkEvidence[]
  warnings: string[]
  updatedAt: string | null
}

export interface TaskCommand {
  command: string
  cwd: string
  timeoutMs: number
  env: Record<string, string>
}
```

`TaskState` 新增：

```typescript
export interface TaskState {
  // Schema v2 通过 Omit<TaskStateV1, "acceptance" | "testCommands"> 后重新定义以下字段
  acceptanceCriteria: AcceptanceCriterion[]
  testCommands: TaskCommand[]
  verifyCommands: TaskCommand[]
  executionBinding: TaskExecutionBinding | null
  tddPolicy: TddPolicy
  tddEvidence: TddEvidence
  coveragePolicy: CoveragePolicy | null
}
```

### 5.5 Coverage 与 PR 摘要

Coverage 与 TDD evidence 解耦：

```typescript
export interface CoveragePolicy {
  command: string
  threshold: number
  report: {
    format: "istanbul-json-summary"
    path: string
    metric: "lines"
  }
}

export interface CoverageEvidence {
  status: "pending" | "pass" | "fail"
  headSha: string
  actual: number | null
  threshold: number
  metric: "lines"
  reportDigest: string | null
  summary: string
}

export interface TddComplianceCheckpoint {
  status: "pending" | "pass" | "fail" | "waived"
  evidenceRevision: number
  reworkRevision: number
  headSha: string
  treeSha: string
  summary: string
}

export interface PRCheckpoints {
  // 现有字段保持不变
  tddCompliance: TddComplianceCheckpoint | null
  verification: FinalVerificationEvidence | null
  coverage: CoverageEvidence | null
  qualityContractDigest: string | null
}
```

- `null` 表示未配置或 legacy advisory 数据，不等于 `pass`。
- Runtime Task 必须具有非空 `tddCompliance`。
- PR head 变化后，两个派生结果均失效。
- `goalVerification` 继续表示 PR 级目标/验收检查，不表示最终 Flow Goal 完成，避免形成“合并前等待最终 Goal”的循环依赖；后续应改名为 `acceptanceVerification`。

仓库级配置单独存放在 FlowRun，不与单个 Task enforcement 混用：

```typescript
export interface RepositoryQualityPolicy {
  mode: "off" | "required"
  requiredChecks: Array<{
    context: string
    appId: number
    workflowPath: string
    workflowRef: string
    workflowBlobSha: string
  }>
}

export interface FlowRun {
  // 现有字段保持不变
  repositoryQualityPolicy: RepositoryQualityPolicy
}
```

---

## 六、权威源与生命周期

| 阶段 | 权威源 | 写入者 | 派生数据 | 失效事件 |
|------|--------|--------|----------|----------|
| Task 启动前 | 默认分支 Manifest | Planning PR | 无 | Manifest 新 revision |
| Task 启动事务 | Manifest + FlowRun | `flow_task start` | 冻结 policy、criterion | 启动失败则全部回滚 |
| Task 开发中 | `TaskState.tddPolicy/evidence` | `tdd_checkpoint` | Stage warning/summary | 同 Task evidence revision 变化 |
| PR 创建后 | Task evidence + remote head | `flow_pr create/verify` | PR TDD/coverage checkpoints | head SHA 变化 |
| Stage | Task 状态聚合 | FlowRun runtime | Stage summary | 任一 Task 状态变化 |
| Goal | FlowRun 终态 | goal tool 内部 Gate | Goal complete | FlowRun 出现 blocker |

Manifest 是启动前配置源；Task 启动后，冻结的 Task policy 是本次执行权威源。Stage 和 PR 只保存派生摘要，不复制原始 RED/GREEN evidence。

Goal 对外 API 不变，但内部 metadata 增加：

```typescript
export interface GoalFlowRunRef {
  repo: string
  parentIssueNumber: number
  flowRunId: string
}
```

`flow_run start` 使用当前 session context 原子绑定 `GoalFlowRunRef`：未绑定则写入；绑定同一 FlowRun 则幂等；已绑定其他 FlowRun 返回 `GOAL_FLOW_CONFLICT`。`goal.complete` 在存在引用时读取精确 FlowRun，缺失返回 `FLOW_RUN_NOT_FOUND`，非 `completed` 返回 `FLOW_RUN_INCOMPLETE`。

`flow_run start` 同时验证 Task DAG：Task ID 唯一、record key 与 ID 一致、所有依赖存在、禁止自依赖、全图无环。失败时 FlowRun 保持 `planned`，不启动任何 Task。

---

## 七、完整状态迁移与受控操作

### 7.1 状态迁移

| 操作 | 前置状态 | Gate | 成功状态 |
|------|----------|------|----------|
| `flow_run start` | FlowRun `planned` | Parent Issue、Manifest、前置文档有效 | FlowRun `running` |
| `flow_stage start` | Stage `pending` | `canStartStage()` | Stage `running` |
| `flow_stage complete` | Stage `running` | `canCompleteStage()` | Stage `pass` |
| `flow_task start` | Task `pending/ready`，code Stage `running` | `canStartTask()` + policy validation | Task `running`，policy 冻结，taskStart 初始化 |
| `flow_pr create` | Task `running` | `canCompleteTask()` + TDD evaluator + committed-head regression/verification | PR 已记录，Task `reviewing` |
| `flow_pr verify` | Task `reviewing` | remote head、TDD、coverage/CI | 刷新 PR checkpoints |
| `flow_pr rework` | Task `reviewing` | PR 未合并、变更类型和受影响 criterion 有效 | Task 回到 `running`，PR checkpoints pending |
| `flow_pr rework-complete` | Task `running` 且已有 PR | rework evidence + 新 head regression/verification | Task 回到 `reviewing` |
| `flow_pr merge` | Task `reviewing` | Task-local merge Gate | Task `merged` |
| `flow_run finalize` | 所有 Task `merged` | 聚合 Task/PR checkpoints | Stage 顺序收尾，FlowRun `completed` |

`tdd_checkpoint` 不负责启动 Task 或推进 Stage；它只在 Task 为 `running` 时更新 evidence。

`flow_task start` 从 ToolContext 和 Git 读取 branch、base SHA、start head、broker canonical worktree ID 与 session ID，写入 `executionBinding`。后续每个 evidence 操作都必须与该绑定匹配；路径参数和可变 Manifest 不能替代绑定。

普通 `flow_stage start/complete` 只允许 requirements、design、tasks，以及启动 code。code 的完成和 test/review/merge 的全部状态只能由 `flow_run finalize` 根据聚合证据写入；其他直接调用返回 `INVALID_TRANSITION`，防止绕过 Task-local Gate。

### 7.2 Task-local Merge Gate

当前 `canAutoMergeTask()` 依赖全局 `canMerge()`，无法支持第一个 Task 在全局 review Stage 完成前合并。

v2 必须新增独立 `canMergeTaskPR()`：

- 只检查目标 Task 为 `reviewing`。
- 检查该 PR 的 TDD、CI、Review、Branch Protection 和 acceptance checkpoints。
- 不要求全局 review Stage 已 `pass`。
- `flow_pr merge` 在执行副作用前重新查询 remote head，要求所有 head-bound checkpoints 与该 SHA 匹配，并使用 `gh pr merge --match-head-commit <verifiedSha>`；不匹配则置 pending 并要求 rework。

全局 `canMerge()` 只用于所有 Task PR 完成后的 Flow 收尾确认。该语义调整必须记录 ADR，并通过“两项有依赖 Task”集成测试：Task A 可先合并并解锁 Task B。

### 7.3 Flow 收尾

所有 Task 变为 `merged` 后，`flow_run finalize` 以幂等方式执行：

1. `code`：确认所有 Task 已完成 TDD/实现并合并，标记 `pass`。
2. `test`：聚合各 PR 的 regression、CI 和可选 coverage，标记 `pass`。
3. `review`：聚合 reviewer 与 acceptance verification，标记 `pass`。
4. `merge`：确认所有 `mergeResult` 通过，标记 `pass`。
5. 持久化 FlowRun `completed` 和 `completedAt`。

这些全局 Stage 是 Task-local PR 流程的聚合审计阶段，不再假装按时间先于每个 PR 合并。该语义属于 P0 ADR 的必选决策。

Goal completion 与 Issue 写入不做跨系统原子事务：只有 FlowRun `completed` 已成功持久化后，goal-verify 才能调用 `goal.complete`；若 Goal 写入失败，重试不会重复合并或修改 Stage。

### 7.4 PR 创建事务与幂等

Task 在开发和提交期间保持 `running`。顺序固定为：

```text
RED/GREEN cycles
  → refactor
  → final commit（worktree clean）
  → final-regression（记录 headSha/treeSha）
  → final-verification（执行 verifyCommands）
  → push
  → flow_pr create
  → Task reviewing
```

`flow_pr create`：

1. 执行无副作用 preflight。
2. 以 repo + head branch 查询已有 open PR。
3. 已存在则复用；不存在才创建。
4. 写入 `prNumber`、初始化 checkpoints，再把 Task 设为 `reviewing`。
5. 若 GitHub 创建成功但 FlowRun 写入失败，重试时通过 head branch 找回同一 PR并修复状态，不创建重复 PR。

验收必须覆盖：preflight 失败、PR 创建后持久化失败、重复调用、已有 PR 恢复和孤儿 PR 检测。

### 7.5 PR Rework

- remote head 的 tree SHA 与已验证 tree 相同，仅 commit metadata 改变：重新运行 final regression 后可绑定新 head。
- tree SHA 变化但未先调用 `flow_pr rework`：`flow_pr verify` 将 checkpoints 置为 pending 并阻断。
- `rework(kind="behavior")` 必须声明受影响 criterion；每个受影响的 TDD criterion 需要新 cycle。
- `rework(kind="refactor")` 不制造虚假 RED，但必须重新运行 regression，并取得绑定 reworkRevision、新 head/tree SHA 和 policyDigest 的 reviewer 批准。
- `flow_pr rework` 增加 `tddEvidence.reworkRevision`，并持久化 kind、affectedCriterionIds、startHeadSha 和状态；后续 cycle、regression 和 checkpoint 都携带该 revision，旧 cycle 不能冒充本轮 evidence。
- behavior rework 只要求 affected criterion 产生当前 revision 的新 cycle；未受影响 criterion 可沿用旧合规 cycle。
- refactor rework 通过 `review-record-rework` 写入当前 revision 的结构化 approval；broker 验证 reviewer message、新 head/tree 和 policyDigest。
- rework 完成后沿用现有 PR；`flow_pr rework-complete` 验证新 committed-head regression/verification 后将 Task 恢复为 `reviewing`。

### 7.6 受控工具协议

```typescript
export type FlowControlRequest =
  | { op: "run-start"; parentIssueNumber: number }
  | { op: "stage-start" | "stage-complete"; parentIssueNumber: number; stage: FlowStage }
  | { op: "task-start"; parentIssueNumber: number; taskId: string }
  | { op: "pr-create" | "pr-verify" | "pr-merge"; parentIssueNumber: number; taskId: string }
  | { op: "pr-rework-complete"; parentIssueNumber: number; taskId: string }
  | {
      op: "pr-rework"
      parentIssueNumber: number
      taskId: string
      kind: "behavior" | "refactor"
      criterionIds: string[]
    }
  | {
      op: "review-record-manual"
      parentIssueNumber: number
      taskId: string
      validationId: string
      reviewerSessionId: string
      reviewerMessageId: string
    }
  | {
      op: "review-record-rework"
      parentIssueNumber: number
      taskId: string
      reworkRevision: number
      reviewerSessionId: string
      reviewerMessageId: string
    }
  | { op: "run-finalize"; parentIssueNumber: number }

export type FlowControlResponse =
  | {
      ok: true
      flowRunRevision: number
      taskStatus?: TaskStatus
      prNumber?: number
    }
  | {
      ok: false
      flowRunRevision?: number
      error: { code: string; message: string; retryable: boolean }
    }
```

每个 op 都先执行无副作用 preflight；外部副作用只能在 preflight 通过后发生。重复请求按 FlowRun revision、Task 和 head branch 幂等处理。

---

## 八、TDD Evidence 工具

### 8.1 判别联合请求

```typescript
export type TddCheckpointRequest =
  | {
      op: "cycle-start"
      parentIssueNumber: number
      taskId: string
      cycleId: string
      criterionId: string
      testPaths: string[]
      testSelector: string
    }
  | {
      op: "red" | "green"
      parentIssueNumber: number
      taskId: string
      cycleId: string
    }
  | {
      op: "final-regression" | "final-verification" | "status"
      parentIssueNumber: number
      taskId: string
    }
  | {
      op: "alternative-command"
      parentIssueNumber: number
      taskId: string
      validationId: string
    }
  | {
      op: "abandon-cycle"
      parentIssueNumber: number
      taskId: string
      cycleId: string
      reason: string
    }
```

工具从调用上下文取得 repo/worktree，并验证 Task 的分支绑定；不接受自报 cwd 或 shell command。

手工替代验证不能由 Worker 自报。编排器通过统一命名的 `review-record-manual` 操作提交 reviewer session/message 引用；broker 读取原始消息，验证 reviewer agent、作者、内容 digest 和 policyDigest 后写入同一 `validationId` 的 `AlternativeValidationEvidence`。所有 command 型替代验证必须通过 `alternative-command` 执行冻结 `TaskCommand`。

两类替代验证都只能在 clean committed head 上记录，并绑定 `headSha/treeSha/reworkRevision`。任一值变化即失效；`flow_pr create` 和 `pr-rework-complete` 必须要求全部替代验证与当前 head 精确匹配。

### 8.2 Cycle 规则

#### `cycle-start`

- Task 必须为 `running`，criterion 必须存在且为 `verification: tdd`。
- `testPaths` 必须匹配 `testFilePatterns`。
- cycleId 首次调用创建记录；相同参数和 workspace digest 的重复调用返回原结果；其他重复调用报 `CYCLE_CONFLICT`。
- 保存 canonical workspace digest。

#### `red`

- 相对 cycle start，必须有测试文件变化。
- 所有变化都必须匹配 `testFilePatterns`。
- Vitest adapter 使用固定 base command 和 selector 执行测试。
- Adapter 以 argv 数组调用进程，selector 必须通过受限语法校验，不能拼接 shell 参数。
- 只有 Vitest 成功启动、收集到测试，且分类为 `assertion` 或目标代码 `missing-behavior` 的失败才算 RED。
- transform/config/dependency 错误、零测试、timeout 均分类为 infrastructure，不算 RED。
- 保存完整执行输入 digest：测试/fixture/snapshot、Vitest config、相关 package script、lockfile 以及 runner policy 声明的 `executionInputPatterns`。

#### `green`

- 必须已有有效 RED。
- 重跑 RED 记录的同一命令和 selector。
- RED 的完整执行输入 digest 必须不变；修改 config、package script、lockfile 或 selector 都必须 abandon 并重开 cycle。
- 相对 RED，必须至少有一个文件变化匹配 `implementationFilePatterns`。
- 测试退出码为 0 且执行到目标测试才算 GREEN。
- 相同 workspace digest 的重复调用幂等；修复失败后允许在同一 cycle 追加 attempt。

#### `abandon-cycle`

- 仅允许未通过 cycle。
- 保留审计记录但不计入 coverage。
- 若测试设计需要修改，必须 abandon 后新建 cycle，不能修改 RED 测试后继续原 cycle。

### 8.3 Final Regression

`final-regression` 必须在最终 commit 之后执行：

- worktree clean。
- 执行所有 `testCommands`，按清单顺序 fail-fast。
- 命令、cwd、timeout 来自冻结 Manifest；不接受临时覆盖。
- 成功后记录 `headSha = HEAD` 和 `treeSha = HEAD^{tree}`。
- 此后发生 commit，旧 regression 自动失效。
- push 不改变 SHA；`flow_pr create` 必须确认 remote head 等于 evidence head。

Cycle 使用包含未提交文件的 canonical content digest；最终 regression 使用 Git tree SHA。两者职责不同，不把“提交动作”误判为代码内容变化。

`relaxed` 使用同一 final-regression 协议。`bypass` 不运行 final-regression，但必须完成 exception 中的全部替代验证；全部通过后 evidence 才能变为 `waived`。

所有模式还必须执行 `final-verification`：在同一 clean committed head 上按顺序 fail-fast 运行冻结的 `verifyCommands`，并记录 head/tree SHA。命令为空时可标记 pass；命令非空时任何失败都阻断 PR create。这样即使 repository quality mode 为 off，bypass 也不能跳过项目定义的 build/typecheck/lint。

### 8.4 Canonical Digest

Cycle digest 计算规则固定为：

1. 只接受 worktree 内 repo-relative path。
2. 路径按 UTF-8 字节序排序。
3. 纳入文件类型、可执行位、原始文件字节和删除标记。
4. 拒绝逃逸 worktree 的 symlink。
5. 忽略 `.git/`、依赖目录、构建输出和 policy 明确声明的 generated artifacts。
6. tracked 和 policy 范围内 untracked 文件均纳入。

算法版本写入 evidence；算法变化必须升级版本，旧 digest 不跨版本比较。

### 8.5 错误码

首期至少包括：

- `FLOW_RUN_NOT_FOUND`
- `TASK_NOT_FOUND`
- `TASK_NOT_RUNNING`
- `POLICY_INVALID`
- `RUNNER_UNSUPPORTED`
- `CRITERION_NOT_FOUND`
- `INVALID_TRANSITION`
- `CYCLE_CONFLICT`
- `RED_EXPECTED_FAILURE`
- `RED_INFRASTRUCTURE_FAILURE`
- `GREEN_EXPECTED_PASS`
- `IMPLEMENTATION_CHANGE_REQUIRED`
- `TEST_CHANGED_AFTER_RED`
- `REGRESSION_FAILED`
- `COMMAND_TIMEOUT`
- `PERSIST_CONFLICT`

读取 API 必须区分“无 FlowRun”“Schema 不支持”“迁移失败”和“持久化冲突”，不能统一退化为 `null`。

---

## 九、Coverage 与 PR Head 验证

Coverage 不参与 RED→GREEN 判定，只在 committed PR head 上执行。

### 9.1 `flow_pr verify`

1. 查询 remote PR head SHA，不信任缓存。
2. SHA 不同但 tree SHA 相同：在隔离 checkout 中重新执行 regression/verification 并绑定新 head。
3. tree SHA 不同：将摘要置为 pending，并要求先执行 `flow_pr rework`；不能把旧 cycle 自动绑定到新代码。
4. rework 完成后，在新 committed head 上重新执行 regression/verification。
5. coverage 配置存在时执行 coverage command。
6. 生成绑定 head SHA 的 TDD compliance 和 coverage 摘要。

### 9.2 Coverage 安全规则

- report path 必须位于隔离 checkout 内，不能含 `..`，且不能是逃逸 symlink。
- 运行前删除旧 report；运行后要求本次新建。
- 只解析 `istanbul-json-summary` 的 `lines.pct`。
- 拒绝缺字段、NaN、`Unknown` 和范围外数值。
- Evidence 保存 actual、threshold、metric、report digest 和 head SHA。
- Coverage report 必须是 ignored/generated 文件，不参与 Git tree SHA。

---

## 十、Schema v2 与 Manifest 兼容

### 10.1 读取流程

```text
JSON parse
  → detect schemaVersion
  → migrate v1 to v2
  → validate v2
  → return FlowRunReadResult
```

```typescript
export type FlowRunReadResult =
  | { ok: true; data: FlowRun; migrated: boolean }
  | {
      ok: false
      code: "NOT_FOUND" | "INVALID_JSON" | "UNSUPPORTED_SCHEMA" | "MIGRATION_FAILED" | "VALIDATION_FAILED"
      errors: ValidationError[]
    }
```

### 10.2 v1→v2 逐字段迁移

| v2 字段 | v1 有测试命令 | v1 无测试命令 |
|---------|---------------|---------------|
| `acceptanceCriteria` | `legacy-1`，verification=`regression` | `legacy-1`，verification=`manual` |
| `testCommands` | 每个字符串规范化为 `TaskCommand(command, cwd=".", timeoutMs=120000, env={})` | `[]` |
| `verifyCommands` | `[]` | `[]` |
| `tddPolicy.mode` | `relaxed` | `bypass` |
| `tddPolicy.enforcement` | `advisory` | `advisory` |
| `runner` | `null` | `null` |
| test/implementation/generated/execution-input patterns | `[]` | `[]` |
| exception | legacy migration approval | legacy migration approval |
| source | `manifestPath="legacy:v1"`、`revisionSha="migration:v1"` | 同左 |
| evidence | 完整初始化，status=`not-recorded` | 完整初始化，status=`not-recorded` |
| `coveragePolicy` | `null` | `null` |

完整 evidence 默认对象：

- `revision = 0`
- `reworkRevision = 0`
- taskStart 为 pending/null
- cycles、alternativeValidation 和 reworks 为空数组
- regression 为 pending/null/空 runs
- verification 为 pending/null/空 runs
- warnings 包含 legacy migration 说明
- `updatedAt = null`
- `executionBinding = null`

已有 `PRCheckpoints`：

- 保留全部旧字段和状态。
- 新增 `tddCompliance = null`、`verification = null`、`coverage = null`、`qualityContractDigest = null`。
- legacy advisory Task 允许 null；不能据此升级为 runtime 合规。
- merged Task 不追溯验证；reviewing Task 按 advisory 继续，但审计提示证据缺失。

FlowRun 增加 `repositoryQualityPolicy = { mode: "off", requiredChecks: [] }`，避免迁移时意外启用仓库 Gate。

Legacy exception 完整默认值：

- `reason = "legacy schema v1 migration"`
- 有测试命令时，`alternativeValidation` 包含对应 command；无命令时包含 manual 描述“历史任务未记录自动验证”
- `approval = { kind: "legacy-migration", fromSchemaVersion: 1 }`

按 Task 状态处理：

- `pending/ready`：`flow_task start` 优先从当前默认分支的 v2 Manifest 刷新并冻结 policy；找不到有效条目时保留 legacy advisory。
- `running`：保留 legacy advisory，不伪造 taskStart；允许从当前状态继续并记录 warning。
- `reviewing`：保留 PR 和 legacy advisory，后续只做当前 head regression/Review。
- `merged`：只迁移数据，不追溯执行 TDD。
- `blocked`：保留 `blockedReason` 和 legacy advisory；恢复后按原启动状态处理，不能静默刷新已冻结 policy。
- `cancelled`：只迁移数据，禁止重新启动；重新开发必须创建新 Task。

其他规则：

- `CURRENT_SCHEMA_VERSION = 2`。
- 迁移纯函数幂等，不增加业务 revision。
- 高于 v2 的版本返回 `UNSUPPORTED_SCHEMA`。
- 缺失/非整数/小于 1 的 schemaVersion 返回验证错误。
- 读取时只做内存迁移；下一次合法写入才持久化 v2。

### 10.3 Manifest 命令语义

保留现有 `verify_commands`，新增 `test_commands`：

| 字段 | 用途 |
|------|------|
| `test_commands` | final regression 的自动行为测试；strict/relaxed 必需 |
| `verify_commands` | typecheck、build、lint、docs build 等通用 Task 验证 |
| `runner.base_command` | adapter 构造 focused RED/GREEN 命令 |

Manifest 的命令既支持字符串简写，也支持规范对象：

```yaml
test_commands:
  - command: npm test -- test/example.test.ts
    cwd: .
    timeout_ms: 120000
    env: {}
```

Adapter 在 Task 启动时统一规范化为 `TaskCommand[]` 并冻结；运行时不重新读取 Worker 分支中的 Manifest。

不得从任意 `verify_commands` 文本猜测哪些是测试命令。Legacy v1 FlowRun 使用已有 `TaskState.testCommands`；旧 Manifest 没有映射器时按 advisory 迁移。

### 10.4 新 Manifest 示例

```yaml
tasks:
  - id: task-example
    agent: backend
    expected_files:
      - src/example.ts
      - test/example.test.ts
    acceptance_criteria:
      - id: AC-1
        description: "合法输入返回规范化结果"
        verification: tdd
      - id: AC-2
        description: "项目类型检查通过"
        verification: regression
    test_commands:
      - npm test -- test/example.test.ts
    verify_commands:
      - npm run typecheck
    tdd:
      mode: strict
      enforcement: runtime
      runner:
        adapter: vitest
        base_command: npm test --
        timeout_ms: 120000
        execution_input_patterns:
          - package.json
          - package-lock.json
          - vitest.config.ts
      test_file_patterns:
        - "test/**/*.test.ts"
      implementation_file_patterns:
        - "src/**/*.ts"
      generated_artifact_patterns:
        - "coverage/**"
      exception: null
    coverage: null
```

Manifest→FlowRun adapter 填充 `source.revisionSha`。Task 启动后 Worker 修改 Manifest 不改变冻结 policy。

---

## 十一、并发、持久化与信任边界

### 11.1 单 Orchestrator 约束

GitHub Issue body 不支持真正 CAS。v2 Runtime 明确只支持每个 FlowRun 一个活跃 orchestrator 进程：

- 进程内按 Parent Issue 使用 keyed mutex 串行所有写入。
- 并行 Subagent 的 evidence 更新通过同一 broker 排队。
- `writeFlowRunWithLock()` 继续用于发现外部修改，但不再宣称跨进程原子。
- 检测到其他进程 revision 变化时暂停 FlowRun，要求人工恢复；不自动覆盖或合并同一 Task evidence。

未来多实例支持需要外部事务存储或 append-only event store，不在 v2 范围内。

### 11.2 凭证隔离

Bash permission 不能单独构成安全边界，因为可通过脚本、`curl` 或 `gh api` 绕过。

Runtime 要求：

- Broker 是独立凭证持有者；GitHub API token 不进入 Agent 进程环境。
- Worker shell 使用隔离的 `HOME`、`GH_CONFIG_DIR` 和 Git credential config，只获得允许 feature branch push 的最小 Git 凭证；Reviewer 不获得任何 GitHub 写凭证。
- 启动 Runtime enforcement 前检查环境变量、credential helper、`~/.config/gh` 等 ambient API 凭证；发现可用 GitHub 写凭证即拒绝启用 Runtime，保持 advisory。
- GitHub 写操作统一经 broker tools 执行。
- Broker 根据当前 agent/session、FlowRun 和 Task 状态授权。
- Plugin 通过受限子进程和 scrubbed env 确保 broker token 不传入 Agent shell；`shell.env` 只作为附加措施，不作为唯一隔离边界。
- Reviewer 显式拒绝 edit、bash、task 委派、goal 生命周期操作和 `tdd_checkpoint` 写操作。
- `AgentEntry` 增加正式 `permission` 解析并传递给 OpenCode config；`capabilities` 只用于 Lint 和文档。

本地 broker 与 Agent 共用同一凭证时只能称为流程约束，不能称为可信仓库证明。

---

## 十二、`flow-tdd` Skill 与协作协议

新增 `assets/skills/flow-tdd/SKILL.md`，作为 TDD Prompt 协议唯一来源，并遵循 ADR 0006 的八段 Contract。

### 12.1 Advisory Procedure

Phase A 尚无运行时工具时：

1. 根据 criterion 逐个执行 RED→GREEN。
2. 每轮运行 focused test，记录命令和结果摘要。
3. 最终 commit 后执行 test/verify commands。
4. 输出明确标记为 `self-reported advisory` 的摘要。
5. 不声称已生成机器可验证 evidence。

### 12.2 Runtime Procedure

Runtime 上线后：

1. `flow_task start` 冻结 policy。
2. 每个 TDD criterion 执行 `cycle-start → red → green`。
3. 错误测试使用 `abandon-cycle` 后重开，不篡改已记录 RED。
4. 完成实现和 refactor，创建最终 commit。
5. strict/relaxed 执行 `final-regression`；bypass 完成全部 alternative validation。
6. 所有模式执行 `final-verification`。
7. push 后调用受控 `flow_pr create`。
8. 返回结构化 evidence 摘要。

### 12.3 现有资产职责

- `flow-code`：worktree、委派、commit/push、受控 PR 操作。
- `flow-tasks`：生成 criterion、test/verify commands 和 policy。
- `flow-review`：检查 criterion coverage 和风险，不检查 commit order。
- backend/frontend：加载 `flow-tdd`，不复制状态机。
- reviewer：只消费编排器提供的 diff、PR metadata 和只读 evidence。
- dev-lifecycle：调用 broker tools，不直接执行 GitHub 写操作。

不新增 `/tdd` 命令；TDD 是 `/code` 和自动生命周期的内部协议。

### 12.4 发布包验收

除源目录测试外，Phase A 必须执行 `npm pack` smoke test：从 tarball 加载插件，确认 `assets/skills/flow-tdd/SKILL.md` 被发布、复制并可发现。

---

## 十三、CI 与 Repository Quality Gate

### 13.1 CI 职责

可信 GitHub Actions 只验证当前 PR head：

- `test_commands`
- `verify_commands`
- 可选 coverage

Branch Protection 要求这些 CI checks 后，可声明 `Repository Quality Enforced`。它不能替代 Runtime RED/GREEN evidence。

### 13.2 Runtime PR Verify

- `flow_pr verify` 查询 remote head。
- Runtime TDD checkpoint 必须绑定该 head。
- CI/coverage 状态必须来自不可由 Worker PR 修改的 GitHub Ruleset required workflow 或独立 GitHub App，而不是 Agent 自发同名 status。
- FlowRun 级 `RepositoryQualityPolicy` 只保存静态 context/App/workflow 身份；Task 命令 digest 不放入全局配置。
- 每个 PR 的 `qualityContractDigest` 使用 JCS+SHA-256 绑定该 Task 的 testCommands、verifyCommands 和 coveragePolicy；required workflow 从默认分支的不可变 Task 契约计算实际 digest，broker 按当前 Task 和 head 复核。
- Branch Protection/Ruleset 检查 context、预期 App、冻结 workflow blob SHA和当前 head SHA。
- 缺少保护规则或来源不匹配时，禁止自动合并，不静默降级。

### 13.3 `waived` 映射

- Runtime：有效 bypass 显示为 `tddCompliance.status = waived`。
- CI：仍运行通用 verify commands；有自动替代验证命令时一并运行。
- Branch Protection：只消费 CI success/failure，不消费本地 `waived` 状态。
- Reviewer 和审计报告必须展示 waiver 原因和 approval，不能显示为普通 strict pass。

### 13.4 `repositoryQualityPolicy.mode` 语义

- `off`：不增加本方案定义的 test/verify/coverage required contexts；现有项目的 CI、Review 和 Branch Protection Gate 保持原行为。
- `required`：额外要求 `requiredChecks` 中每个 context 均由配置的 `appId` 发布并通过。
- `required` 不允许空 `requiredChecks`；workflow 必须来自受保护默认分支或组织级 required workflow，PR 不得修改实际执行契约。
- 当前 `canAutoMergeTask()` 原本就要求 Branch Protection；迁移默认 `off` 不放宽也不加强该既有规则。
- 若仓库需要在无 Branch Protection 下工作，只能关闭自动合并并由人工处理，不能把缺失保护伪装为 Gate pass。

---

## 十四、分阶段实施 DAG

每个子阶段独立 PR，目标不超过 10 个文件。文件名是预算，不代表最终必须全部修改。

| ID | 内容 | 依赖 | 文件预算 | 独立验收 |
|----|------|------|----------|----------|
| P0 | ADR：Task-local PR Gate、证据边界、单 orchestrator | 无 | 2–3 | ADR 审查通过 |
| A1 | `flow-tdd` Advisory Contract + flow-code/tasks/review | P0 | 6–8 | prompt lint、skill tests |
| A2 | Agent 引用、权限声明静态 Lint、npm pack smoke | A1 | 6–8 | agent/lint/pack tests |
| B1 | Schema v2 类型、完整 migration、read result、DAG validator | P0 | 6–8 | migration fixtures、幂等/future schema/DAG 错误 |
| B2 | criterion + strict/relaxed/bypass 纯 evaluator | B1 | 4–6 | 真值表单元测试 |
| C1 | Canonical digest + Vitest adapter | B2 | 5–7 | fixture repo、失败分类测试 |
| C2 | `tdd_checkpoint` 状态机（内存存储） | C1 | 5–7 | cycle/retry/idempotency tests |
| C3 | 单进程 broker、Issue 持久化与冲突暂停 | C2 | 6–8 | 并行 Subagent 写入测试 |
| D1 | FlowRun/Stage/Task start 真实 server 接入 | B2、C3 | 6–8 | server 入口状态迁移测试 |
| D2 | 消费 C2 committed-head regression，幂等 PR create + reviewing 转换 | D1、C2 | 6–8 | 副作用/补偿测试 |
| D3 | remote head revalidation、rework + coverage | D2 | 6–8 | push/rebase/stale report tests |
| D4a | Agent permission 传递与隔离 Agent shell | A2、D2 | 5–7 | ambient credential/shell/子 Agent 绕过测试 |
| D4b | 独立 GitHub broker 与最小凭证 | D4a | 5–7 | API token 隔离与授权测试 |
| E1 | Task-local merge Gate，解除全局 `canMerge()` 耦合 | D3、D4b | 5–7 | 两个依赖 Task 的全链路测试 |
| E2 | GitHub Actions required checks 与 Branch Protection 检测 | E1 | 5–8 | trusted source、pending/fail/pass 测试 |
| E3 | Goal/FlowRun 终态绑定与文档同步 | E2 | 6–8 | Goal complete blocker、docs build |

默认切换规则：

- A1 完成后只启用 `strict + advisory`。
- A2、D1–D4b 和 E1 全部通过后，才把新 Task 默认 enforcement 切换为 `runtime`。
- E2 仅提升仓库当前 head 的质量约束，不升级 TDD 证明边界。

---

## 十五、关键验收场景

### 15.1 TDD Cycle

- RED 直接通过：拒绝。
- Vitest 配置/依赖错误：不得算 RED。
- RED 后修改测试再 GREEN：拒绝。
- RED 后无 implementation pattern 变化：拒绝。
- cycle 引用无关 criterion：拒绝。
- RED 与 GREEN 间修改 Vitest config、package script、lockfile 或 selector：拒绝。
- strict 缺任一 TDD criterion cycle：阻断。
- flaky test 重跑从 fail 到 pass但无实现变化：拒绝。
- abandon 后重开 cycle：保留审计且新 cycle 可继续。

### 15.2 Task/PR

- Task 未 start 直接写 evidence：拒绝。
- final regression 发生在 commit 前：PR preflight 拒绝。
- push 后 remote head 与 evidence 不一致：拒绝或重新验证。
- PR 创建后 FlowRun 写失败：重试复用原 PR。
- Task A 合并后解锁 Task B，不等待全局 review Stage。
- PR tree 变化但未进入 rework：旧 cycle 不得重新绑定。
- rework cycle/checkpoint revision 不匹配：拒绝。
- merge 前 head 与 verified SHA 不同：`--match-head-commit` 阻止合并。
- verifyCommands 失败：所有模式均阻止 PR create。
- 所有 Task 合并后 `flow_run finalize` 幂等完成全局 Stage 和 FlowRun；Goal 随后可重试完成。

### 15.3 Migration

- v1 有/无 testCommands 的 Task 均可迁移。
- v1 pending/running/reviewing/merged Task 均有 fixture。
- v1 非空 PR checkpoints 保留并补 null 新字段。
- v1 pending/ready 在启动时可刷新 v2 policy；running/reviewing/merged 保留 legacy advisory。
- v1 blocked 保留原因，cancelled 禁止重启。
- 重复迁移结果相同。
- future schema 与 malformed schema 返回不同错误。

### 15.4 Coverage/CI

- 旧 report、路径穿越、逃逸 symlink、Unknown/NaN 被拒绝。
- coverage 绑定当前 head。
- required check 来源不是预期 GitHub App：拒绝自动合并。
- required workflow 可被 PR 修改或 requiredChecks 为空：拒绝启用 required mode。
- bypass 仍需通用 CI 和 Review。

### 15.5 权限与并发

- Worker 不能通过 `gh`、`curl`、脚本或子 Agent 执行 GitHub 写操作。
- Reviewer 不能写 evidence 或委派可写子 Agent。
- Agent shell 检测到 ambient GitHub API 写凭证：Runtime enforcement 不启用。
- 同一进程并行 Task evidence 均保留。
- 检测到外部 orchestrator revision 变化时暂停，不覆盖。
- DAG 重复 ID、未知依赖、自依赖或环路：`flow_run start` 拒绝。

---

## 十六、影响范围

完整影响面包括但不限于：

### FlowRun

- `src/flowrun/types.ts`
- `src/flowrun/validator.ts`
- `src/flowrun/gate.ts`
- `src/flowrun/github.ts`
- `src/flowrun/merge.ts`
- `src/flowrun/audit.ts`
- `src/flowrun/index.ts`
- 新增 migration、TDD evaluator、Manifest adapter

### Plugin Runtime

- `src/plugin/server.ts`
- `src/plugin/goal.ts`
- `src/plugin/agents.ts`
- `src/plugin/prompt-lint.ts`
- 新增 TDD tool、broker、runner adapter

### Prompt 资产

- 新增 `assets/skills/flow-tdd/SKILL.md`
- 更新 flow-code、flow-tasks、flow-review
- 更新 dev-lifecycle、backend、frontend、reviewer

### 测试与文档

- Migration/evaluator/digest/adapter/tool/broker/server/PR/merge 集成测试
- Prompt、Agent、Skill、package smoke tests
- 新 ADR，以及 architecture/configuration/usage/contributing 同步

这些文件必须按第十四节 DAG 分批交付，不允许以一个大 PR 实现全部能力。

---

## 十七、风险与缓解

| 风险 | 缓解 |
|------|------|
| 非测试错误被误判为 RED | Vitest adapter 分类并要求成功收集测试 |
| 无实现变化的 flaky cycle | GREEN 强制 implementation pattern 变化 |
| 测试被弱化后制造 GREEN | RED test digest 必须保持不变 |
| regression 后再次 commit | 只接受 clean committed HEAD 的 regression |
| PR head 变化 | remote head 惰性复验，旧 checkpoint 失效 |
| Worker 自行降级 policy | 默认分支 policy + 启动时冻结 + policyDigest approval |
| PR 重试产生重复副作用 | 按 head branch 查询复用 + 补偿测试 |
| Issue body 并发覆盖 | 单 orchestrator + keyed mutex；外部冲突即暂停 |
| Bash permission 被绕过 | 凭证隔离 + broker；permission 仅作附加防线 |
| 本地 status 被伪造 | 不用本地 status 宣称 TDD repository proof |
| v1 数据被错误追溯 | legacy advisory migration + 明确 null checkpoints |
| coverage 报告陈旧或越界 | 隔离 checkout、删除旧报告、路径与 digest 校验 |
| Skill 未随包发布 | npm pack 安装后 smoke test |

---

## 十八、完成标准

### 可声明 “TDD Advisory”

- `flow-tdd` 已随 tarball 发布并可发现。
- 新 Task 生成结构化 criterion 和 strict policy。
- Worker/Reviewer 使用统一协议。

### 可声明 “TDD Runtime Enforced”

- FlowRun/Task 状态迁移已进入真实 server 调用链。
- Evidence 只能由受控工具写入。
- 每个 strict TDD criterion 均由有效 cycle 覆盖。
- final regression 和 final verification 绑定 clean committed head。
- PR create/merge 真实调用 Task-local Gate。
- 所有 Task 合并后，`flow_run finalize` 能持久化全局 Stage 和 FlowRun 终态。
- Goal metadata 绑定精确 FlowRun，非 completed FlowRun 不能完成 Goal。
- Worker 无 GitHub 写凭证，broker 执行受控副作用。
- 集成测试证明失败 Gate 不产生外部副作用。

### 可声明 “Repository Quality Enforced”

- GitHub Actions 在当前 head 运行 test/verify/coverage。
- Branch Protection 要求来自可信 App 的 checks。
- head 变化后必须重新运行 checks。
- 自动合并组合 CI、Review、Task TDD 和保护规则。

不得把 Repository Quality Enforced 宣传成 Repository TDD Proof。

---

## 十九、实施前置

1. 先新增 ADR，确认 Task-local PR Gate、单 orchestrator 限制和 TDD 证明边界。
2. 按第十四节 DAG 创建独立 Sub Issues。
3. 首期 strict runner 只实现 Vitest。
4. 在 D1–D4b、E1 全部验收前，默认 enforcement 保持 advisory。
5. E2 上线前必须确认目标仓库的 GitHub Actions 与 Branch Protection 能力。

本草案通过审查后，才进入 ADR 和任务拆解阶段。

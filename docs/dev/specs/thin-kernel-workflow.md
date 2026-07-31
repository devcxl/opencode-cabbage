# Thin Kernel + Project Context 工作流 — 技术方案

> 对应 PRD：`docs/prd/thin-kernel-workflow.md` · ADR：`docs/adr/0002-adopt-thin-workflow-kernel.md`
> 版本目标：`0.3.2 → 1.0.0`（major，不保留旧 Flow 双轨）

## 0. 结论先行

- 新建 `src/kernel/` 作为确定性薄内核（slug、记录、worktree、TDD、release、profile、context、session-index、5 个工具），`src/flowrun/` 的 cabinet 状态机整体退役，**只迁移纯函数**（state/adapter/digest/evaluator/merge 的部分/ci 的部分），其余删除。
- 5 个生命周期工具沿用现有 `tool()` 工厂 + `tool.schema` 注册方式（server.ts:183-235 为范式），工具内部用 `ctx.agent` + session 父子链做 caller 校验，与 config 级 `tools` 布尔双重门禁。
- 高风险 git/gh 写操作全部收敛到工具内执行（复用宿主 `gh auth`），Agent shell 不再清空 `GH_TOKEN/GH_CONFIG_DIR`（修 server.ts:543 缺陷），改为 permission 规则兜底：**allow 白名单只读 + deny 黑名单写操作（deny 置尾，最后匹配优先）**。
- 根 `CONTEXT.md` 通过 message transform（bootstrap/continuation/子 agent 首条消息）自动注入，按 mtime 缓存刷新。
- 删除清单见 §6：cabinet 写路径、broker、transitions/gate/migration/validator/resilience/coverage/audit、flow-handoff/flow-test、内置 context、session-state.json、out-of-scope.md。
- 实施按 11 批（18 个任务）DAG 推进，每批独立合入且测试保持绿色，最后一批做 adversarial 测试 + 1.0.0 发布。

---

## 1. 总体架构与目录布局

### 1.1 架构图

```
┌────────────────────────────────────────────────────────────┐
│ src/plugin/server.ts  （接线层：注册工具/注入 context/事件）  │
│  ├─ tools: setup_control flow_control task_control          │
│  │          tdd_checkpoint release_control goal              │
│  ├─ message.transform → CONTEXT.md digest 注入               │
│  ├─ event 处理 → continuation/进度检查/双 session             │
│  └─ config 注入 → agent 定义 + permission + tools 布尔        │
├────────────────────────────────────────────────────────────┤
│ src/kernel/  （确定性薄内核，无 prompt，全部可单测）           │
│  ├─ slug.ts        functional slug 派生与校验                 │
│  ├─ records.ts     Flow/Task Record CRUD + evidence comment  │
│  ├─ worktree.ts    worktree 生命周期（preflight 销毁）        │
│  ├─ tdd/           state.ts adapter.ts digest.ts evaluator   │
│  │                 （从 flowrun 迁移，纯函数不改）             │
│  ├─ review.ts      风险双层判定 + merge gate + CI 检查        │
│  ├─ release.ts     版本聚合/分类/提议 + tag 校验              │
│  ├─ profile.ts     AGENTS.md Project Profile 解析            │
│  ├─ context.ts     根 CONTEXT.md 发现/摘要/刷新              │
│  ├─ session-index.ts  parentIssue→session 轻量索引            │
│  ├─ util/mutex.ts  KeyedMutex（从 broker.ts 提取）            │
│  └─ tools/         caller.ts + 5 个工具工厂                   │
├────────────────────────────────────────────────────────────┤
│ src/util/  gh.ts shell.ts fs.ts paths.ts（保留，微调）       │
│ src/flowrun/  → 仅保留迁移中的纯函数，其余删除（§6）          │
└────────────────────────────────────────────────────────────┘
        │ gh CLI（宿主 auth，单套凭据）
        ▼
GitHub：Parent Issue=Flow Record · Sub Issue=Task Record
        PR + Checks = 进度权威 · 单 comment = TDD evidence
```

### 1.2 目标仓库文件约定

| 文件 | 角色 |
|------|------|
| 根 `CONTEXT.md` | 领域术语权威（R2，自动注入） |
| 根 `AGENTS.md` | 项目规则 + `## Project Profile` 区块（R9/R10） |
| `.opencode/opencode-cabbage/session-index.json` | Flow→session 轻量索引（替代 session-state.json） |
| `.worktree/<slug>/` | Task/Planning worktree（gitignored） |
| `docs/prd/ docs/dev/specs/ docs/adr/` | 规划产物（Planning Baseline 的一部分） |

---

## 2. 设计决策 1：5 个生命周期工具的实现与注册

### 2.1 注册方式（复用现有范式）

现有 `server.ts:183` `createFlowControlTool` 即范式：`tool({ description, args: { op: tool.schema.enum(...), ... }, execute })`。5 个工具以**工厂函数**形式放 `src/kernel/tools/<name>.ts`，在 `createOpencodeCabbage` 内实例化并注册：

```ts
// server.ts
import { createSetupControlTool } from "../kernel/tools/setup-control.js"
// ...
tool: {
  goal: goalTool,
  setup_control: createSetupControlTool(deps),
  flow_control: createFlowControlTool(deps),
  task_control: createTaskControlTool(deps),
  tdd_checkpoint: createTddCheckpointTool(deps),
  release_control: createReleaseControlTool(deps),
}
```

工具公共依赖 `deps`：`{ ghEnv?, projectDir, sessionIndex, context, profile, mutex }`。所有 gh 调用走 `src/util/gh.ts`（默认继承 `process.env` = 宿主 `gh auth`），**不建第二套凭据**（§8）。

### 2.2 caller 校验（工具内部 + config 双层）

`src/kernel/tools/caller.ts`：

```ts
export type CallerRole = "primary" | "developer" | "architect" | "reviewer" | "goal-verify"
export function resolveCaller(ctx: ToolContext, goalClient): Promise<CallerRole>
export function requireCaller(ctx, roles: CallerRole[], op: string): string | null  // 返回 null=通过，否则错误消息
```

- 判定：`ctx.agent` 为 agent 名；`ctx.sessionID` 无 parentID（通过 `goalClient.session.get` 检查）→ primary。
- 矩阵（PRD R4）：primary 全量；developer 仅 `tdd_checkpoint`（+ 本地 edit/commit，工具外）；architect 仅 planning worktree 文档（工具只读 status）；reviewer 只读（无工具）；goal-verify 额外允许 `flow_control {op:"complete-flow"}`。
- config 层第二道门：`configureLifecycleTools(config)`（仿 server.ts:45 `configureGoalTools`）把 5 个工具在全局 `config.tools` 置 false，按矩阵给各 agent 置 true/false。

### 2.3 各工具 args schema / op 枚举 / execute 逻辑

#### setup_control — 探测/校验/生成 workflow 草案

```ts
args: {
  op: enum(["probe", "generate-workflows", "confirm-profile"]),
  pr_title?: string,          // generate-workflows 用
  profile_overrides?: string, // confirm-profile 用（JSON，用户确认的覆盖项）
}
```

| op | execute 逻辑 |
|----|-------------|
| `probe` | 探测：git 可用、gh auth、remote、默认分支、`.github/workflows/` 是否存在 CI/release workflow、AGENTS.md 是否有 Profile 区块、CONTEXT.md 是否存在。输出 readiness 报告：`development-ready`（git/gh + Profile 确认 + TDD 命令可执行 + CI workflow + 默认分支保护）与 `release-ready`（额外版本规则 + release workflow）逐项布尔。 |
| `generate-workflows` | 缺失 CI/release workflow 时生成草案到 `.github/workflows/`（CI 为 PR check 触发；release workflow 按 Profile 的 release 规则生成占位），创建 `chore/setup-workflows` 分支 + commit + **Setup PR**（人工合入，工具内执行 push/PR 创建）。技术栈无关，不硬编码 npm（AGENTS.md 铁律）。 |
| `confirm-profile` | 用户确认后将 Profile 区块写入根 AGENTS.md（§9 格式），写回前先读后写（mutex 串行）。 |

响应统一 `{ ok, readiness?, error? }`。caller：primary。风险标记：high（生成 workflow + push）。

#### flow_control — Flow Record 生命周期（替代 FlowRun 状态机）

```ts
args: {
  op: enum(["create-flow", "status", "planning-start", "planning-pr",
            "stage-start", "stage-complete", "complete-flow", "cancel-flow", "takeover"]),
  title?: string,              // create-flow：英文功能标题（R3）
  parent_issue_number?: number,
  stage?: enum(["requirements","design","tasks","code","review"]),
  user_confirmed?: boolean,    // cancel/takeover 必须
}
```

| op | execute 逻辑 |
|----|-------------|
| `create-flow` | 校验 title（`validateTitle`，§3.1）→ 派生 slug → 检查 session-index 双 session（§10）→ `gh issue create` Draft Parent Issue（body 含目标/验收/阶段 checklist，label `cabbage:flow`）→ 写 session-index + 最小 goal（`{parentIssueNumber, status:"active", continuationCount:0}`）。 |
| `status` | 读 Flow Record body + `gh issue list --parent` 子任务 + 关联 PR checks → 汇总 JSON。 |
| `planning-start` | 创建 planning worktree `.worktree/planning-<slug>`（§4），architect 在此写文档。 |
| `planning-pr` | 对 planning worktree 的变更创建 Planning PR（合并 CONTEXT.md + PRD + Design + ADR = Planning Baseline）。 |
| `stage-start` / `stage-complete` | 更新 Parent Issue 的 stage checklist（label `cabbage:stage:<name>`）。前置门禁：requirements 基线须用户确认一次；design 完成后才允许创建 Task Record；高风险方案在 design 与 tasks 之间暂停确认。 |
| `complete-flow` | **仅 goal-verify 可调用**（caller 校验）且必须在独立 goal-verify 验证通过后：关闭 Parent Issue。 |
| `cancel-flow` / `takeover` | 受控取消（`user_confirmed: true`）；双 session takeover（§10，要求用户确认）。 |

caller：primary（除 `complete-flow` 外）。

#### task_control — Task Record + worktree + PR + merge（核心）

```ts
args: {
  op: enum(["create-task", "start-task", "submit-task", "submit-review",
            "merge-task", "cancel-task", "destroy-worktree", "status-task"]),
  title?: string,               // create-task：英文功能标题
  parent_issue_number?: number,
  task_id?: string,             // 内核派生 slug
  acceptance_criteria?: string, // JSON（create-task 用）
  pr_number?: number,
  risk?: "low" | "high",        // 模型初判（会被内核升级，只能升不能降）
  user_confirmed?: boolean,
}
```

| op | execute 逻辑 |
|----|-------------|
| `create-task` | `validateTitle` → slug → `gh issue create` Sub Issue（body 含 acceptance criteria、依赖、`Closes` 约定），关联 Parent。 |
| `start-task` | 前置门禁：Planning Baseline 已合并、依赖 Task 已 merged、并行数 < 5。`worktree-start`（§4）→ 记录干净基线 digest（`computeWorkspaceDigest`）→ 冻结 TDD policy（来自 Profile）→ 写 Task Record 状态。 |
| `submit-task` | **TDD 硬门禁**（§5.4）：evidence 不完整 → 拒绝创建 PR。通过后：从 worktree push 分支 → `gh pr create`（body 引用 Task Record + evidence comment 链接）→ 标记 reviewing。 |
| `submit-review` | 由 primary 提交 reviewer 的双轴审查结果：`gh pr review --approve/--request-changes`。reviewer 本身只读，不直接调用。 |
| `merge-task` | 合并门禁（§7）：CI checks 通过 + 分支保护存在 + 风险双层判定 + 高风险需非作者人类 approval → `mergeTaskPR(prNumber, verifiedSha)`（`--match-head-commit`，复用 flowrun/merge.ts）→ 关闭 Sub Issue → worktree 干净销毁（§4）。 |
| `cancel-task` / `destroy-worktree` | 受控取消 / worktree preflight 销毁（§4），均要求 `user_confirmed`（除非 PR 已合并且干净）。 |
| `status-task` | 读 Task Record + PR + checks 汇总。 |

caller：primary 全量；developer 不允许调用 task_control（无门禁绕过面）。

#### tdd_checkpoint — Runtime TDD 证据（复用 tdd-tool.ts）

op 枚举沿用现有 `src/plugin/tdd-tool.ts` 并扩展（PRD R6）：

```ts
args: {
  op: enum(["cycle-start","red","green","final-regression","final-verification",
            "abandon-cycle","status","not-applicable","exempt-request"]),
  parent_issue_number?: number,
  task_id?: string,
  cycle_id?: string, criterion_id?: string,
  test_paths?: string[], test_selector?: string,
  reason?: string,
}
```

execute 差异（相对现有 tdd-tool.ts）：
- **工具亲自执行** RED/GREEN：`executeRedCheck(policy, selector, worktreeDir)`（复用 adapter.ts），不再接受内联 evidence。
- RED 有效性三重校验：失败分类为 assertion/missing-behavior（`classifyVitestFailure`）+ **实现文件相对基线未变**（`computeWorkspaceDigest` 对比 start 基线，实现 patterns 内文件必须未变）+ 测试输入未偷换（executionInputDigest 与上次一致）。
- 证据写入 **Task Record 单个受控 comment**（`appendTddEvidence`，§5.3），comment 用 marker 包裹。
- `not-applicable`：纯文档变更豁免（由 primary 调用）；`exempt-request`：其他豁免必须用户批准（`user_confirmed`）。
- 内部仍复用 state.ts 纯函数：`startCycle/recordRed/recordGreen/recordFinalRegression/recordFinalVerification/abandonCycle`；合规判定复用 `evaluateTddCompliance`。

caller：developer + primary。

#### release_control — 版本/Release PR/tag（R9）

```ts
args: {
  op: enum(["propose-version","open-release-pr","merge-release-pr","monitor"]),
  proposed_version?: string,
  release_notes?: string,
}
```

| op | execute 逻辑 |
|----|-------------|
| `propose-version` | 聚合上一 tag 后 main 的全部 commit → 按 Profile 版本规则分类（breaking→major / feature→minor / fix·docs→patch；0.x breaking 也 major）→ 未分类 commit → 要求用户分类后重试 → 输出提议版本。 |
| `open-release-pr` | 固定顺序：release branch → 按 Profile 版本写规则更新版本 → 生成 Release Notes → Release PR（caller=primary，人工确认后）。 |
| `merge-release-pr` | CI + 人工批准 → merge → `git rev-parse` 校验 SHA → 打 tag push（按 Profile tag 格式）。 |
| `monitor` | 轮询项目 GitHub Actions release workflow run 至成功；瞬时失败 rerun；代码/配置/workflow 缺陷 → Corrective Flow + 新版本。 |

caller：primary（release 为人工流程）。

### 2.4 测试策略（工具级）

- 每个工具一个 `test/kernel/tools/<name>.test.ts`：mock `gh` executor（仿 flowrun/merge.ts 的 `setMergeGhExecutor`），断言 op 分发、caller 拒绝、错误码。
- `test/kernel/caller.test.ts`：caller 矩阵全组合。
- 现有 `test/plugin/tdd-tool.test.ts` 改为驱动新 tdd_checkpoint（inline evidence 模式保留为测试注入点）。

---

## 3. 设计决策 2：Worktree 生命周期管理（task_control 承载）

### 3.1 Functional Slug（R3）

`src/kernel/slug.ts`：

```ts
export function validateTitle(title: string): { ok: true; slug: string } | { ok: false; code: string; message: string }
export function deriveSlug(title: string): string   // 复用 util/paths.ts slugify，但更严格
export function branchFor(slug: string, type: "feat"|"fix"|"chore"|"docs"): string
export function worktreeFor(slug: string): string   // ".worktree/<slug>"
```

硬校验（拒绝）：
- 泛化/编号：`Task 001`、`task-1`、`implement-task`、纯序号、`fix-bug` 等（正则 + 停用词表）。
- 非法字符：非 `[a-z0-9-]` 之外字符、空标题、slug 过长（>60）。
- 未完成 Task 同名冲突：已存在未 merged 的 `feat/<slug>` 分支或 `.worktree/<slug>` → 拒绝并要求改标题（避免覆盖）。

### 3.2 创建（worktree-start）

`src/kernel/worktree.ts`，仅 `task_control/start-task` 与 `flow_control/planning-start` 内部调用（模型不可覆盖）：

```
BASE = gh repo view --json defaultBranchRef | defaultBranch
1. .worktree/<slug> 不存在 → git worktree add -b <branch> .worktree/<slug> <BASE>
2. 存在 → 校验：git -C .worktree/<slug> rev-parse --abbrev-ref HEAD == <branch>，不一致报错
3. 分支已存在未合并 → 报错（要求人工处理），不 --force
4. 记录干净基线：computeWorkspaceDigest(worktreeDir, profile.patterns)
```

### 3.3 销毁（preflight，无 --force）

继承 flow-review SKILL（assets/skills/flow-review/SKILL.md:87-131）的 preflight 规则，语义收紧：

| 场景 | 行为 |
|------|------|
| PR 已合并 && worktree 干净 | 自动销毁（`git worktree remove`，无 `--force`；`git branch -D` 远程已删除的本地分支） |
| PR 已合并 && worktree 脏 | **拒绝**销毁，暂停通知用户（不自动 `--force`） |
| Task 取消 / PR 未合并 | 人工确认（`user_confirmed: true`）且分支已推送（`git ls-remote` 校验）才可销毁 |
| worktree 不存在 | 幂等跳过 |

`destroyWorktree` 返回详细原因码：`DIRTY_WORKTREE` / `PR_NOT_MERGED` / `BRANCH_NOT_PUSHED` / `OK`。

### 3.4 测试

- `test/kernel/worktree.test.ts`：用 fixture 临时 git 仓库（真实 `git worktree`）覆盖创建/复用校验/脏销毁拒绝/未推送销毁拒绝/幂等。
- 坏路径：非法 slug、分支冲突、脏 worktree（adversarial，§12）。

---

## 4. 设计决策 3：Runtime TDD 硬门禁

### 4.1 复用的纯函数（从 flowrun 迁移，不改逻辑）

| 迁移源 | 迁移目标 | 复用点 |
|--------|---------|--------|
| `flowrun/state.ts`（451 行） | `kernel/tdd/state.ts` | `startCycle/recordRed/recordGreen/recordFinalRegression/recordFinalVerification/abandonCycle/createTaskEvidence` |
| `flowrun/adapter.ts`（350 行） | `kernel/tdd/adapter.ts` | `executeRedCheck/classifyVitestFailure/validateSelector/buildVitestArgs` |
| `flowrun/digest.ts`（354 行） | `kernel/tdd/digest.ts` | `computeWorkspaceDigest`（基线/防偷换校验） |
| `flowrun/evaluator.ts`（258 行） | `kernel/tdd/evaluator.ts` | `evaluateTddCompliance`（submit 门禁） |
| `flowrun/merge.ts` | `kernel/review.ts` | `mergeTaskPR`（--match-head-commit）、`checkBranchProtection`、`createRevertPR` |
| `flowrun/ci.ts` | `kernel/review.ts` | `checkRequiredChecks`（PR checks 门禁） |

依赖 `flowrun/types.ts` 中的 TDD 类型（`TddEvidence/TddCommandEvidence/VersionedDigest/AcceptanceCriterion/TddPolicy` 精简版）迁入 `kernel/types.ts`，FlowRun 专有类型删除。

### 4.2 Evidence 追加到 Task Record 单个 comment

`kernel/records.ts`：

```ts
export const EVIDENCE_MARKER_START = "<!-- cabbage-tdd-evidence:start -->"
export const EVIDENCE_MARKER_END = "<!-- cabbage-tdd-evidence:end -->"

export async function readTddEvidenceComment(issueNumber): Promise<{ id: number; body: string } | null>
// gh issue view --json comments → 找含 START_MARKER 的 comment（marker 外带 `revision:<n>`）

export async function appendTddEvidence(issueNumber, block: string): Promise<{ ok: boolean; revision: number; error?: string }>
// 无受控 comment → gh issue comment 新建；有 → 读原 body → marker 区间内 append → gh issue comment <id> --body
```

复用 `util/shell.ts escapeShellArg` 的转义方式（同 flowrun/github.ts:85）。comment 内容含：criterion、cycle、命令、exit code、failure kind、tree/digest、状态、revision。并发写由 `kernel/util/mutex.ts`（自 broker.ts 提取的 KeyedMutex）按 issueNumber 串行 + body 乐观锁（previousBody 比对，冲突重读重试 1 次）。

### 4.3 worktree-start 基线 + 工具亲执 RED/GREEN

- `start-task` 记录 `startWorkspaceDigest`（§4 基线）与 `implementationFilePatterns`。
- `tdd_checkpoint{op:"red"}`：工具在 worktree 内执行 `executeRedCheck`；通过 digest 对比确认 **实现文件相对基线未变**（变则拒绝 `IMPL_CHANGED_IN_RED`）且失败分类有效。
- `tdd_checkpoint{op:"green"}`：同一测试 selector（executionInputDigest 一致，防偷换）通过 + 实现文件有变化。
- `final-regression`：`recordFinalRegression` 要求至少一次全量测试运行且全过。

### 4.4 task-submit 检查 evidence

`task_control{op:"submit-task"}` 前置：

```ts
const compliance = evaluateTddCompliance(policy, evidence, criteria)
// 额外硬校验：
// - evidence comment 存在且 revision ≥ 1（kernel 亲自写入，防自报）
// - final-regression pass（relaxed）或 tdd criteria 全有 pass cycle（strict）
// - verification pass；not-applicable 需豁免记录
compliance.status !== "pass" && enforcement === "runtime" → 拒绝，返回缺失项清单
```

### 4.5 测试

- 迁移后的 `test/kernel/tdd/*.test.ts` 沿用现有 `test/flowrun/{state,adapter,digest,evaluator}.test.ts`（保留为规格，仅改 import 路径）。
- 新增 `test/kernel/records-evidence.test.ts`（comment 追加幂等/并发）、`test/kernel/tdd-gate.test.ts`（缺 RED/GREEN/regression 时 submit 被拒）。
- adversarial：缺 RED evidence 直接 submit、RED 阶段改实现文件、GREEN 换 selector（§12）。

---

## 5. 设计决策 4：删除清单

### 5.1 `src/` 删除/迁移表

| 文件 | 处置 |
|------|------|
| `flowrun/types.ts` | 删 FlowRun/Stage/Checkpoint/PRCheckpoints/Coverage/TddApproval 等专有类型；TDD evidence 类型迁 `kernel/types.ts` |
| `flowrun/github.ts` | 删写路径（`replaceFlowRunInBody/writeFlowRun/writeFlowRunWithLock/createInitialFlowRun`）；**保留只读** `extractFlowRunFromBody + readFlowRun` 迁 `kernel/legacy.ts`（仅用于旧 Flow 检测提示，§11） |
| `flowrun/broker.ts` | 删（cabinet 专属）；`KeyedMutex` 提取到 `kernel/util/mutex.ts` |
| `flowrun/transitions.ts`、`gate.ts` | 删（FlowRun 状态机） |
| `flowrun/migration.ts`、`validator.ts` | 删（v1→v2 迁移无意义）；legacy 检测只判 marker |
| `flowrun/resilience.ts` | 删（runtime/backpressure 平台化能力） |
| `flowrun/coverage.ts` | 删（coverage 门禁不在 PRD 范围内） |
| `flowrun/audit.ts` | 删 `buildStageAudit/buildMergeAudit`；`postPRComment` 迁 `kernel/records.ts` |
| `flowrun/merge.ts` | 保留 `mergeTaskPR/checkBranchProtection/createRevertPR` 迁 `kernel/review.ts`；删 `canMergeTaskPR/validatePRCheckpoints/validateCheckpoint`（checkpoint 模型随 cabinet 删除） |
| `flowrun/ci.ts` | 保留 `checkRequiredChecks` 迁 `kernel/review.ts`；删 `validateRequiredWorkflow/computeQualityContractDigest` |
| `flowrun/state.ts adapter.ts digest.ts evaluator.ts` | **迁移**至 `kernel/tdd/`（纯函数不动） |
| `flowrun/index.ts` | 删（re-export 集线器不再需要） |
| `plugin/server.ts` | 重写接线层（§2/§8/§10） |
| `plugin/goal.ts` | 缩到最小 goal（§10.2）：删 `bindFlowRunRef/readFlowRunRef/checkFlowRunBlockers`、`verifyAgentPrompt` 简化 |
| `plugin/tdd-tool.ts` | 逻辑迁 `kernel/tools/tdd-checkpoint.ts` 后删除 |
| `plugin/broker.ts` | 删除（见上） |
| `plugin/agents.ts` | 删 `tools` 布尔 + `capabilities` 解析（已废弃死代码），保留 `permission` 解析 |
| `plugin/shell.ts` | 重写 `createIsolatedShellEnv`（§8.3 修正），删 `detectAmbientCredentials`（advisory 降级机制废弃） |
| `plugin/skills.ts` | 删 `_context`/`_prompts` 拷贝逻辑（内置 context 注入删除），仅安装 8 个 skill |
| `plugin/prompts.ts` `bootstrap.ts` | 保留；bootstrap 内容重写（§7.3） |
| `plugin/commands.ts` | 保留；命令裁剪为 7 个（§7.3） |
| `util/paths.ts` | 删 `devHandoffDir/outOfScopePath`，加 session-index 路径 |

### 5.2 `assets/` 与 docs 删除/迁移

| 文件 | 处置 |
|------|------|
| `assets/context/CONTEXT.md` | **删除**（内置 Context 注入机制废弃，R2） |
| `assets/skills/flow-handoff/`、`flow-test/` | **删除**（R12） |
| `assets/commands/handoff.md`、`test.md` | **删除**（R12，`/test` 仅为诊断命令，不进命令集） |
| `assets/agents/team/backend.md` + `frontend.md` | **删除**，合并为 `developer.md`（§7.1） |
| `assets/agents/dev-lifecycle.md` | **重写**（§7.2） |
| `assets/prompts/bootstrap.md` | **重写**：7 个 stage commands + @dev-lifecycle，去 handoff/test |
| `assets/templates/gitignore` | 保留（含 `.worktree/`） |
| `docs/dev/out-of-scope.md` | **删除**（Out of Scope 归属各自 PRD，R2） |
| `docs/dev/handoff/` | 目录约定移除；PR body 不再经 `docs/dev/handoff/pr-body.md`（task_control 自动生成） |
| `.opencode/opencode-cabbage/session-state.json` | **删除**，由 `session-index.json` 替代（§10） |

### 5.3 测试文件处置（保留测试作为规格）

- **保留并仅改 import**：`test/flowrun/{state,adapter,digest,evaluator}.test.ts` → 迁 `test/kernel/tdd/`。
- **保留部分**：`test/flowrun/merge.test.ts`（mergeTaskPR/checkBranchProtection 部分）、`test/flowrun/ci.test.ts`（checkRequiredChecks 部分）、`test/flowrun/github.test.ts`（只读 extract 部分，作 legacy 检测规格）。
- **随代码删除**：`test/flowrun/{types,migration,validator,audit,coverage,resilience,gate,finalize}.test.ts`、`test/plugin/broker.test.ts`、`test/plugin/server-flowrun.test.ts`（cabinet 路径）、`test/goal.test.ts` 的 FlowRun 绑定用例。
- 逐批删除保持剩余测试全绿（PRD 验收 7）。

---

## 6. 设计决策 5：Agent/Skill 收敛

### 6.1 backend+frontend → developer

`assets/agents/team/developer.md`（frontmatter 含 `permission`）：

```yaml
---
name: developer
description: 技术栈无关的实现 agent — 认领 Task Record，在 worktree 内 TDD 实现
mode: subagent
color: '#4caf50'
permission:
  bash:   # §8.2
    "*": "deny"
    "npm *": "allow"
    "git status*": "allow"   # …只读 git/gh 白名单…
    "git add*": "allow"
    "git commit*": "allow"
    "git push*": "deny"       # deny 置尾
  edit:
    "*": "deny"
    ".worktree/**": "allow"
---
```

body 要点：加载 `flow-tdd`；通过 `tdd_checkpoint` 提交证据；只读 git/gh 查状态；本地 `git add/commit`；**不 push、不创建 PR、不操作 Issue**（push/PR 由 primary 的 task_control 完成）。工程原则单份引用（不再内嵌三份拷贝）。

### 6.2 Skills 收敛为 8 个

目录：`assets/skills/{flow-setup,flow-requirements,flow-design,flow-tasks,flow-code,flow-tdd,flow-review,flow-release}/SKILL.md`。

引用关系（每个 skill 明确指向内核工具，不复制实现）：

```
flow-setup     → setup_control{probe,generate-workflows,confirm-profile}；Profile 区块格式
flow-requirements → flow_control{create-flow}；CONTEXT.md 术语发现
flow-design    → flow_control{planning-start,planning-pr}；architect 产出 CONTEXT.md+PRD+Design+ADR
flow-tasks     → task_control{create-task}；英文功能标题规范（R3）
flow-code      → task_control{start-task}；tdd_checkpoint 协议唯一来源引用 flow-tdd
flow-tdd       → tdd_checkpoint{...}；Runtime Procedure 替换原 Advisory 占位（flow-tdd/SKILL.md:146-162）
flow-review    → task_control{submit-review}；双轴审查 contract 单份
flow-release   → release_control{...}
```

`flow-tdd/SKILL.md` 的 Runtime Procedure 注释（146-162 行）改为实际协议：每个 stage 对应 `tdd_checkpoint` op。

### 6.3 Primary dev-lifecycle 重写要点

`assets/agents/dev-lifecycle.md`：
- 删除 FlowRun/broker 引用（Phase 4 "通过 broker tools" 等）。
- 编排全部通过工具：`flow_control`（create/status/stage/planning）→ `task_control`（create/start/submit/merge）→ reviewer 双轴 → goal-verify → `complete-flow`。
- goal 最小化：`goal({op:"create", objective, completion_criterion})` 只传标题，目标/验收从 Flow Record 读取。
- 删除重复编排文本（工程原则/goal-verify prompt/Review contract 各一份，全局唯一）。

### 6.4 命令收敛（7 个 stage commands）

`assets/commands/`：`setup.md requirements.md design.md tasks.md code.md review.md release.md`（删 handoff/test）。共享单一 contract：新增 `assets/prompts/stage-contract.md`，7 个命令模板统一引用（仿 setup.md 的"请加载 flow-setup 技能"）。

### 6.5 测试

- `test/skills.test.ts`：8 个 skill 存在 + 引用关系 lint（引用 skill 名在 8 集合内）。
- `test/plugin/prompt-lint.test.ts`：更新规则（无 backend/frontend 引用、无 handoff/test skill、无内置 context）。
- `test/agents.test.ts`：developer 加载、permission 解析。

---

## 7. 设计决策 6：权限模型

### 7.1 现状与缺陷

- `src/plugin/agents.ts` 解析 `tools` 布尔（已废弃）与 `permission` 对象；server.ts:524 传入 `tools: agent.tools ?? {...}`，:527 注入 `shell.env = createIsolatedShellEnv(agent)`。
- **缺陷**：`createIsolatedShellEnv`（shell.ts:159-179）把 `HOME` 换成临时目录、`GH_CONFIG_DIR` 置空、`GH_TOKEN/GITHUB_TOKEN` 清空 → Agent shell 内 `gh` 完全无凭据，**只读 gh 也失效**，与 PRD "模型可直接只读 git/gh" 冲突；同时 advisory 降级机制（detectAmbientCredentials + server.ts:491）已废弃。

### 7.2 落地规则（OpenCode permission 语义）

采用：**bash 模式规则（deny 置尾、最后匹配优先）+ 显式 allow 白名单 + deny 黑名单在 auto 模式仍生效**。

每个 agent 的 `permission.bash` 固定结构：

```yaml
permission:
  bash:
    "*": "deny"                # 兜底：auto 模式默认拒绝
    # ── allow 白名单（只读）──
    "npm *": "allow"
    "git status*": "allow"
    "git diff*": "allow"
    "git log*": "allow"
    "git show*": "allow"
    "git rev-parse*": "allow"
    "git ls-files*": "allow"
    "git branch --merged*": "allow"
    "gh pr view*": "allow"
    "gh pr diff*": "allow"
    "gh pr checks*": "allow"
    "gh issue view*": "allow"
    "gh run list*": "allow"
    "gh api rate_limit*": "allow"
    # ── 本地写（developer 专属）──
    "git add*": "allow"
    "git commit*": "allow"
    # ── deny 黑名单（写操作，置尾，最后匹配优先）──
    "git push*": "deny"
    "git worktree *": "deny"
    "git checkout -b*": "deny"
    "gh pr create*": "deny"
    "gh pr merge*": "deny"
    "gh pr review*": "deny"
    "gh issue create*": "deny"
    "gh issue edit*": "deny"
    "gh issue close*": "deny"
    "gh issue comment*": "deny"
    "gh label*": "deny"
    "gh release*": "deny"
```

- 高风险写操作只走工具（工具在插件进程内以宿主凭据执行 `util/gh.ts`），模型侧一律 deny。
- reviewer/goal-verify：只读白名单（无 `git add/commit`）；architect：白名单 + `edit: docs/**`（planning worktree 路径）。
- 工具级门禁（§2.2）与 permission 双保险：即便 permission 被绕过（工具误配），caller 校验仍拒绝。

### 7.3 修正 server.ts:543 注入（复用 gh auth，不建第二套凭据）

- `createIsolatedShellEnv` 重写为 `createAgentShellEnv(agent)`：
  - **不再**清空 `GH_TOKEN/GITHUB_TOKEN`、不再改 `HOME`/`GH_CONFIG_DIR`（保留宿主 `gh auth`，只读 gh 可用）。
  - 保留 `GIT_CONFIG_NOSYSTEM=1`（防系统 gitconfig 干扰）与 `GIT_TERMINAL_PROMPT=0`。
- 写操作凭据：插件进程 `util/gh.ts` 默认继承 `process.env`，即宿主 `gh auth`（hosts.yml），**唯一凭据源**；删除 broker 的 `#credentials` 通道（broker.ts:63-86）与 `detectAmbientCredentials`（shell.ts:130-143）。
- 若环境确需隔离写凭据（CI 场景），`deps.ghEnv` 仅注入插件进程内的 gh 调用，Agent shell 永不获得。

### 7.4 测试

- `test/plugin/shell.test.ts` 重写：断言 env 保留 GH 凭据、不再清空。
- 新增 `test/plugin/permission-model.test.ts`：验证生成的 `config.agent[].permission` 中 deny 置尾顺序、白名单完整性（枚举全部写命令均不在 allow 集合）。
- adversarial：`gh pr create`/`git push`/`git worktree remove --force` 在 auto 模式被拒（§12）。

---

## 8. 设计决策 7：根 CONTEXT.md 自动注入

### 8.1 注入点（server.ts）

| 注入时机 | 实现点 | 内容 |
|---------|--------|------|
| bootstrap（Primary 首次消息） | `experimental.chat.messages.transform`（server.ts:535，现仅 goal-active 注入 bootstrap） | bootstrap + **Project Context 块** |
| continuation | `queueContinuation`（server.ts:85）prompt 前 | Project Context 块 |
| 子 agent 派发 | 同一 message transform：对属于 Flow 的 session（session 索引命中 或 parentID 在索引中）在首条 user 消息注入 | Project Context 块 |
| 静态兜底 | 各 agent prompt 尾部统一加一句"读取项目根 CONTEXT.md，遵循其中术语"（developer/reviewer/architect/goal-verify） | 指针 |

### 8.2 kernel/context.ts

```ts
export interface ContextDigest { path: string; mtimeMs: number; digest: string; terms: string[] }
export async function getContextBlock(projectDir): Promise<ContextDigest | null>
// 发现：根 CONTEXT.md；缺失 → 返回 null（flow_control create-flow 时提示先建立）
// 摘要：文件 mtime 变化才重读；digest = sha256(file)；块格式：
//   ## Project Context (auto-injected)
//   来源: <path> · mtime: <iso> · digest: <sha256-16>
//   <全文（上限 N 行，超长截断并提示）>
// 刷新：mtimeMs 缓存 + 每次注入前 stat
```

CONTEXT.md 更新纪律（R2）：Requirements/Design 主动发现术语；Tasks/Code/Review 发现新术语或冲突 → **暂停提问**；仅用户确认后由 flow_control 更新（只写领域词汇与关系，不写需求/实现/执行状态）。

### 8.3 测试

- `test/kernel/context.test.ts`：发现/缺失、mtime 刷新、digest 稳定性、截断。
- `test/plugin/server-context.test.ts`：message transform 对 Primary/子 agent 注入、goal 未激活不注入。

---

## 9. 设计决策 8：AGENTS.md Project Profile 解析

### 9.1 自然语言 Markdown 区块格式

```markdown
## Project Profile

- test command: `npm test -- run`          # 唯一可执行命令（kernel 提取）
- test file patterns: `test/**/*.test.ts`
- implementation file patterns: `src/**/*.ts`
- tdd default mode: `strict`                # strict | relaxed | bypass
- version bump rule: `breaking→major, feature→minor, fix→patch`
- version file: `package.json`              # 版本读写规则（文件 + 路径，如 $.version）
- tag format: `v{version}`
- release workflow: `.github/workflows/release.yml`
- risk patterns: `migrations/**, **/auth/**, **/permissions/**`   # 可选，追加内核风险类别
```

### 9.2 kernel/profile.ts 解析规则

```ts
export function parseProjectProfile(markdown: string): ProfileParseResult
// 1. 定位 "## Project Profile" 标题（到下一个 ## 为止）
// 2. 逐行匹配 /^- ([a-z0-9 _-]+):\s*(.+)$/
// 3. 白名单 key 提取为结构化 ProjectProfile：
//    testCommand, testFilePatterns[], implementationFilePatterns[],
//    tddDefaultMode, versionBumpRule, versionFile, tagFormat,
//    releaseWorkflowPath, riskPatterns[]
// 4. 未知 key → warning（不阻断，prompt 可作指引）；重复 key → 取最后（文档语义）
// 5. 校验：testCommand 必须可由 shell 解析（bash -n 语法检查 + 首个 token 存在于 PATH）；
//    versionFile 存在且 JSON 可读；tagFormat 含 {version} 占位符
```

**薄内核只提取"确定命令"**（testCommand/patterns/workflow 路径等可机检字段），free-text 字段（如版本规则的自然语言描述）仅作提示，不进入内核判定——避免自然语言解析脆弱性。版本规则建议用 `versionBumpRule` 结构化键值（上表 9.1 已是键值对）。

### 9.3 写入与确认

- 由 `setup_control{op:"confirm-profile"}` 在用户确认后写回（prefer 追加到 AGENTS.md 末尾 `## Project Profile` 区块；已存在则替换整块）。
- 未确认 Profile 时 `development-ready/release-ready` 判定失败，`flow_control create-flow` 阻断并提示先 `/setup`。

### 9.4 测试

- `test/kernel/profile.test.ts`：合法区块解析、未知 key warning、重复 key 覆盖、非法命令拒绝、tag 占位符缺失拒绝、空区块。

---

## 10. 设计决策 9：会话索引与 Goal 最小化

### 10.1 session-index.json

路径：`.opencode/opencode-cabbage/session-index.json`（替代 session-state.json）。

```json
{
  "flows": {
    "12": {
      "sessionID": "sess_abc",
      "status": "active",            // active | paused | completed | cancelled
      "continuationCount": 3,
      "updatedAt": 1754000000000
    }
  }
}
```

`kernel/session-index.ts`：`readIndex/writeIndex/getFlowSession/bindSession/unbindSession`，写时 mkdir + 原子写（写临时文件再 rename）。continuation 计数由 server 事件更新（替代 goal.metadata.continuationCount 的唯一权威）。

### 10.2 Goal 最小化

`session.metadata.goal` 只保留：

```ts
interface MinimalGoal { parentIssueNumber: number; status: "active"|"paused"|"complete"; continuationCount: number }
```

目标与验收条件从 Flow Record（Parent Issue body）读取，`goal.ts` 删除 `objective/completionCriterion` 存储与 `bindFlowRunRef/readFlowRunRef/checkFlowRunBlockers`。

### 10.3 双 session 拒绝/takeover（R7）

- `flow_control{op:"create-flow"}`：索引中该 parentIssue 已有 `active` session 且 ≠ 当前 sessionID → 返回 `FLOW_SESSION_CONFLICT`（列出活跃 sessionID）。
- `flow_control{op:"takeover"}`：要求 `user_confirmed: true` → 旧 session 置 paused（`goal.status="paused"` 写入旧 session 元数据 + 索引更新）→ 新 session 绑定。
- continuation 无进展暂停（R7）：`queueContinuation` 前检查"可验证进展"——上次 continuation 后 Flow 相关 Issue/PR/commit 数是否变化；连续 3 次无变化 → `goal.status="paused"` + 通知用户；删除 generic `[skip]`（server.ts:587）。

### 10.4 测试

- `test/kernel/session-index.test.ts`：读写/原子性/双 session 冲突/takeover。
- `test/plugin/server-continuation.test.ts`：连续无进展 3 次暂停、有进展重置计数。

---

## 11. 设计决策 10：迁移与版本

### 11.1 版本路径（major 1.0.0）

- `package.json` `0.3.2 → 1.0.0`（breaking：架构/工具/命令全面变更）。
- 本仓库当前**无 `.github/workflows/`** → `/setup` 的 `generate-workflows` 会生成 CI workflow（PR check）与 release workflow 草案，经 Setup PR 人工合入后再执行发布。发布最终走**项目自己的 GitHub Actions release workflow**（AGENTS.md 铁律，不假设 npm）。
- Release Profile 探测 + 用户确认后写入本仓库 AGENTS.md `## Project Profile`（§9），`release_control` 依 Profile 执行。

### 11.2 旧 Flow 检测（不迁移）

`kernel/legacy.ts`（自 flowrun/github.ts 只读部分迁移）：

```ts
export async function detectLegacyFlowRun(parentIssueNumber): Promise<{ legacy: boolean; flowRunId?: string }>
// gh issue view body → 含 CABINET_START_MARKER/END_MARKER → legacy=true
```

- 触发点：`flow_control{op:"create-flow"}` 与 `status` 时检测。
- 行为：命中 → 返回 `LEGACY_FLOW_DETECTED`（提示"该 Issue 是旧版 FlowRun，请用旧插件版本 0.x 完成，新版本不自动迁移"），不创建新记录。

### 11.3 测试

- `test/kernel/legacy.test.ts`：marker 命中/未命中/畸形 body。
- `test/flowrun/github.test.ts` 只读部分保留为规格。

---

## 12. 设计决策 11：测试策略（adversarial 清单）

新增 `test/adversarial/`（每项 = 一个可独立运行的测试文件）：

| # | 对抗场景 | 断言 |
|---|---------|------|
| 1 | 坏 slug：`Task 001` / `task-1` / `implement-task` / 纯序号 / 非法字符 | `validateTitle` 拒绝 + `create-flow/create-task` 返回对应错误码 |
| 2 | 非法 worktree：分支已存在未合并 / 目录检出错误分支 | `worktree-start` 拒绝，不 `--force` |
| 3 | 缺 RED evidence 直接 submit | `submit-task` 拒绝（`TDD_EVIDENCE_INCOMPLETE`），不创建 PR |
| 4 | RED 阶段改实现文件（相对基线） | `tdd_checkpoint red` 拒绝 `IMPL_CHANGED_IN_RED` |
| 5 | GREEN 偷换 selector / 无实现变化 | `tdd_checkpoint green` 拒绝 |
| 6 | 直接 PR/merge（模型绕过工具）：`gh pr create`、`gh pr merge`、`git push`、`git worktree remove` | permission 规则在 auto 模式拒绝（mock config 断言） |
| 7 | 脏 worktree 销毁 | `destroy-worktree` 拒绝（`DIRTY_WORKTREE`），无 `--force` 路径 |
| 8 | 未推送分支 + 未合并 PR 的销毁 | 要求 `user_confirmed`，否则拒绝 |
| 9 | 工具 caller 越权：developer 调 `task_control`、reviewer 调写 op | `requireCaller` 拒绝 |
| 10 | 双 session 并发 | `create-flow` 返回 `FLOW_SESSION_CONFLICT`；takeover 需确认 |
| 11 | 旧 FlowRun 混入 | `detectLegacyFlowRun` 命中并阻断 |
| 12 | 高风险 diff 自动升级：改动 migrations/auth/permissions/release workflow/密钥 | 内核把 `risk: "low"` 升级为 high，merge 要求人类 approval |

测试基线：PRD 验收 7 —— 既有 468 测试（删除项随批移除）+ 上述新增全部通过；`npm run typecheck` 通过。

---

## 13. 设计决策 12：实施批次（DAG 依赖顺序）

每批独立合入、保持测试绿色；任务粒度参考 `docs/dev/tasks/tdd-enforcement/` 示例（frontmatter：name/depends_on/labels/worktree_root/expected_files/test_commands/acceptance）。

| 批 | 任务 | 内容摘要 | 依赖 | 变更类型 | 风险 |
|----|------|---------|------|---------|------|
| 0 | kernel-foundation | kernel/ 目录、types、slug、mutex 提取；flowrun 纯函数迁移骨架 | 无 | refactor | 中 |
| 1 | context-injection | kernel/context + server message transform 注入 + agent prompt 指针 | 0 | refactor | 中 |
| 2 | project-profile-parser | kernel/profile + Profile 区块格式 | 0 | new | 低 |
| 3 | session-index | session-index.json + goal 最小化 + 双 session | 0 | refactor | 中 |
| 4 | flow-record-layer | kernel/records（Flow/Task Record CRUD、evidence comment、labels、mutex 写入） | 3 | new | 中 |
| 5 | worktree-lifecycle | kernel/worktree 创建/复用/销毁 preflight | 4 | new | 高 |
| 6 | tdd-kernel-wiring | state/adapter/digest/evaluator 迁入 kernel/tdd + evidence append + 基线 | 4 | refactor | 高 |
| 7 | setup-control-tool | setup_control 三 op + caller | 2, 4 | new | 中 |
| 8 | flow-control-tool | flow_control（create/status/planning/stage/complete/cancel/takeover）+ legacy 检测 | 3, 4, 5 | new | 高 |
| 9 | task-control-tool | task_control（create/start/submit/merge/cancel/destroy） | 5, 6, 8 | new | 高 |
| 10 | tdd-checkpoint-tool | tdd_checkpoint 注册 + 工具亲执 RED/GREEN + submit 门禁 | 6, 9 | new | 高 |
| 11 | release-control-tool | release_control 四 op | 2, 4 | new | 中 |
| 12 | permission-model | shell env 修正 + agents.ts 清理 + caller 矩阵 + permission 白/黑名单 | 0 | refactor | 高 |
| 13 | developer-agent-merge | developer.md 合并，删 backend/frontend | 12 | refactor | 中 |
| 14 | skill-convergence | 8 skills + 删 handoff/test + 命令收敛 + bootstrap/stage-contract + prompt-lint | 13, 9, 10 | refactor | 中 |
| 15 | dead-code-removal | flowrun cabinet 写路径/broker/transitions/gate/migration/validator/resilience/coverage/audit 删除 + 测试随批清理 + 内置 context/out-of-scope 删除 | 8, 9, 10, 11, 14 | delete | 高 |
| 16 | adversarial-tests | §12 十二项对抗测试 | 9, 10, 12, 15 | test | 中 |
| 17 | release-1-0-0 | 1.0.0 版本 + release workflow 建立 + GitHub Actions 发布 | 16 | release | 高 |

> 批 7–11（5 个工具）理论可并行，但共享 caller/mutex/records，建议按 7→8→9→10→11 串行或两两合并开发，降低合并冲突。

---

## 14. 假设与不确定项

1. **planning worktree 归属**：PRD R4 仅说"architect 仅 Planning Worktree 文档"，未明确 planning worktree 由哪个工具管理；本方案归 `flow_control{planning-start, planning-pr}`（flow 级），若评审认为应归 task_control 可在批 8 前调整。
2. **OpenCode permission 模式匹配**：本方案按"bash 前缀/glob 匹配 + 最后匹配优先 + auto 模式 deny 生效"设计；精确语义以目标 OpenCode 版本文档为准，批 12 用 adversarial 测试锁定行为。
3. **`gh pr review` 的执行者**：reviewer 只读，审查意见由 primary 经 `task_control{submit-review}` 提交——与 PRD R8"同一 reviewer Agent 并行双轴审查"一致，但审查的**内容生成**仍由 reviewer 完成。
4. **TDD 豁免**：`not-applicable` 判定（纯文档）由 primary 调用工具记录，豁免（`exempt-request`）必须用户批准；具体豁免记录格式（写入 Task Record comment）在批 10 细化。
5. **本仓库无 GitHub Actions workflow**：`/setup` 生成的 workflow 草案内容与"版本写规则"（versionFile/tagFormat）在批 2/7 与用户确认，不在本方案硬编码。
6. **`/test` 命令**：PRD R11 明确 `/test` 仅诊断命令非独立 Stage——不进入 7 命令集；诊断能力由 flow-review 内 CI 检查覆盖。
7. **并发上限 5 / 重试 3 / 双轴审查轮次 3**：作为插件内置默认值，Profile 可覆盖（R10）。

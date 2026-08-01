/**
 * tdd_checkpoint 工具（spec §2.3 tdd_checkpoint + §4 Runtime TDD 硬门禁 + PRD R6）。
 *
 * 与旧 `plugin/tdd-tool.ts`（Phase C 占位，接受内联 evidence）不同：
 * - 工具亲自执行 RED/GREEN（复用 kernel/tdd/adapter.executeRedCheck），不接受内联 evidence。
 * - RED 三重校验：失败分类（assertion/missing-behavior）+ 实现文件相对基线未变 + 测试输入未偷换。
 * - GREEN：同一测试通过 + 执行输入 digest 与 RED 一致 + 实现文件有变化。
 * - evidence 写入 Task Record 单个受控 comment（records.appendTddEvidence，marker/revision/幂等）。
 * - 状态以 `<!-- cabbage-tdd-state -->` JSON 块存于 comment，恢复时取最后一个（最新）。
 *
 * caller：developer + primary（矩阵见 kernel/caller.ts）；not-applicable 仅 primary。
 * server.ts 接线由后续批次统一处理（本批提供工厂 + registerTddCheckpoint，不注册）。
 */
import { tool } from "@opencode-ai/plugin/tool"
import { resolveProjectDir } from "../util/paths.js"
import { createHash } from "node:crypto"
import { execFileSync } from "node:child_process"
import { resolve, sep as pathSep } from "node:path"
import { requireToolCaller, CALLER_NOT_AUTHORIZED } from "../kernel/caller.js"
import type { CallerSessionClient } from "../kernel/caller.js"
import { executeRedCheck, executeVitest } from "../kernel/tdd/adapter.js"
import type { VitestOutput } from "../kernel/tdd/adapter.js"
import { computeWorkspaceDigest, matchesAnyPattern } from "../kernel/tdd/digest.js"
import {
  startCycle,
  recordRed,
  recordGreen,
  recordFinalRegression,
  recordFinalVerification,
  abandonCycle,
  createTaskEvidence,
} from "../kernel/tdd/state.js"
import { evaluateTddCompliance } from "../kernel/tdd/evaluator.js"
import { buildEvidenceBlock } from "../kernel/tdd/evidence.js"
import type { EvidenceBlockInput } from "../kernel/tdd/evidence.js"
import { appendTddEvidence, readTddEvidenceComment, extractEvidenceBlock } from "../kernel/records.js"
import { gh as ghCli } from "../util/gh.js"
import type {
  TddEvidence,
  TddPolicy,
  AcceptanceCriterion,
  TddCommandEvidence,
  VersionedDigest,
} from "../kernel/types.js"

// ─── 类型 ───

export type TddCheckpointOp =
  | "cycle-start"
  | "red"
  | "green"
  | "final-regression"
  | "final-verification"
  | "abandon-cycle"
  | "status"
  | "not-applicable"
  | "exempt-request"

export interface TddCheckpointDeps {
  projectDir: string
  sessionClient: CallerSessionClient
}

/** 从 Task Record 解析出的工具执行上下文 */
export interface TddTaskContext {
  /** Task Record（Sub Issue）编号 */
  issueNumber: number
  policy: TddPolicy
  criteria: AcceptanceCriterion[]
  /** 绝对路径（基于 projectDir 解析） */
  worktreeDir: string
}

export interface TddCheckpointToolResponse {
  ok: boolean
  cycle?: { cycleId: string; criterionId: string; status: string }
  evidence?: {
    revision: number
    status: string
    cycles: number
    regression: string
    verification: string
    warnings: string[]
  }
  error?: { code: string; message: string }
}

// ─── 可替换的 gh executor（用于测试） ───

type GhFn = (args: string) => Promise<{ stdout: string; stderr: string }>

let tddGhExecutor: GhFn | null = null

export function setTddCheckpointGhExecutor(fn: GhFn | null): void {
  tddGhExecutor = fn
}

async function gh(args: string): Promise<{ stdout: string; stderr: string }> {
  if (tddGhExecutor) return tddGhExecutor(args)
  return ghCli(args)
}

// ─── Task Record TDD 区块 ───

/** Task Record body 中承载 TDD policy/criteria/worktree 的 JSON 区块 marker */
export const TASK_TDD_TAG = "<!-- cabbage-task-tdd -->"

export interface TaskTddBlock {
  policy: TddPolicy
  criteria: AcceptanceCriterion[]
  worktreeDir: string
}

/** 从 Task Record body 解析 TDD 区块（纯函数）；无 marker 或畸形返回 null */
export function parseTaskTddBlock(body: string): TaskTddBlock | null {
  const idx = body.indexOf(TASK_TDD_TAG)
  if (idx === -1) return null
  const jsonText = body.slice(idx + TASK_TDD_TAG.length).trim()
  try {
    const parsed = JSON.parse(jsonText) as Partial<TaskTddBlock>
    if (!parsed || typeof parsed !== "object") return null
    if (!parsed.policy || !Array.isArray(parsed.criteria) || typeof parsed.worktreeDir !== "string") return null
    return { policy: parsed.policy, criteria: parsed.criteria, worktreeDir: parsed.worktreeDir }
  } catch {
    return null
  }
}

/**
 * 解析 Task Record 上下文：按 title 定位 Sub Issue → 读 body → 解析 TDD 区块。
 * 由批 9（task_control 写 Task Record）遵循此区块格式；批 15 接线时可替换为正式解析。
 */
export async function resolveTaskContext(
  parentIssueNumber: number,
  taskId: string,
  projectDir: string,
): Promise<TddTaskContext> {
  const { stdout } = await gh(
    `issue list --parent ${parentIssueNumber} --json number,title --jq '[.[] | select(.title == ${JSON.stringify(taskId)}) | .number] | first'`,
  )
  const issueNumber = Number(stdout.trim())
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`TASK_NOT_FOUND: Task "${taskId}" not found under parent #${parentIssueNumber}`)
  }
  const bodyResp = await gh(`issue view ${issueNumber} --json body --jq .body`)
  const block = parseTaskTddBlock(bodyResp.stdout)
  if (!block) {
    throw new Error(`TASK_TDD_BLOCK_MISSING: Task Record #${issueNumber} has no ${TASK_TDD_TAG} block`)
  }
  // worktreeDir 必须为项目内相对路径（防目录穿越，与 digest.ts validateRelPath 一致）
  const worktreeDir = resolve(projectDir, block.worktreeDir)
  if (!worktreeDir.startsWith(resolve(projectDir) + pathSep) && worktreeDir !== resolve(projectDir)) {
    throw new Error(`TASK_TDD_BLOCK_INVALID: worktreeDir "${block.worktreeDir}" escapes project root`)
  }
  return {
    issueNumber,
    policy: block.policy,
    criteria: block.criteria,
    worktreeDir,
  }
}

// ─── 状态序列化（存于 evidence comment） ───

/** evidence comment 内状态 JSON 块 marker；解析时取最后一个（最新） */
export const TDD_STATE_TAG = "<!-- cabbage-tdd-state -->"

export function serializeState(evidence: TddEvidence): string {
  return `${TDD_STATE_TAG}\n${JSON.stringify({ schema: 1, evidence })}`
}

/** 从 marker 区间内容解析最新状态；无状态块或畸形返回 null */
export function parseStateFromContent(content: string): TddEvidence | null {
  const idx = content.lastIndexOf(TDD_STATE_TAG)
  if (idx === -1) return null
  const jsonText = content.slice(idx + TDD_STATE_TAG.length).trim()
  try {
    const parsed = JSON.parse(jsonText) as { schema?: number; evidence?: TddEvidence }
    if (!parsed || parsed.schema !== 1 || !parsed.evidence) return null
    return parsed.evidence
  } catch {
    return null
  }
}

/** 恢复 Task Record 的 TDD evidence 状态；无受控 comment → 初始状态 */
async function restoreEvidence(issueNumber: number): Promise<TddEvidence> {
  const comment = await readTddEvidenceComment(issueNumber)
  if (!comment) return createTaskEvidence()
  const extracted = extractEvidenceBlock(comment.body)
  const state = extracted ? parseStateFromContent(extracted.content) : null
  if (!state) {
    throw new Error(`EVIDENCE_STATE_CORRUPTED: Task Record #${issueNumber} evidence comment is malformed`)
  }
  return state
}

/** 人读 block + 状态 JSON 追加到受控 comment（appendTddEvidence 幂等去重） */
async function persistEvidence(
  issueNumber: number,
  evidence: TddEvidence,
  input: EvidenceBlockInput,
): Promise<{ ok: boolean; revision: number; error?: string }> {
  const block = `${buildEvidenceBlock(input)}\n${serializeState(evidence)}`
  return appendTddEvidence(issueNumber, block)
}

// ─── digest 辅助 ───

function digestEqual(a: VersionedDigest | null, b: VersionedDigest | null): boolean {
  if (a === null || b === null) return a === b
  return a.algorithm === b.algorithm && a.value === b.value
}

/** 实现文件子集 digest：作为 cycle 基线（cycle-start 快照）与 RED/GREEN 对比对象 */
async function computeImplDigest(worktreeDir: string, policy: TddPolicy): Promise<VersionedDigest> {
  return computeWorkspaceDigest(worktreeDir, {
    testFilePatterns: [],
    implementationFilePatterns: policy.implementationFilePatterns,
    generatedArtifactPatterns: policy.generatedArtifactPatterns,
  })
}

/** 测试输入 digest（executionInputPatterns）：防 RED/GREEN 偷换测试配置/selector */
async function computeExecutionInputDigest(worktreeDir: string, policy: TddPolicy): Promise<VersionedDigest> {
  const patterns = policy.runner?.executionInputPatterns ?? []
  return computeWorkspaceDigest(worktreeDir, {
    testFilePatterns: patterns,
    implementationFilePatterns: [],
    generatedArtifactPatterns: [],
  })
}

// ─── 响应辅助 ───

const PLACEHOLDER: VersionedDigest = { algorithm: "sha256-content-v1", value: "0".repeat(64) }

function okResponse(overrides: Partial<TddCheckpointToolResponse> = {}): string {
  return JSON.stringify({ ok: true, ...overrides }, null, 2)
}

function errorResponse(code: string, message: string): string {
  return JSON.stringify({ ok: false, error: { code, message } }, null, 2)
}

function evidenceSummary(evidence: TddEvidence): TddCheckpointToolResponse["evidence"] {
  return {
    revision: evidence.revision,
    status: evidence.status,
    cycles: evidence.cycles.length,
    regression: evidence.regression.status,
    verification: evidence.verification.status,
    warnings: evidence.warnings,
  }
}

function bumpEvidence(evidence: TddEvidence, patch: Partial<TddEvidence>): TddEvidence {
  return { ...evidence, ...patch, revision: evidence.revision + 1, updatedAt: new Date().toISOString() }
}

// ─── op handlers ───

type OpArgs = Record<string, any>

function requireRefs(args: OpArgs): { parentIssueNumber: number; taskId: string } | null {
  const parentIssueNumber = Number(args.parent_issue_number)
  const taskId = args.task_id as string | undefined
  if (!Number.isInteger(parentIssueNumber) || !taskId) return null
  return { parentIssueNumber, taskId }
}

async function handleCycleStart(args: OpArgs, deps: TddCheckpointDeps): Promise<TddCheckpointToolResponse> {
  const cycleId = args.cycle_id as string | undefined
  const criterionId = args.criterion_id as string | undefined
  const testPaths = args.test_paths as string[] | undefined
  const testSelector = args.test_selector as string | undefined
  if (!cycleId || !criterionId || !testSelector || !Array.isArray(testPaths) || testPaths.length === 0) {
    return { ok: false, error: { code: "POLICY_INVALID", message: "cycle-start requires cycle_id, criterion_id, test_paths, test_selector" } }
  }

  const refs = requireRefs(args)
  if (!refs) return { ok: false, error: { code: "POLICY_INVALID", message: "parent_issue_number and task_id are required" } }
  const task = await resolveTaskContext(refs.parentIssueNumber, refs.taskId, deps.projectDir)
  const evidence = await restoreEvidence(task.issueNumber)

  // 基线：实现文件 digest 快照
  const implDigest = await computeImplDigest(task.worktreeDir, task.policy)
  const res = startCycle(
    evidence,
    cycleId,
    criterionId,
    testPaths,
    testSelector,
    implDigest,
    task.criteria,
    task.policy.testFilePatterns,
  )
  if (!res.ok) return { ok: false, error: { code: res.error.code, message: res.error.message } }

  if (res.value.evidence !== evidence) {
    const persisted = await persistEvidence(task.issueNumber, res.value.evidence, {
      stage: "cycle-start",
      criterionId,
      cycleId,
      command: "cycle-start",
      testSelector,
      exitCode: null,
      failureKind: null,
      status: "started",
      workspaceDigest: implDigest,
      summary: `cycle ${cycleId} started (criterion ${criterionId})`,
    })
    if (!persisted.ok) return { ok: false, error: { code: "EVIDENCE_WRITE_FAILED", message: persisted.error ?? "failed to write evidence" } }
  }

  return {
    ok: true,
    cycle: { cycleId, criterionId, status: res.value.cycle.status },
    evidence: evidenceSummary(res.value.evidence),
  }
}

async function handleRed(args: OpArgs, deps: TddCheckpointDeps): Promise<TddCheckpointToolResponse> {
  const cycleId = args.cycle_id as string | undefined
  const testSelector = args.test_selector as string | undefined
  if (!cycleId || !testSelector) {
    return { ok: false, error: { code: "POLICY_INVALID", message: "red requires cycle_id and test_selector" } }
  }
  const refs = requireRefs(args)
  if (!refs) return { ok: false, error: { code: "POLICY_INVALID", message: "parent_issue_number and task_id are required" } }
  const task = await resolveTaskContext(refs.parentIssueNumber, refs.taskId, deps.projectDir)
  if (!task.policy.runner) {
    return { ok: false, error: { code: "RUNNER_UNSUPPORTED", message: "RED requires a configured test runner" } }
  }

  const evidence = await restoreEvidence(task.issueNumber)
  const cycle = evidence.cycles.find(c => c.cycleId === cycleId)
  if (!cycle) {
    return { ok: false, error: { code: "CYCLE_CONFLICT", message: `Cycle "${cycleId}" not found` } }
  }

  // 工具亲自执行
  const run = await executeRedCheck(task.policy.runner, testSelector, task.worktreeDir)
  const inputDigest = await computeExecutionInputDigest(task.worktreeDir, task.policy)
  const implDigest = await computeImplDigest(task.worktreeDir, task.policy)

  // 实现文件相对基线未变
  if (!digestEqual(implDigest, cycle.startWorkspaceDigest)) {
    return { ok: false, error: { code: "IMPL_CHANGED_IN_RED", message: "Implementation files changed since cycle baseline; RED must only add/modify tests" } }
  }

  // 测试输入未偷换（与上一次 RED attempt 一致）
  const lastRed = cycle.redAttempts[cycle.redAttempts.length - 1]
  if (lastRed && !digestEqual(inputDigest, lastRed.executionInputDigest)) {
    return { ok: false, error: { code: "INPUT_SWAPPED", message: "Execution input digest differs from the previous RED attempt" } }
  }

  const redEvidence: TddCommandEvidence = { ...run, executionInputDigest: inputDigest }
  const res = recordRed(evidence, cycleId, redEvidence)
  if (!res.ok) return { ok: false, error: { code: res.error.code, message: res.error.message } }

  if (res.value.evidence !== evidence) {
    const persisted = await persistEvidence(task.issueNumber, res.value.evidence, {
      stage: "red",
      criterionId: cycle.criterionId,
      cycleId,
      command: redEvidence.command,
      testSelector,
      exitCode: redEvidence.exitCode,
      failureKind: redEvidence.failureKind,
      status: "red",
      workspaceDigest: implDigest,
      summary: redEvidence.summary,
    })
    if (!persisted.ok) return { ok: false, error: { code: "EVIDENCE_WRITE_FAILED", message: persisted.error ?? "failed to write evidence" } }
  }

  return {
    ok: true,
    cycle: { cycleId, criterionId: cycle.criterionId, status: res.value.cycle.status },
    evidence: evidenceSummary(res.value.evidence),
  }
}

async function handleGreen(args: OpArgs, deps: TddCheckpointDeps): Promise<TddCheckpointToolResponse> {
  const cycleId = args.cycle_id as string | undefined
  const testSelector = args.test_selector as string | undefined
  if (!cycleId || !testSelector) {
    return { ok: false, error: { code: "POLICY_INVALID", message: "green requires cycle_id and test_selector" } }
  }
  const refs = requireRefs(args)
  if (!refs) return { ok: false, error: { code: "POLICY_INVALID", message: "parent_issue_number and task_id are required" } }
  const task = await resolveTaskContext(refs.parentIssueNumber, refs.taskId, deps.projectDir)
  if (!task.policy.runner) {
    return { ok: false, error: { code: "RUNNER_UNSUPPORTED", message: "GREEN requires a configured test runner" } }
  }

  const evidence = await restoreEvidence(task.issueNumber)
  const cycle = evidence.cycles.find(c => c.cycleId === cycleId)
  if (!cycle) {
    return { ok: false, error: { code: "CYCLE_CONFLICT", message: `Cycle "${cycleId}" not found` } }
  }

  // 工具亲自执行同一测试（GREEN 复用 executeRedCheck：它已封装 runner 调用 + 失败分类，
  // GREEN 仅需 exitCode 0 即通过；若失败则分类为 assertion 等，语义对 GREEN 同样适用）
  const run = await executeRedCheck(task.policy.runner, testSelector, task.worktreeDir)
  const inputDigest = await computeExecutionInputDigest(task.worktreeDir, task.policy)
  const implDigest = await computeImplDigest(task.worktreeDir, task.policy)
  const implChanged = !digestEqual(implDigest, cycle.startWorkspaceDigest)

  // 同一测试 selector（执行输入 digest 与 RED 一致，防偷换）
  if (cycle.redTestDigest && !digestEqual(inputDigest, cycle.redTestDigest)) {
    return { ok: false, error: { code: "SELECTOR_SWAPPED", message: "Execution input digest differs from RED; test selector/config must not change" } }
  }

  const greenEvidence: TddCommandEvidence = { ...run, executionInputDigest: inputDigest }
  const res = recordGreen(evidence, cycleId, greenEvidence, implChanged)
  if (!res.ok) return { ok: false, error: { code: res.error.code, message: res.error.message } }

  if (res.value.evidence !== evidence) {
    const persisted = await persistEvidence(task.issueNumber, res.value.evidence, {
      stage: "green",
      criterionId: cycle.criterionId,
      cycleId,
      command: greenEvidence.command,
      testSelector,
      exitCode: greenEvidence.exitCode,
      failureKind: greenEvidence.failureKind,
      status: "pass",
      workspaceDigest: implDigest,
      summary: greenEvidence.summary,
    })
    if (!persisted.ok) return { ok: false, error: { code: "EVIDENCE_WRITE_FAILED", message: persisted.error ?? "failed to write evidence" } }
  }

  return {
    ok: true,
    cycle: { cycleId, criterionId: cycle.criterionId, status: res.value.cycle.status },
    evidence: evidenceSummary(res.value.evidence),
  }
}

function buildRegressionRun(command: string, output: VitestOutput): TddCommandEvidence {
  const outputDigest = createHash("sha256").update(output.stdout + "\n" + output.stderr).digest("hex")
  const now = new Date().toISOString()
  return {
    command,
    testSelector: null,
    exitCode: output.exitCode,
    failureKind: output.timedOut ? "timeout" : null,
    testsCollected: output.testsCollected,
    testsFailed: output.testsFailed,
    startedAt: now,
    finishedAt: now,
    durationMs: 0,
    changedFiles: [],
    outputDigest: { algorithm: "sha256-output-v1", value: outputDigest },
    workspaceDigest: PLACEHOLDER,
    executionInputDigest: PLACEHOLDER,
    summary: output.exitCode === 0 ? "full regression passed" : `full regression failed (exit ${output.exitCode})`,
  }
}

async function handleFinalRegression(args: OpArgs, deps: TddCheckpointDeps): Promise<TddCheckpointToolResponse> {
  const refs = requireRefs(args)
  if (!refs) return { ok: false, error: { code: "POLICY_INVALID", message: "parent_issue_number and task_id are required" } }
  const task = await resolveTaskContext(refs.parentIssueNumber, refs.taskId, deps.projectDir)
  if (!task.policy.runner) {
    return { ok: false, error: { code: "RUNNER_UNSUPPORTED", message: "final-regression requires a configured test runner" } }
  }

  const baseArgs = task.policy.runner.baseCommand.trim().split(/\s+/).filter(Boolean)
  if (baseArgs.length === 0) {
    return { ok: false, error: { code: "REGRESSION_FAILED", message: "No test command configured for final regression" } }
  }

  // 工具亲自执行全量回归
  const output = await executeVitest(baseArgs, task.worktreeDir, task.policy.runner.timeoutMs)
  const run = buildRegressionRun(baseArgs.join(" "), output)

  const evidence = await restoreEvidence(task.issueNumber)
  const res = recordFinalRegression(evidence, "worktree", "worktree", [run])
  if (!res.ok) return { ok: false, error: { code: res.error.code, message: res.error.message } }

  const status = res.value.regression.status === "pass" ? "pass" : "fail"
  const persisted = await persistEvidence(task.issueNumber, res.value, {
    stage: "final-regression",
    command: run.command,
    testSelector: null,
    exitCode: run.exitCode,
    failureKind: run.failureKind,
    status,
    workspaceDigest: null,
    summary: run.summary,
  })
  if (!persisted.ok) return { ok: false, error: { code: "EVIDENCE_WRITE_FAILED", message: persisted.error ?? "failed to write evidence" } }

  if (res.value.regression.status !== "pass") {
    return { ok: false, error: { code: "REGRESSION_FAILED", message: "Final regression must pass before submit" } }
  }
  return { ok: true, evidence: evidenceSummary(res.value) }
}

async function handleFinalVerification(args: OpArgs, deps: TddCheckpointDeps): Promise<TddCheckpointToolResponse> {
  const refs = requireRefs(args)
  if (!refs) return { ok: false, error: { code: "POLICY_INVALID", message: "parent_issue_number and task_id are required" } }
  const task = await resolveTaskContext(refs.parentIssueNumber, refs.taskId, deps.projectDir)

  const evidence = await restoreEvidence(task.issueNumber)

  // 对照 acceptance criteria 逐条核验：每个 tdd criterion 必须有 pass cycle
  const tddCriteria = task.criteria.filter(c => c.verification === "tdd")
  const uncovered = tddCriteria.filter(
    c => !evidence.cycles.some(cy => cy.criterionId === c.id && cy.status === "pass"),
  )
  if (uncovered.length > 0) {
    return {
      ok: false,
      error: { code: "CRITERIA_NOT_COVERED", message: `Criteria without a passing cycle: ${uncovered.map(c => c.id).join(", ")}` },
    }
  }

  const res = recordFinalVerification(evidence, "worktree", "worktree", [])
  if (!res.ok) return { ok: false, error: { code: res.error.code, message: res.error.message } }

  const persisted = await persistEvidence(task.issueNumber, res.value, {
    stage: "final-verification",
    command: "final-verification",
    testSelector: null,
    exitCode: null,
    failureKind: null,
    status: "pass",
    workspaceDigest: null,
    summary: `verified ${tddCriteria.length} tdd criteria against passing cycles`,
  })
  if (!persisted.ok) return { ok: false, error: { code: "EVIDENCE_WRITE_FAILED", message: persisted.error ?? "failed to write evidence" } }

  return { ok: true, evidence: evidenceSummary(res.value) }
}

async function handleAbandonCycle(args: OpArgs, deps: TddCheckpointDeps): Promise<TddCheckpointToolResponse> {
  const cycleId = args.cycle_id as string | undefined
  const reason = args.reason as string | undefined
  if (!cycleId || !reason) {
    return { ok: false, error: { code: "POLICY_INVALID", message: "abandon-cycle requires cycle_id and reason" } }
  }
  const refs = requireRefs(args)
  if (!refs) return { ok: false, error: { code: "POLICY_INVALID", message: "parent_issue_number and task_id are required" } }
  const task = await resolveTaskContext(refs.parentIssueNumber, refs.taskId, deps.projectDir)

  const evidence = await restoreEvidence(task.issueNumber)
  const res = abandonCycle(evidence, cycleId, reason)
  if (!res.ok) return { ok: false, error: { code: res.error.code, message: res.error.message } }

  if (res.value !== evidence) {
    const persisted = await persistEvidence(task.issueNumber, res.value, {
      stage: "abandon-cycle",
      cycleId,
      command: "abandon-cycle",
      testSelector: null,
      exitCode: null,
      failureKind: null,
      status: "abandoned",
      workspaceDigest: null,
      summary: reason,
    })
    if (!persisted.ok) return { ok: false, error: { code: "EVIDENCE_WRITE_FAILED", message: persisted.error ?? "failed to write evidence" } }
  }

  return { ok: true, evidence: evidenceSummary(res.value) }
}

async function handleStatus(args: OpArgs, deps: TddCheckpointDeps): Promise<TddCheckpointToolResponse> {
  const refs = requireRefs(args)
  if (!refs) return { ok: false, error: { code: "POLICY_INVALID", message: "parent_issue_number and task_id are required" } }
  const task = await resolveTaskContext(refs.parentIssueNumber, refs.taskId, deps.projectDir)
  const evidence = await restoreEvidence(task.issueNumber)
  return { ok: true, evidence: evidenceSummary(evidence) }
}

async function handleWaiver(
  args: OpArgs,
  deps: TddCheckpointDeps,
  kind: "not-applicable" | "exempt-request",
): Promise<TddCheckpointToolResponse> {
  if (kind === "exempt-request" && args.user_confirmed !== true) {
    return { ok: false, error: { code: "EXEMPT_REQUIRES_CONFIRMATION", message: "exempt-request requires user_confirmed: true" } }
  }
  const refs = requireRefs(args)
  if (!refs) return { ok: false, error: { code: "POLICY_INVALID", message: "parent_issue_number and task_id are required" } }
  const task = await resolveTaskContext(refs.parentIssueNumber, refs.taskId, deps.projectDir)

  if (kind === "not-applicable") {
    // 内核校验：worktree 相对 HEAD 的变更必须全部命中文档 pattern（纯文档豁免，防代码变更绕过 TDD 门禁）
    const changed = listWorktreeChanges(task.worktreeDir)
    if (!isDocumentationOnly(changed, DOCUMENTATION_PATTERNS)) {
      return {
        ok: false,
        error: {
          code: "WAIVER_DOCS_ONLY",
          message: `not-applicable requires a pure documentation change; non-doc files changed: ${changed.filter(f => !isDocumentationOnly([f], DOCUMENTATION_PATTERNS)).join(", ")}`,
        },
      }
    }
  }

  const evidence0 = await restoreEvidence(task.issueNumber)
  const reason = (args.reason as string | undefined) ?? (kind === "not-applicable" ? "pure documentation change" : "exempt request")
  const evidence = bumpEvidence(evidence0, {
    status: "waived",
    warnings: [...evidence0.warnings, `${kind}: ${reason}`],
  })

  const persisted = await persistEvidence(task.issueNumber, evidence, {
    stage: kind,
    command: kind,
    testSelector: null,
    exitCode: null,
    failureKind: null,
    status: "waived",
    workspaceDigest: null,
    summary: reason,
  })
  if (!persisted.ok) return { ok: false, error: { code: "EVIDENCE_WRITE_FAILED", message: persisted.error ?? "failed to write evidence" } }

  return { ok: true, evidence: evidenceSummary(evidence) }
}

// ─── 纯文档豁免判定（not-applicable 内核门禁） ───

/** 文档类文件 pattern：markdown 系 + 通用文本 + docs 目录 */
const DOCUMENTATION_PATTERNS = ["**/*.md", "**/*.markdown", "**/*.rst", "**/*.adoc", "**/*.txt", "docs/**", "README*"]

/** 变更文件是否全部命中文档 pattern；空变更集也视为不通过（无变更不应豁免） */
export function isDocumentationOnly(changedFiles: string[], patterns: string[]): boolean {
  if (changedFiles.length === 0) return false
  return changedFiles.every(f => matchesAnyPattern(f, patterns))
}

/** 解析 git status --porcelain 输出为变更文件路径（重命名取新路径，跳过冲突条目） */
export function parsePorcelainChanges(raw: string): string[] {
  const files: string[] = []
  for (const line of raw.split("\n")) {
    if (line.length < 4) continue
    const code = line.slice(0, 2)
    // 冲突条目（UU/AU/UD/AA/DD/UA/DU/!!）无确定性变更语义，跳过
    if (code[0] === "U" || code[1] === "U" || code.includes("!")) continue
    let path = line.slice(3)
    const arrow = path.indexOf(" -> ")
    if (arrow !== -1) path = path.slice(arrow + 4)
    if (path !== "") files.push(path)
  }
  return files
}

// ─── 可替换的 git executor（测试用） ───

type GitFn = (args: string[], cwd: string) => string

let tddGitExecutor: GitFn | null = null

export function setTddCheckpointGitExecutor(fn: GitFn | null): void {
  tddGitExecutor = fn
}

/** 列出 worktree 相对 HEAD 的变更文件（已跟踪修改/删除 + 未跟踪新增）；git 失败返回空 */
export function listWorktreeChanges(worktreeDir: string): string[] {
  const run = tddGitExecutor ?? ((args, cwd) => {
    try {
      return execFileSync("git", ["-C", cwd, ...args], {
        encoding: "utf-8",
        env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
        maxBuffer: 10 * 1024 * 1024,
      })
    } catch {
      return ""
    }
  })
  const raw = run(["status", "--porcelain"], worktreeDir)
  return parsePorcelainChanges(raw)
}

// ─── 工具工厂 ───

const OPS: TddCheckpointOp[] = [
  "cycle-start", "red", "green", "final-regression", "final-verification",
  "abandon-cycle", "status", "not-applicable", "exempt-request",
]

export function createTddCheckpointTool(deps: TddCheckpointDeps) {
  return tool({
    description: `Record Runtime TDD evidence for a running Task (spec §2.3 tdd_checkpoint, PRD R6).

The tool executes tests itself — it never accepts inline evidence.

Operations:
- cycle-start: start a TDD cycle. Requires criterion_id, test_paths, test_selector. Records the implementation-file digest baseline.
- red: run the focused test (must fail with assertion or missing-behavior), verify implementation files are unchanged since baseline and the execution input digest is stable, then record RED evidence.
- green: run the same test (must pass), verify the execution input digest matches RED, then record GREEN evidence.
- final-regression: run the full test suite (must pass).
- final-verification: verify each tdd criterion has a passing cycle.
- abandon-cycle: abandon a cycle with a reason.
- status: read the current evidence summary.
- not-applicable: pure-documentation waiver (primary only).
- exempt-request: other waivers require user_confirmed.

Caller: developer + primary.`,
    args: {
      op: tool.schema.enum(OPS).describe("TDD checkpoint operation"),
      parent_issue_number: tool.schema.number().optional().describe("Parent GitHub Issue number (Flow Record)"),
      task_id: tool.schema.string().optional().describe("Task Record title (Sub Issue title)"),
      cycle_id: tool.schema.string().optional().describe("Cycle id (for cycle-start/red/green/abandon-cycle)"),
      criterion_id: tool.schema.string().optional().describe("Acceptance criterion id (for cycle-start)"),
      test_paths: tool.schema.array(tool.schema.string()).optional().describe("Test file paths for the cycle"),
      test_selector: tool.schema.string().optional().describe("Focused test selector (file path)"),
      reason: tool.schema.string().optional().describe("Reason for abandon-cycle / waiver"),
      user_confirmed: tool.schema.boolean().optional().describe("Human approval (required for exempt-request)"),
    },
    async execute(args: Record<string, any>, ctx: any): Promise<string> {
      const op = args.op as string

      // caller 门禁（矩阵单一来源，§2.2）：developer + primary；not-applicable 仅 primary
      const denied = await requireToolCaller(ctx, "tdd_checkpoint", op, deps.sessionClient)
      if (denied) return errorResponse(CALLER_NOT_AUTHORIZED, denied)

      // 会话级项目目录优先（workspace root 异常会话下插件级 projectDir 可能是 `/`）
      const runtimeDeps = { ...deps, projectDir: resolveProjectDir(ctx.directory, deps.projectDir) }

      try {
        const resp = await dispatch(op, args, runtimeDeps)
        return resp.ok ? okResponse({ cycle: resp.cycle, evidence: resp.evidence }) : errorResponse(resp.error!.code, resp.error!.message)
      } catch (err) {
        return errorResponse("INTERNAL_ERROR", String(err))
      }
    },
  })
}

async function dispatch(op: string, args: OpArgs, deps: TddCheckpointDeps): Promise<TddCheckpointToolResponse> {
  switch (op) {
    case "cycle-start":
      return handleCycleStart(args, deps)
    case "red":
      return handleRed(args, deps)
    case "green":
      return handleGreen(args, deps)
    case "final-regression":
      return handleFinalRegression(args, deps)
    case "final-verification":
      return handleFinalVerification(args, deps)
    case "abandon-cycle":
      return handleAbandonCycle(args, deps)
    case "status":
      return handleStatus(args, deps)
    case "not-applicable":
      return handleWaiver(args, deps, "not-applicable")
    case "exempt-request":
      return handleWaiver(args, deps, "exempt-request")
    default:
      return { ok: false, error: { code: "POLICY_INVALID", message: `Unknown op: "${op}"` } }
  }
}

/** 独立注册辅助：把 tdd_checkpoint 挂到工具注册表（后续接线批次使用） */
export function registerTddCheckpoint(registry: Record<string, unknown>, deps: TddCheckpointDeps): void {
  registry.tdd_checkpoint = createTddCheckpointTool(deps)
}

// ─── submit 门禁（spec §4.4，供 task_control submit-task 调用） ───

export interface TddSubmitGateInput {
  /** Task Record（Sub Issue）编号 */
  issueNumber: number
  policy: TddPolicy
  criteria: AcceptanceCriterion[]
}

export type TddSubmitGateResult =
  | { ok: true; status: string; warnings: string[] }
  | { ok: false; code: string; message: string }

/**
 * TDD 硬门禁：evidence 必须由 kernel 亲自写入（受控 comment 存在且状态可解析），
 * 再经 evaluateTddCompliance 判定；runtime 下不完整 → 拒绝。
 */
export async function checkTddSubmitGate(input: TddSubmitGateInput): Promise<TddSubmitGateResult> {
  const comment = await readTddEvidenceComment(input.issueNumber)
  if (!comment) {
    return { ok: false, code: "TDD_EVIDENCE_INCOMPLETE", message: "No TDD evidence comment found on the Task Record" }
  }

  const extracted = extractEvidenceBlock(comment.body)
  const evidence = extracted ? parseStateFromContent(extracted.content) : null
  if (!evidence) {
    return { ok: false, code: "TDD_EVIDENCE_INCOMPLETE", message: "Evidence comment exists but the TDD state is missing or malformed" }
  }

  // 豁免语义：not-applicable / exempt-request 记录为 waived → 放行（文档/经批准豁免任务）
  if (evidence.status === "waived") {
    return { ok: true, status: "waived", warnings: ["TDD waived (not-applicable or user-approved exemption)"] }
  }

  const compliance = evaluateTddCompliance(input.policy, evidence, input.criteria)
  if (compliance.status !== "pass" && input.policy.enforcement === "runtime") {
    return { ok: false, code: "TDD_EVIDENCE_INCOMPLETE", message: compliance.warnings.join("; ") }
  }
  return { ok: true, status: compliance.status, warnings: compliance.warnings }
}

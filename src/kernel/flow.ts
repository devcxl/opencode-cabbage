/**
 * Flow 生命周期 kernel 逻辑（spec §2.3 flow_control）。
 * 纯函数与 gh/git 执行分离；gh/git 调用走可注入 executor（测试用）。
 */
import { exec } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { gh as ghCli, parsePrUrlNumber } from "../util/gh.js"
import { escapeShellArg } from "../util/shell.js"
import { pathExists } from "../util/fs.js"
import { validateTitle } from "./slug.js"
import { readProjectProfile } from "./profile.js"
import { STAGE_LABEL_PREFIX, createFlowRecord, readFlowRecord, updateFlowRecord, setStageLabel } from "./records.js"
import { worktreeStart } from "./worktree.js"
import {
  readIndex,
  getFlowSession,
  bindSession,
  takeoverSession,
  updateFlowSession,
} from "./session-index.js"
import { detectLegacyFlowRun } from "./legacy.js"

const execAsync = promisify(exec)

// ─── 可替换的 gh/git executor（测试用，仿 records.ts/setup.ts） ───

export type CmdResult = { stdout: string; stderr: string }
export type CmdFn = (args: string) => Promise<CmdResult>

let flowGhExecutor: CmdFn | null = null
let flowGitExecutor: CmdFn | null = null

export function setFlowGhExecutor(fn: CmdFn | null): void {
  flowGhExecutor = fn
}

export function setFlowGitExecutor(fn: CmdFn | null): void {
  flowGitExecutor = fn
}

export async function flowGh(args: string): Promise<CmdResult> {
  if (flowGhExecutor) return flowGhExecutor(args)
  return ghCli(args)
}

export async function flowGit(args: string): Promise<CmdResult> {
  if (flowGitExecutor) return flowGitExecutor(args)
  return execAsync(`git ${args}`)
}

// ─── Flow 阶段 ───

export type FlowStage = "requirements" | "design" | "tasks" | "code" | "review"

export const FLOW_STAGES: FlowStage[] = ["requirements", "design", "tasks", "code", "review"]

const STAGE_ORDER: Record<FlowStage, number> = {
  requirements: 0,
  design: 1,
  tasks: 2,
  code: 3,
  review: 4,
}

/** 高风险 Flow 标签：design 与 tasks 之间需用户确认（PRD R11） */
export const RISK_LABEL = "cabbage:risk:high"

function isFlowStage(value: string): value is FlowStage {
  return (FLOW_STAGES as string[]).includes(value)
}

// ─── Flow Record body 模板与 stage checklist ───

/** 新建 Flow Record 的 body：目标/验收/阶段 checklist（spec §2.3 create-flow） */
export function buildFlowBody(slug: string): string {
  const stages = FLOW_STAGES.map(stage => `- [ ] ${stage}`).join("\n")
  return [
    `# Flow: ${slug}`,
    "",
    "## Goal",
    "",
    "<!-- 目标：由模型在 requirements 阶段填充 -->",
    "",
    "## Acceptance Criteria",
    "",
    "- [ ] TBD",
    "",
    "## Stages",
    "",
    stages,
    "",
  ].join("\n")
}

/** 从 body checklist 提取已完成阶段（按流程顺序） */
export function getCompletedStages(body: string): FlowStage[] {
  const completed: FlowStage[] = []
  for (const line of body.split("\n")) {
    const match = /^-\s+\[x\]\s+(\w+)/i.exec(line.trim())
    if (match && isFlowStage(match[1])) completed.push(match[1])
  }
  return FLOW_STAGES.filter(stage => completed.includes(stage))
}

/** 把 stage 的 checkbox 标记为完成；已标记或缺失时幂等返回原 body */
export function markStageComplete(body: string, stage: FlowStage): string {
  return body.replace(new RegExp(`^- \\[ \\] ${stage}$`, "m"), `- [x] ${stage}`)
}

/** 从 issue labels 提取当前阶段（阶段序号最大的 cabbage:stage:* 标签） */
export function getCurrentStage(labels: string[]): FlowStage | null {
  let current: FlowStage | null = null
  for (const label of labels) {
    if (!label.startsWith(STAGE_LABEL_PREFIX)) continue
    const stage = label.slice(STAGE_LABEL_PREFIX.length)
    if (!isFlowStage(stage)) continue
    if (current === null || STAGE_ORDER[stage] > STAGE_ORDER[current]) current = stage
  }
  return current
}

// ─── stage 门禁（spec §2.3：requirements 基线确认 / design 后才有 task / 高风险暂停） ───

export type StageGateResult = { ok: true } | { ok: false; code: string; message: string }

export type StageOp = "stage-start" | "stage-complete"

/**
 * 前置门禁判定：
 * - stage-start X：前驱阶段须已 completed（requirements 无前置）
 * - stage-complete X：X 未完成时前驱须已 completed；requirements 完成需 user_confirmed 一次
 * - stage-start tasks 与 stage-complete tasks：高风险 Flow（cabbage:risk:high）
 *   均需 user_confirmed 确认（R11：design→tasks 交接，不可跳过 start 直接 complete 绕过）
 * - 已完成阶段重复 start/complete → 幂等通过
 */
export function checkStageGate(
  op: StageOp,
  stage: FlowStage,
  completed: FlowStage[],
  highRisk: boolean,
  userConfirmed: boolean,
): StageGateResult {
  const done = completed.includes(stage)

  if (op === "stage-complete") {
    if (done) return { ok: true }
    if (stage === "requirements") {
      return userConfirmed ? { ok: true } : requirementConfirmationError()
    }
    if (!completed.includes(FLOW_STAGES[STAGE_ORDER[stage] - 1])) {
      return previousStageError(stage)
    }
    if (stage === "tasks" && highRisk && !userConfirmed) {
      return {
        ok: false,
        code: "RISK_CONFIRMATION_REQUIRED",
        message:
          "This flow is marked as high-risk; the design-to-tasks handoff requires user confirmation (user_confirmed: true)",
      }
    }
    return { ok: true }
  }

  // stage-start
  if (done) return { ok: true }
  if (stage !== "requirements" && !completed.includes(FLOW_STAGES[STAGE_ORDER[stage] - 1])) {
    return previousStageError(stage)
  }
  if (stage === "tasks" && highRisk && !userConfirmed) {
    return {
      ok: false,
      code: "RISK_CONFIRMATION_REQUIRED",
      message:
        "This flow is marked as high-risk; the design-to-tasks handoff requires user confirmation (user_confirmed: true)",
    }
  }
  return { ok: true }
}

function requirementConfirmationError(): StageGateResult {
  return {
    ok: false,
    code: "REQUIREMENTS_CONFIRMATION_REQUIRED",
    message: "The requirements baseline must be confirmed once by the user (user_confirmed: true)",
  }
}

function previousStageError(stage: FlowStage): StageGateResult {
  const prev = FLOW_STAGES[STAGE_ORDER[stage] - 1]
  const code = `${prev.toUpperCase()}_NOT_COMPLETE`
  return { ok: false, code, message: `Stage "${prev}" must be completed before stage "${stage}"` }
}

// ─── status：Flow Record + 子任务 + 关联 PR checks 聚合（spec §2.3） ───

export interface FlowRecordSummary {
  number: number
  title: string
  state: string
  labels: string[]
}

export interface SubtaskSummary {
  number: number
  title: string
  state: string
}

export interface CheckSummary {
  name: string
  state: string
}

export interface RelatedPrSummary {
  number: number
  title: string
  state: string
  headRefName: string
  checks: CheckSummary[]
}

export interface FlowStatusReport {
  flow: FlowRecordSummary
  stages: { completed: FlowStage[]; current: FlowStage | null }
  subtasks: SubtaskSummary[]
  pullRequests: RelatedPrSummary[]
}

export type FlowStatusResult =
  | { ok: true; status: FlowStatusReport }
  | { ok: false; code: "NOT_FOUND" | "GITHUB_ERROR"; message: string }

/** 关联 PR：PR body 引用了 Flow 或任一子任务 Issue 号（保留 PR 原始字段） */
export function filterRelatedPrs<T extends { number: number; body?: string }>(
  prs: T[],
  parentIssueNumber: number,
  subtaskNumbers: number[],
): T[] {
  const refs = new Set([String(parentIssueNumber), ...subtaskNumbers.map(String)])
  return prs.filter(pr => {
    const mentioned = (pr.body ?? "").match(/#(\d+)/g)?.map(s => s.slice(1)) ?? []
    return mentioned.some(n => refs.has(n))
  })
}

/** 把 statusCheckRollup 精简为 {name, state} 列表（name 兼容 .name/.context） */
export function summarizeChecks(rollup: Array<{ name?: string; context?: string; state: string }>): CheckSummary[] {
  return rollup.map(check => ({ name: check.name ?? check.context ?? "unknown", state: check.state }))
}

/** 读 Flow Record + 子任务 + 关联 PR checks 汇总（spec §2.3 status） */
export async function readFlowStatus(parentIssueNumber: number): Promise<FlowStatusResult> {
  try {
    const { stdout: flowOut } = await flowGh(
      `issue view ${parentIssueNumber} --json number,title,state,labels,body --jq '{number, title, state, labels: [.labels[].name], body}'`,
    )
    const flow = JSON.parse(flowOut) as {
      number: number
      title: string
      state: string
      labels: string[]
      body: string
    }

    const { stdout: subtasksOut } = await flowGh(
      `issue list --state all --limit 100 --search parent:${parentIssueNumber} --json number,title,state --jq '[.[] | {number, title, state}]'`,
    )
    const subtasks = JSON.parse(subtasksOut) as SubtaskSummary[]

    const { stdout: prsOut } = await flowGh(
      `pr list --state all --json number,title,state,headRefName,body --jq '[.[] | {number, title, state, headRefName, body}]'`,
    )
    const related = filterRelatedPrs(
      JSON.parse(prsOut) as Array<{ number: number; title: string; state: string; headRefName: string; body?: string }>,
      parentIssueNumber,
      [...subtasks.map(s => s.number)],
    )

    const pullRequests: RelatedPrSummary[] = []
    for (const pr of related) {
      const { stdout: rollupOut } = await flowGh(
        `pr view ${pr.number} --json statusCheckRollup --jq '[.[] | {name, context, state}]'`,
      )
      const rollup = JSON.parse(rollupOut) as Array<{ name?: string; context?: string; state: string }>
      pullRequests.push({ ...pr, checks: summarizeChecks(rollup) })
    }

    return {
      ok: true,
      status: {
        flow: { number: flow.number, title: flow.title, state: flow.state, labels: flow.labels },
        stages: { completed: getCompletedStages(flow.body), current: getCurrentStage(flow.labels) },
        subtasks,
        pullRequests,
      },
    }
  } catch (err) {
    const message = String(err)
    return message.includes("Could not resolve") || message.includes("not found")
      ? { ok: false, code: "NOT_FOUND", message }
      : { ok: false, code: "GITHUB_ERROR", message }
  }
}

// ─── planning worktree（spec §2.3 planning-start / planning-pr） ───

export type PlanningResult =
  | { ok: true; worktreePath: string; branch: string; prNumber?: number; reused?: boolean }
  | { ok: false; code: string; message: string }

/** 读 Flow Record 标题（即 flow slug），并强制校验为合法 kebab-case slug（防注入） */
async function readFlowSlug(parentIssueNumber: number): Promise<string> {
  const { stdout } = await flowGh(`issue view ${parentIssueNumber} --json title --jq .title`)
  const slug = stdout.trim()
  const validated = validateTitle(slug)
  if (!validated.ok) {
    throw new Error(`INVALID_FLOW_SLUG: ${validated.message}`)
  }
  return slug
}

/**
 * 读仓库默认分支。
 * 优先 GitHub API（defaultBranchRef）；API 未返回（defaultBranchRef 为 null）时
 * 回退远端 HEAD 指针（refs/remotes/origin/HEAD）；仍不可得 → 抛错拒绝（fail-closed，
 * 不猜测分支名，防 PR base 误用临时分支）。
 */
async function readDefaultBranch(): Promise<string> {
  try {
    const { stdout } = await flowGh(`repo view --json defaultBranchRef --jq .defaultBranchRef.name`)
    const branch = stdout.trim()
    if (branch !== "") return branch
  } catch {
    // 查询失败 → 走回退
  }
  try {
    const { stdout } = await flowGit(`symbolic-ref --short refs/remotes/origin/HEAD`)
    const head = stdout.trim()
    if (head !== "") return head
  } catch {
    // 无远端 HEAD 指针 → 走失败
  }
  throw new Error("cannot determine default branch (repo view defaultBranchRef empty and no origin/HEAD)")
}

function planningBranch(slug: string): string {
  return `docs/planning-${slug}`
}

function planningWorktreePath(projectDir: string, slug: string): string {
  return path.join(projectDir, ".worktree", `planning-${slug}`)
}

/** 创建 planning worktree `.worktree/planning-<slug>`（architect 在此写文档） */
export async function planningStart(projectDir: string, parentIssueNumber: number): Promise<PlanningResult> {
  try {
    const slug = await readFlowSlug(parentIssueNumber)
    const base = await readDefaultBranch()
    const result = await worktreeStart({
      projectDir,
      slug: `planning-${slug}`,
      base,
      branchType: "docs",
    })
    if (!result.ok) {
      return { ok: false, code: result.code, message: result.message }
    }
    return { ok: true, worktreePath: result.path, branch: result.branch, reused: result.reused }
  } catch (err) {
    const message = String(err)
    return message.includes("Could not resolve") || message.includes("not found")
      ? { ok: false, code: "NOT_FOUND", message }
      : { ok: false, code: "GITHUB_ERROR", message }
  }
}

/** 对 planning worktree 的变更创建 Planning PR（Planning Baseline） */
export async function planningPr(projectDir: string, parentIssueNumber: number): Promise<PlanningResult> {
  try {
    const slug = await readFlowSlug(parentIssueNumber)
    const branch = planningBranch(slug)
    const worktreeDir = planningWorktreePath(projectDir, slug)

    if (!(await pathExists(worktreeDir))) {
      return {
        ok: false,
        code: "PLANNING_WORKTREE_NOT_FOUND",
        message: `Planning worktree ${worktreeDir} does not exist; run planning-start first`,
      }
    }

    const { stdout: statusOut } = await flowGit(`-C '${escapeShellArg(worktreeDir)}' status --porcelain`)
    if (statusOut.trim() === "") {
      return { ok: false, code: "NOTHING_TO_COMMIT", message: "Planning worktree has no changes to commit" }
    }

    await flowGit(`-C '${escapeShellArg(worktreeDir)}' add -A`)
    await flowGit(`-C '${escapeShellArg(worktreeDir)}' commit -m 'docs: planning baseline for ${slug}'`)
    await flowGit(`-C '${escapeShellArg(worktreeDir)}' push -u origin '${escapeShellArg(branch)}'`)

    const base = await readDefaultBranch()
    const prTitle = `docs: planning baseline for ${slug}`
    const prBody = `Planning Baseline for Flow #${parentIssueNumber}: CONTEXT.md + PRD + Design + ADR (spec PRD R11).`
    const { stdout } = await flowGh(
      `pr create --title '${escapeShellArg(prTitle)}' --body '${escapeShellArg(prBody)}' --base '${escapeShellArg(base)}' --head '${escapeShellArg(branch)}'`,
    )
    // gh pr create 不支持 --json：解析 stdout 中的 PR URL
    const prNumber = parsePrUrlNumber(stdout)
    if (prNumber === null) {
      return { ok: false, code: "GITHUB_ERROR", message: `invalid PR create output: ${stdout}` }
    }
    return { ok: true, worktreePath: worktreeDir, branch, prNumber }
  } catch (err) {
    const message = String(err)
    return message.includes("Could not resolve") || message.includes("not found")
      ? { ok: false, code: "NOT_FOUND", message }
      : { ok: false, code: "GITHUB_ERROR", message }
  }
}

// ─── Flow 生命周期（spec §2.3 create-flow / complete-flow / cancel-flow / takeover） ───

export interface CreateFlowInput {
  projectDir: string
  title: string
  sessionID: string
  /** 提供时对已有 Issue 建立 Flow 绑定（不新建）——legacy 检测 + 双 session 检查 */
  parentIssueNumber?: number
}

export type CreateFlowResult =
  | { ok: true; ref: { parentIssueNumber: number; slug: string } }
  | { ok: false; code: string; message: string }

/**
 * create-flow：
 * - 新建模式：validateTitle → Profile 门禁 → Draft Parent Issue（body 含目标/验收/阶段 checklist）→ bindSession
 * - 绑定模式（提供 parentIssueNumber）：legacy 检测（§11.2）→ bindSession 双 session 检查（§10.3）
 */
export async function createFlow(input: CreateFlowInput): Promise<CreateFlowResult> {
  if (input.parentIssueNumber === undefined) {
    const validated = validateTitle(input.title)
    if (!validated.ok) {
      return { ok: false, code: validated.code, message: validated.message }
    }
    const profile = await readProjectProfile(input.projectDir)
    if (profile.testCommand === null) {
      return {
        ok: false,
        code: "SETUP_REQUIRED",
        message: "Project Profile is not confirmed; run setup_control confirm-profile first (spec §9.3)",
      }
    }

    const created = await createFlowRecord({ slug: validated.slug, body: buildFlowBody(validated.slug) })
    if (!created.ok) {
      return { ok: false, code: "ISSUE_CREATE_FAILED", message: created.error }
    }
    const bound = await bindSession(input.projectDir, created.ref.parentIssueNumber, input.sessionID)
    if (!bound.ok) {
      return { ok: false, code: bound.code, message: bound.message }
    }
    return { ok: true, ref: created.ref }
  }

  // 绑定已有 Issue：legacy 检测 → 双 session 检查
  const n = input.parentIssueNumber
  const legacy = await detectLegacyFlowRun(n, flowGh)
  if (legacy.legacy) {
    return {
      ok: false,
      code: "LEGACY_FLOW_DETECTED",
      message:
        "This issue is a legacy-architecture FlowRun; complete it with the old plugin version (0.x). New versions do not auto-migrate.",
    }
  }
  const bound = await bindSession(input.projectDir, n, input.sessionID)
  if (!bound.ok) {
    return { ok: false, code: bound.code, message: bound.message }
  }
  let slug: string
  try {
    slug = await readFlowSlug(n)
  } catch {
    // 读不到标题或标题不是合法 slug：绑定必须可校验 slug，否则后续 shell 拼接有注入风险
    const fallback = validateTitle(input.title)
    if (!fallback.ok) {
      return { ok: false, code: "INVALID_FLOW_SLUG", message: "Issue title is not a valid kebab-case slug" }
    }
    slug = fallback.slug
  }
  return { ok: true, ref: { parentIssueNumber: n, slug } }
}

export type FlowLifecycleResult =
  | { ok: true; parentIssueNumber: number }
  | { ok: false; code: string; message: string }

/** complete-flow（仅 goal-verify 调用，goal 已验证）：关闭 Parent Issue + 标记 completed */
export async function completeFlow(projectDir: string, parentIssueNumber: number): Promise<FlowLifecycleResult> {
  try {
    await flowGh(`issue close ${parentIssueNumber}`)
    await updateFlowSession(projectDir, parentIssueNumber, { status: "completed" })
    return { ok: true, parentIssueNumber }
  } catch (err) {
    return { ok: false, code: "GITHUB_ERROR", message: String(err) }
  }
}

/** cancel-flow：受控取消（user_confirmed）→ 关闭 Issue + 标记 cancelled */
export async function cancelFlow(
  projectDir: string,
  parentIssueNumber: number,
  userConfirmed: boolean,
): Promise<FlowLifecycleResult> {
  if (!userConfirmed) {
    return {
      ok: false,
      code: "USER_CONFIRMATION_REQUIRED",
      message: "Cancelling a flow requires user confirmation (user_confirmed: true)",
    }
  }
  try {
    await flowGh(`issue close ${parentIssueNumber}`)
    await updateFlowSession(projectDir, parentIssueNumber, { status: "cancelled" })
    return { ok: true, parentIssueNumber }
  } catch (err) {
    return { ok: false, code: "GITHUB_ERROR", message: String(err) }
  }
}

export type TakeoverFlowResult =
  | { ok: true; parentIssueNumber: number; oldSessionID: string | null }
  | { ok: false; code: string; message: string }

/** takeover：双 session 接管（user_confirmed）→ 旧 session 置 paused + 新 session 绑定（§10.3） */
export async function takeoverFlow(
  projectDir: string,
  parentIssueNumber: number,
  newSessionID: string,
  userConfirmed: boolean,
): Promise<TakeoverFlowResult> {
  const index = await readIndex(projectDir)
  const old = getFlowSession(index, parentIssueNumber)
  const result = await takeoverSession(projectDir, parentIssueNumber, newSessionID, userConfirmed)
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message }
  }
  return { ok: true, parentIssueNumber, oldSessionID: old?.sessionID ?? null }
}

// ─── stage-start / stage-complete（spec §2.3：门禁 + checklist + label） ───

export type ApplyStageResult =
  | { ok: true; stage: FlowStage; completedStages: FlowStage[]; highRisk: boolean }
  | { ok: false; code: string; message: string }

/** 读 Flow Record 的 labels（字符串数组） */
async function readIssueLabels(parentIssueNumber: number): Promise<string[]> {
  const { stdout } = await flowGh(`issue view ${parentIssueNumber} --json labels --jq '[.labels[].name]'`)
  return JSON.parse(stdout) as string[]
}

/**
 * stage-start / stage-complete：
 * 门禁（checkStageGate）→ stage-complete 更新 body checklist（乐观锁）→ setStageLabel。
 * declaredRisk：模型显式声明高风险（"high"）时即使 Issue 无 cabbage:risk:high 标签，
 * 同样触发 R11 确认门禁；确认通过后持久化 RISK_LABEL（后续环节可见）。
 */
export async function applyStageOp(
  _projectDir: string,
  parentIssueNumber: number,
  op: StageOp,
  stage: FlowStage,
  userConfirmed: boolean,
  declaredRisk?: "high" | "low",
): Promise<ApplyStageResult> {
  const record = await readFlowRecord(parentIssueNumber)
  if (!record.ok) {
    return { ok: false, code: "NOT_FOUND", message: record.error }
  }

  const completed = getCompletedStages(record.body)
  const labels = await readIssueLabels(parentIssueNumber)
  const highRisk = labels.includes(RISK_LABEL) || declaredRisk === "high"

  const gate = checkStageGate(op, stage, completed, highRisk, userConfirmed)
  if (!gate.ok) {
    return { ok: false, code: gate.code, message: gate.message }
  }

  if (op === "stage-complete") {
    const updated = await updateFlowRecord(parentIssueNumber, record.body, body => markStageComplete(body, stage))
    if (!updated.ok) {
      return { ok: false, code: "BODY_UPDATE_FAILED", message: updated.error }
    }
  }

  // 模型声明高风险且已确认：持久化 RISK_LABEL（R11 状态真实化，后续环节可见）
  if (declaredRisk === "high" && !labels.includes(RISK_LABEL)) {
    const riskLabel = await addRiskLabel(parentIssueNumber)
    if (!riskLabel.ok) {
      return { ok: false, code: "LABEL_UPDATE_FAILED", message: riskLabel.error ?? "risk label update failed" }
    }
  }

  const labelResult = await setStageLabel(parentIssueNumber, stage)
  if (!labelResult.ok) {
    return { ok: false, code: "LABEL_UPDATE_FAILED", message: labelResult.error ?? "label update failed" }
  }

  const newCompleted = op === "stage-complete" ? [...completed, stage] : completed
  return { ok: true, stage, completedStages: newCompleted, highRisk }
}

/** 给 Parent Issue 打高风险标签（模型声明 + 用户确认后持久化） */
async function addRiskLabel(parentIssueNumber: number): Promise<{ ok: boolean; error?: string }> {
  try {
    await flowGh(`issue edit ${parentIssueNumber} --add-label '${escapeShellArg(RISK_LABEL)}'`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

import type { TaskState, TddReworkEvidence } from "./types.js"

// ─── 类型 ───

export interface CreatePRParams {
  repo: string
  headBranch: string
  baseBranch: string
  title: string
  body: string
}

export interface CreatePRResult {
  prNumber: number
  prUrl: string
  created: boolean
}

export type PreflightResult =
  | { ok: true }
  | { ok: false; code: string; message: string }

// ─── Rework 类型 ───

export interface ReworkInput {
  kind: "behavior" | "refactor"
  affectedCriterionIds: string[]
  startHeadSha: string
}

export type ReworkResult =
  | { ok: true; task: TaskState }
  | { ok: false; code: string; message: string }

export interface CompleteReworkInput {
  committedHeadSha: string
}

export type CompleteReworkResult =
  | { ok: true; task: TaskState }
  | { ok: false; code: string; message: string }

// ─── Remote head 类型 ───

export interface RemotePRHead {
  headSha: string
  treeSha: string
}

export type FetchRemoteHeadResult =
  | { ok: true; head: RemotePRHead }
  | { ok: false; code: string; message: string }

export type RevalidateResult =
  | { ok: true; action: "revalidate"; summary: string }
  | { ok: false; action: "rework-needed"; summary: string }

// ─── gh CLI 执行（可替代用于测试） ───

type GhFn = (args: string) => Promise<{ stdout: string; stderr: string }>

let ghExecutor: GhFn | null = null

export function setGhExecutor(fn: GhFn) {
  ghExecutor = fn
}

async function gh(args: string): Promise<{ stdout: string; stderr: string }> {
  if (ghExecutor) {
    return ghExecutor(args)
  }
  const mod = await import("../util/gh.js")
  return mod.gh(args)
}

// ─── PR 号解析 ───

function parsePrNumber(stdout: string): number | null {
  const trimmed = stdout.trim()
  // 纯数字
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10)
  // URL 格式：https://github.com/owner/repo/pull/123
  const urlMatch = trimmed.match(/\/pull\/(\d+)$/)
  if (urlMatch) return parseInt(urlMatch[1], 10)
  // 其他格式尝试提取尾部数字
  const numMatch = trimmed.match(/(\d+)$/)
  if (numMatch) return parseInt(numMatch[1], 10)
  return null
}

// ─── Preflight 检查 ───

/**
 * 执行 PR 创建前的前置条件检查（无副作用）。
 *
 * 规则：
 * 1. Task 状态为 running
 * 2. committed-head regression.status === "pass"
 * 3. committed-head verification.status === "pass"
 * 4. evidence headSha 与当前 head 一致
 */
export function preflightPRCreate(
  task: TaskState,
  currentHeadSha: string,
): PreflightResult {
  // 1. Task 状态检查
  if (task.status !== "running") {
    return {
      ok: false,
      code: "TASK_NOT_RUNNING",
      message: `Task "${task.id}" is not running (status: ${task.status})`,
    }
  }

  const { regression, verification } = task.tddEvidence

  // 2. Regression 状态检查
  if (regression.status !== "pass") {
    return {
      ok: false,
      code: "REGRESSION_NOT_COMPLETE",
      message: `Committed-head regression is not pass (status: ${regression.status})`,
    }
  }

  // 3. Verification 状态检查
  if (verification.status !== "pass") {
    return {
      ok: false,
      code: "VERIFICATION_NOT_COMPLETE",
      message: `Final verification is not pass (status: ${verification.status})`,
    }
  }

  // 4. Head SHA 一致性检查
  if (!regression.headSha) {
    return {
      ok: false,
      code: "HEAD_MISMATCH",
      message: "Regression evidence is missing head SHA",
    }
  }

  if (regression.headSha !== currentHeadSha) {
    return {
      ok: false,
      code: "HEAD_MISMATCH",
      message: `Evidence head SHA "${regression.headSha}" does not match current head "${currentHeadSha}"`,
    }
  }

  return { ok: true }
}

// ─── PR 查找 ───

/**
 * 按 repo + head branch 查询已存在的 open PR。
 */
async function findExistingPR(repo: string, headBranch: string): Promise<{ number: number; url: string } | null> {
  try {
    const { stdout } = await gh(
      `pr list --head "${headBranch}" --repo "${repo}" --state open --json number,url --jq '.[0]'`,
    )
    if (!stdout.trim()) return null
    const pr = JSON.parse(stdout) as { number: number; url: string }
    if (!pr || typeof pr.number !== "number") return null
    return { number: pr.number, url: pr.url }
  } catch {
    return null
  }
}

// ─── PR 创建 ───

/**
 * 创建或复用 PR。
 *
 * 流程：
 * 1. 查询已有 open PR（按 head branch）
 * 2. 已有 → 复用（created: false）
 * 3. 无 → 创建新 PR（created: true）
 *
 * @throws 如果 gh CLI 执行失败
 */
export async function createOrReusePR(params: CreatePRParams): Promise<CreatePRResult> {
  // 1. 查询已有 PR
  const existing = await findExistingPR(params.repo, params.headBranch)
  if (existing) {
    return {
      prNumber: existing.number,
      prUrl: existing.url,
      created: false,
    }
  }

  // 2. 创建新 PR
  const escapedTitle = params.title.replace(/'/g, "'\\''")
  const escapedBody = params.body.replace(/'/g, "'\\''")

  const { stdout } = await gh(
    `pr create --head "${params.headBranch}" --base "${params.baseBranch}" --title '${escapedTitle}' --body '${escapedBody}'`,
  )

  const prNumber = parsePrNumber(stdout)
  if (prNumber === null) {
    throw new Error(`Failed to parse PR number from gh output: ${stdout}`)
  }

  return {
    prNumber,
    prUrl: stdout.trim(),
    created: true,
  }
}

// ─── Rework 流程 ───

/**
 * 发起 rework。
 *
 * behavior rework：
 * - 声明 affected criterionIds，增加 reworkRevision
 * - 重置 regression 和 verification 为 pending
 * - 旧 cycle 保持不变（不重新绑定）
 *
 * refactor rework：
 * - 不要求 RED，但必须重跑 regression + 审批
 * - 同样增加 reworkRevision，重置 evidence
 *
 * 要求：Task 状态为 reviewing 且已有 PR。
 */
export function initiateRework(task: TaskState, input: ReworkInput): ReworkResult {
  if (task.status !== "reviewing") {
    return {
      ok: false,
      code: "TASK_NOT_REVIEWING",
      message: `Task "${task.id}" is not in reviewing status (current: ${task.status})`,
    }
  }

  if (task.prNumber === null) {
    return {
      ok: false,
      code: "NO_PR_EXISTS",
      message: `Task "${task.id}" has no associated PR`,
    }
  }

  const evidence = task.tddEvidence
  const newRevision = evidence.reworkRevision + 1

  const rework: TddReworkEvidence = {
    reworkRevision: newRevision,
    kind: input.kind,
    affectedCriterionIds: input.affectedCriterionIds,
    status: "started",
    startHeadSha: input.startHeadSha,
    approval: null,
  }

  const updatedTask: TaskState = {
    ...task,
    tddEvidence: {
      ...evidence,
      reworkRevision: newRevision,
      status: "in-progress",
      regression: {
        status: "pending",
        headSha: null,
        treeSha: null,
        reworkRevision: newRevision,
        runs: [],
      },
      verification: {
        status: "pending",
        headSha: null,
        treeSha: null,
        runs: [],
      },
      reworks: [...evidence.reworks, rework],
      updatedAt: new Date().toISOString(),
    },
  }

  return { ok: true, task: updatedTask }
}

/**
 * 完成 rework，验证后恢复 Task 为 reviewing。
 *
 * 检查：
 * 1. 当前有激活的 rework（evidence.status === "in-progress"）
 * 2. regression 和 verification 均已 pass
 * 3. evidence head SHA 与 committed head 一致
 */
export function completeRework(task: TaskState, input: CompleteReworkInput): CompleteReworkResult {
  const evidence = task.tddEvidence

  // 1. 检查是否有激活的 rework
  if (evidence.status !== "in-progress") {
    return {
      ok: false,
      code: "NO_ACTIVE_REWORK",
      message: `Task "${task.id}" has no active rework (current TDD status: ${evidence.status})`,
    }
  }

  // 2. 检查 regression
  if (evidence.regression.status !== "pass") {
    return {
      ok: false,
      code: "REGRESSION_NOT_PASS",
      message: `Committed-head regression is not pass (status: ${evidence.regression.status})`,
    }
  }

  // 3. 检查 verification
  if (evidence.verification.status !== "pass") {
    return {
      ok: false,
      code: "VERIFICATION_NOT_PASS",
      message: `Final verification is not pass (status: ${evidence.verification.status})`,
    }
  }

  // 4. 检查 head SHA 一致性（regression 和 verification 都需检查）
  const regHead = evidence.regression.headSha
  const verHead = evidence.verification.headSha

  if (regHead !== input.committedHeadSha) {
    return {
      ok: false,
      code: "HEAD_MISMATCH",
      message: `Regression head SHA "${regHead}" does not match committed head "${input.committedHeadSha}"`,
    }
  }

  if (verHead !== input.committedHeadSha) {
    return {
      ok: false,
      code: "HEAD_MISMATCH",
      message: `Verification head SHA "${verHead}" does not match committed head "${input.committedHeadSha}"`,
    }
  }

  // 更新最后一个 rework 状态为 pass
  const reworks = [...evidence.reworks]
  if (reworks.length > 0) {
    const last = { ...reworks[reworks.length - 1] }
    last.status = "pass"
    reworks[reworks.length - 1] = last
  }

  const updatedTask: TaskState = {
    ...task,
    status: "reviewing",
    tddEvidence: {
      ...evidence,
      status: "pass",
      reworks,
      updatedAt: new Date().toISOString(),
    },
  }

  return { ok: true, task: updatedTask }
}

// ─── Remote head revalidation ───

/**
 * 查询 remote PR 的 head commit SHA 和 tree SHA。
 *
 * 步骤：
 * 1. `gh pr view --json headRefOid` 获取完整 JSON，自行解析提取 headRefOid
 * 2. `gh api repos/{owner}/{repo}/git/commits/{sha} --jq '.tree.sha'` 获取 tree SHA
 */
export async function fetchRemotePRHead(repo: string, prNumber: number): Promise<FetchRemoteHeadResult> {
  // 步骤 1: 查询 PR head SHA
  let prJson: unknown
  try {
    const { stdout } = await gh(
      `pr view ${prNumber} --repo "${repo}" --json headRefOid`,
    )
    try {
      prJson = JSON.parse(stdout)
    } catch {
      return { ok: false, code: "PARSE_ERROR", message: "Failed to parse gh pr view JSON output" }
    }
  } catch (err) {
    return { ok: false, code: "GH_ERROR", message: `Failed to fetch PR head: ${String(err)}` }
  }

  if (!prJson || typeof prJson !== "object") {
    return { ok: false, code: "PARSE_ERROR", message: "gh pr view returned unexpected output" }
  }

  const prData = prJson as { headRefOid?: string }
  if (!prData.headRefOid || typeof prData.headRefOid !== "string") {
    return { ok: false, code: "MISSING_HEAD_SHA", message: "Remote PR headRefOid is missing or not a string" }
  }

  const headSha = prData.headRefOid

  // 步骤 2: 获取 tree SHA
  let treeSha: string
  try {
    const { stdout } = await gh(
      `api repos/${repo}/git/commits/${headSha} --jq '.tree.sha'`,
    )
    treeSha = stdout.trim()
    if (!treeSha) {
      return { ok: false, code: "MISSING_HEAD_SHA", message: "Remote commit tree SHA is empty" }
    }
  } catch (err) {
    return { ok: false, code: "GH_ERROR", message: `Failed to fetch commit tree SHA: ${String(err)}` }
  }

  return { ok: true, head: { headSha, treeSha } }
}

/**
 * 重新验证 remote head。
 *
 * 比较 task.tddEvidence.verification.treeSha 与 remote tree SHA：
 * - 相同 tree SHA：可以重新绑定 new head（重跑 regression/verification）
 * - 不同 tree SHA：需要先执行 rework
 */
export function revalidateRemoteHead(
  task: TaskState,
  remoteHead: RemotePRHead,
): RevalidateResult {
  const evidenceTreeSha = task.tddEvidence.verification.treeSha

  if (!evidenceTreeSha) {
    return {
      ok: false,
      action: "rework-needed",
      summary: `No tree SHA in evidence; remote head ${remoteHead.headSha.slice(0, 7)} (tree: ${remoteHead.treeSha.slice(0, 7)}) requires rework`,
    }
  }

  if (evidenceTreeSha === remoteHead.treeSha) {
    return {
      ok: true,
      action: "revalidate",
      summary: `Remote head ${remoteHead.headSha.slice(0, 7)} tree matches evidence tree ${evidenceTreeSha.slice(0, 7)} — re-run regression and rebind head`,
    }
  }

  return {
    ok: false,
    action: "rework-needed",
    summary: `Remote head ${remoteHead.headSha.slice(0, 7)} tree changed (was: ${evidenceTreeSha.slice(0, 7)}, now: ${remoteHead.treeSha.slice(0, 7)}) — rework required`,
  }
}

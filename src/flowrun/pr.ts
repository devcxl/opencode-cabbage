import type { TaskState } from "./types.js"
import { canCreatePR } from "./gate.js"

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

import type {
  PRCheckpoints, Checkpoint, TaskState,
} from "./types.js"

// ─── 可替换的 gh executor（用于测试） ───

type GhFn = (args: string) => Promise<{ stdout: string; stderr: string }>

let mergeGhExecutor: GhFn | null = null

export function setMergeGhExecutor(fn: GhFn) {
  mergeGhExecutor = fn
}

async function gh(args: string): Promise<{ stdout: string; stderr: string }> {
  if (mergeGhExecutor) {
    return mergeGhExecutor(args)
  }
  const mod = await import("../util/gh.js")
  return mod.gh(args)
}

// ─── 类型 ───

export interface BranchProtectionStatus {
  exists: boolean
  requiredChecks: string[]
  requiresPR: boolean
  dismissesStale: boolean
}

export interface MergeGateResult {
  allowed: boolean
  reason?: string
  checkpointResults: Record<string, "pending" | "pass" | "fail" | "skipped">
}

// ─── Branch Protection ───

export async function checkBranchProtection(owner: string, repo: string): Promise<BranchProtectionStatus> {
  try {
    const { stdout } = await gh(`api repos/${owner}/${repo}/branches/main/protection`)
    const data = JSON.parse(stdout)

    const checks: string[] = []
    const requiredPulls = data?.required_pull_request_reviews ?? null
    const requiredChecks = data?.required_status_checks?.checks ?? []

    for (const c of requiredChecks) {
      checks.push(c.context)
    }

    return {
      exists: true,
      requiredChecks: checks,
      requiresPR: !!requiredPulls,
      dismissesStale: requiredPulls?.dismiss_stale_reviews ?? false,
    }
  } catch {
    return {
      exists: false,
      requiredChecks: [],
      requiresPR: false,
      dismissesStale: false,
    }
  }
}

// ─── Checkpoint 验证 ───

export function validateCheckpoint(cp: Checkpoint): "pending" | "pass" | "fail" {
  if (cp.status === "pass") return "pass"
  if (cp.status === "fail") return "fail"
  return "pending"
}

export function validatePRCheckpoints(checkpoints: PRCheckpoints): MergeGateResult {
  const gates: Record<string, Checkpoint> = {
    localChecks: checkpoints.localChecks,
    ciChecks: checkpoints.ciChecks,
    reviewerApproval: checkpoints.reviewerApproval,
    goalVerification: checkpoints.goalVerification,
    branchProtection: checkpoints.branchProtection,
  }

  const results: Record<string, "pending" | "pass" | "fail" | "skipped"> = {}

  for (const [name, cp] of Object.entries(gates)) {
    results[name] = validateCheckpoint(cp)
  }

  const failures = Object.entries(gates).filter(([_, cp]) => cp.status === "fail")
  if (failures.length > 0) {
    return {
      allowed: false,
      reason: `Failed checkpoints: ${failures.map(([k]) => k).join(", ")}`,
      checkpointResults: results,
    }
  }

  const pending = Object.entries(gates).filter(([_, cp]) => cp.status === "pending")
  if (pending.length > 0) {
    return {
      allowed: false,
      reason: `Pending checkpoints: ${pending.map(([k]) => k).join(", ")}`,
      checkpointResults: results,
    }
  }

  return { allowed: true, checkpointResults: results }
}

// ─── Task-local Merge Gate ───

/**
 * Task-local merge gate（不依赖全局 canMerge）。
 *
 * 检查条件（按顺序）：
 * 1. Task 状态为 "reviewing"
 * 2. 存在 PR Checkpoints
 * 3. 所有 checkpoint 状态为 pass
 * 4. TDD compliance 为 pass / waived / null（无 TDD 要求）
 * 5. Branch Protection 已启用
 *
 * 不要求全局 review Stage 为 pass。
 */
export function canMergeTaskPR(task: TaskState, hasBranchProtection: boolean): MergeGateResult {
  // 1. Task 状态检查
  if (task.status === "merged") {
    return { allowed: false, reason: "Task already merged", checkpointResults: {} }
  }

  if (task.status !== "reviewing") {
    return { allowed: false, reason: `Task status is ${task.status}, expected reviewing`, checkpointResults: {} }
  }

  // 2. PR Checkpoints 存在性
  if (!task.prCheckpoints) {
    return { allowed: false, reason: "No PR checkpoints recorded", checkpointResults: {} }
  }

  // 3. 标准 checkpoint 验证
  const prResult = validatePRCheckpoints(task.prCheckpoints)
  if (!prResult.allowed) return prResult

  // 4. TDD compliance 验证
  const tdd = task.prCheckpoints.tddCompliance
  if (tdd !== null && tdd.status === "fail") {
    prResult.checkpointResults["tddCompliance"] = "fail"
    return {
      allowed: false,
      reason: `TDD compliance failed: ${tdd.summary}`,
      checkpointResults: prResult.checkpointResults,
    }
  }
  // tdd === null → 无 TDD 要求，视为通过
  // tdd.status === "pass" / "waived" → 通过
  prResult.checkpointResults["tddCompliance"] =
    tdd === null ? "skipped" : (tdd.status as "pass" | "fail" | "pending")

  // 5. Branch Protection
  if (!hasBranchProtection) {
    prResult.checkpointResults.branchProtection = "fail"
    return {
      allowed: false,
      reason: "Branch protection not enabled on main",
      checkpointResults: prResult.checkpointResults,
    }
  }

  prResult.checkpointResults.branchProtection = "pass"
  return prResult
}

// ─── PR 合并操作 ───

/**
 * 标准化合并 PR（无安全检查，向后兼容）。
 */
export async function mergePR(prNumber: number): Promise<{ success: boolean; error?: string }> {
  try {
    await gh(`pr merge ${prNumber} --squash --delete-branch`)
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

/**
 * Task-local PR 合并（带 --match-head-commit 安全检查）。
 *
 * 步骤：
 * 1. 验证 verifiedSha 非空
 * 2. 使用 gh pr merge --squash --delete-branch --match-head-commit <verifiedSha>
 * 3. 失败时返回错误
 */
export async function mergeTaskPR(prNumber: number, verifiedSha: string): Promise<{ success: boolean; error?: string }> {
  if (!verifiedSha) {
    return { success: false, error: "verifiedSha is required for merge --match-head-commit" }
  }

  try {
    // --match-head-commit 确保只有 verified 的 commit 才会被合并
    await gh(`pr merge ${prNumber} --squash --delete-branch --match-head-commit ${verifiedSha}`)
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

// ─── Revert ───

export async function createRevertPR(prNumber: number, reason: string): Promise<{ prNumber?: number; error?: string }> {
  try {
    const { stdout } = await gh(`pr view ${prNumber} --json headRefName,headRepository,body,title`)
    const pr = JSON.parse(stdout)

    const revertTitle = `revert: ${pr.title}`
    const revertBody = `Reverts #${prNumber}\n\nReason: ${reason}\n\nAuto-generated by opencode-cabbage.`

    const { stdout: newPR } = await gh(`pr create --title '${revertTitle}' --body '${revertBody}' --base main --head main`)
    return { prNumber: parseInt(newPR.trim().split("/").pop() || "0", 10) }
  } catch (err) {
    return { error: String(err) }
  }
}

import type {
  TaskState,
  TddEvidence,
  TddCycleEvidence,
  TddCommandEvidence,
  VersionedDigest,
} from "../flowrun/types.js"
import {
  startCycle,
  recordRed,
  recordGreen,
  recordFinalRegression,
  recordFinalVerification,
  abandonCycle,
  createTaskEvidence as createBaseEvidence,
} from "../flowrun/state.js"

// ─── 请求 / 响应类型 ───

export type TddCheckpointOp =
  | "cycle-start"
  | "red"
  | "green"
  | "final-regression"
  | "final-verification"
  | "status"
  | "alternative-command"
  | "abandon-cycle"

export interface TddCheckpointRequest {
  op: TddCheckpointOp
  parentIssueNumber: number
  taskId: string

  // cycle-start 用
  cycleId?: string
  criterionId?: string
  testPaths?: string[]
  testSelector?: string

  // red 用（inline evidence for testing / mock）
  redEvidence?: TddCommandEvidence

  // green 用（inline evidence for testing / mock）
  greenEvidence?: TddCommandEvidence

  // abandon-cycle 用
  reason?: string

  // alternative-command 用
  validationId?: string

  // final-regression 用（inline for testing）
  regressionRuns?: TddCommandEvidence[]

  // final-verification 用（inline for testing）
  verificationRuns?: TddCommandEvidence[]
}

export interface TddCheckpointResponse {
  ok: boolean
  evidence?: TddEvidence
  cycle?: TddCycleEvidence
  evidenceRevision?: number
  error?: {
    code: string
    message: string
  }
}

// ─── 内部辅助 ───

const PLACEHOLDER_DIGEST: VersionedDigest = {
  algorithm: "sha256-content-v1",
  value: "0".repeat(64),
}

/**
 * 简单 glob 匹配（支持 *、**）
 */
function matchSimpleGlob(filePath: string, pattern: string): boolean {
  const normalized = filePath.split("/").join("/")
  let regexStr = ""
  let i = 0
  while (i < pattern.length) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      i += 2
      if (i < pattern.length && pattern[i] === "/") {
        regexStr += "(.*/)?"
        i++
      } else {
        regexStr += ".*"
      }
    } else if (pattern[i] === "*") {
      regexStr += "[^/]*"
      i++
    } else if (pattern[i] === ".") {
      regexStr += "\\."
      i++
    } else if (pattern[i] === "?") {
      regexStr += "[^/]"
      i++
    } else {
      if ("+^$(){}[]|\\".includes(pattern[i])) {
        regexStr += "\\" + pattern[i]
      } else {
        regexStr += pattern[i]
      }
      i++
    }
  }
  return new RegExp(`^${regexStr}$`).test(normalized)
}

function matchesAnyPattern(path: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false
  return patterns.some(p => matchSimpleGlob(path, p))
}

// ─── 重新导出 createTaskEvidence ───

export { createBaseEvidence as createTaskEvidence }

// ─── 主处理函数 ───

/**
 * 处理 tdd_checkpoint 工具请求。
 *
 * 职责：
 * - 验证 Task 状态（running + executionBinding）
 * - 根据 op 分发到 state.ts 各纯函数
 * - 返回结构化 response（evidence revision + cycle/evidence）
 *
 * 注意：C2 只实现内存状态机。持久化由 C3 broker 负责。
 */
export function handleTddCheckpoint(
  req: TddCheckpointRequest,
  task: TaskState,
): TddCheckpointResponse {
  // ── 验证 Task 状态 ──
  if (task.status !== "running") {
    return {
      ok: false,
      error: { code: "TASK_NOT_RUNNING", message: `Task "${task.id}" is not running (status: ${task.status})` },
    }
  }

  if (!task.executionBinding) {
    return {
      ok: false,
      error: { code: "TASK_NOT_FOUND", message: `Task "${task.id}" has no execution binding` },
    }
  }

  const evidence = task.tddEvidence

  // ── 分发 ──

  switch (req.op) {
    case "status":
      return {
        ok: true,
        evidence,
        evidenceRevision: evidence.revision,
      }

    case "cycle-start":
      return handleCycleStart(req, task, evidence)

    case "red":
      return handleRed(req, task, evidence)

    case "green":
      return handleGreen(req, task, evidence)

    case "final-regression":
      return handleFinalRegression(req, task, evidence)

    case "final-verification":
      return handleFinalVerification(req, task, evidence)

    case "abandon-cycle":
      return handleAbandonCycle(req, evidence)

    case "alternative-command":
      // C2 暂不实现 alternative-command，由 C3 broker 处理
      return {
        ok: false,
        error: { code: "POLICY_INVALID", message: "alternative-command not implemented in C2" },
      }

    default:
      return {
        ok: false,
        error: { code: "POLICY_INVALID", message: `Unknown op: "${(req as TddCheckpointRequest).op}"` },
      }
  }
}

function handleCycleStart(req: TddCheckpointRequest, task: TaskState, evidence: TddEvidence): TddCheckpointResponse {
  const cycleId = req.cycleId
  const criterionId = req.criterionId
  if (!cycleId || !criterionId || !req.testPaths || !req.testSelector) {
    return {
      ok: false,
      error: { code: "POLICY_INVALID", message: "cycle-start requires cycleId, criterionId, testPaths, testSelector" },
    }
  }

  // workspace digest: 由 broker 计算，C2 阶段使用 placeholder
  // （实际运行时 broker 调用 computeWorkspaceDigest 获取）
  const wsDigest = PLACEHOLDER_DIGEST

  const result = startCycle(
    evidence,
    cycleId,
    criterionId,
    req.testPaths,
    req.testSelector,
    wsDigest,
    task.acceptanceCriteria,
    task.tddPolicy.testFilePatterns,
  )

  if (!result.ok) {
    return {
      ok: false,
      error: { code: result.error.code, message: result.error.message },
    }
  }

  // 更新 task.tddEvidence（内存变异，由调用方/C3 持久化）
  task.tddEvidence = result.value.evidence

  return {
    ok: true,
    evidence: result.value.evidence,
    cycle: result.value.cycle,
    evidenceRevision: result.value.evidence.revision,
  }
}

function handleRed(req: TddCheckpointRequest, task: TaskState, evidence: TddEvidence): TddCheckpointResponse {
  const cycleId = req.cycleId
  if (!cycleId) {
    return {
      ok: false,
      error: { code: "POLICY_INVALID", message: "red requires cycleId" },
    }
  }

  // runner 必须存在
  if (!task.tddPolicy.runner) {
    return {
      ok: false,
      error: { code: "RUNNER_UNSUPPORTED", message: "RED requires a configured test runner" },
    }
  }

  // 使用内联 evidence（C2 测试模式）或由 broker 执行 vitest adapter
  const redEvidence = req.redEvidence
  if (!redEvidence) {
    // 生产模式下由 broker 执行 vitest adapter 获取 evidence
    // C2 阶段不直接执行命令
    return {
      ok: false,
      error: { code: "POLICY_INVALID", message: "red requires redEvidence (in testing mode) or broker execution" },
    }
  }

  const result = recordRed(evidence, cycleId, redEvidence)

  if (!result.ok) {
    return {
      ok: false,
      error: { code: result.error.code, message: result.error.message },
    }
  }

  task.tddEvidence = result.value.evidence

  return {
    ok: true,
    evidence: result.value.evidence,
    cycle: result.value.cycle,
    evidenceRevision: result.value.evidence.revision,
  }
}

function handleGreen(req: TddCheckpointRequest, task: TaskState, evidence: TddEvidence): TddCheckpointResponse {
  const cycleId = req.cycleId
  if (!cycleId) {
    return {
      ok: false,
      error: { code: "POLICY_INVALID", message: "green requires cycleId" },
    }
  }

  if (!task.tddPolicy.runner) {
    return {
      ok: false,
      error: { code: "RUNNER_UNSUPPORTED", message: "GREEN requires a configured test runner" },
    }
  }

  const greenEvidence = req.greenEvidence
  if (!greenEvidence) {
    return {
      ok: false,
      error: { code: "POLICY_INVALID", message: "green requires greenEvidence (in testing mode) or broker execution" },
    }
  }

  // 检查实现文件是否有变化
  const implPatterns = task.tddPolicy.implementationFilePatterns
  const implFilesChanged = greenEvidence.changedFiles.some(f => matchesAnyPattern(f, implPatterns))

  const result = recordGreen(evidence, cycleId, greenEvidence, implFilesChanged)

  if (!result.ok) {
    return {
      ok: false,
      error: { code: result.error.code, message: result.error.message },
    }
  }

  task.tddEvidence = result.value.evidence

  return {
    ok: true,
    evidence: result.value.evidence,
    cycle: result.value.cycle,
    evidenceRevision: result.value.evidence.revision,
  }
}

function handleFinalRegression(req: TddCheckpointRequest, task: TaskState, evidence: TddEvidence): TddCheckpointResponse {
  // 必须有 testCommands
  if (!req.regressionRuns && task.testCommands.length === 0) {
    return {
      ok: false,
      error: { code: "REGRESSION_FAILED", message: "No test commands configured for final regression" },
    }
  }

  // 使用内联 evidence 或占位
  const runs = req.regressionRuns ?? []

  // headSha + treeSha 在生产模式下由 broker 通过 git 获取
  // C2 测试模式使用 placeholder
  const headSha = "placeholder-head"
  const treeSha = "placeholder-tree"

  const result = recordFinalRegression(evidence, headSha, treeSha, runs)

  if (!result.ok) {
    return {
      ok: false,
      error: { code: result.error.code, message: result.error.message },
    }
  }

  task.tddEvidence = result.value

  return {
    ok: true,
    evidence: result.value,
    evidenceRevision: result.value.revision,
  }
}

function handleFinalVerification(req: TddCheckpointRequest, task: TaskState, evidence: TddEvidence): TddCheckpointResponse {
  // 使用内联 evidence 或空数组（无 verifyCommands 时 pass）
  const runs = req.verificationRuns ?? []

  const headSha = "placeholder-head"
  const treeSha = "placeholder-tree"

  const result = recordFinalVerification(evidence, headSha, treeSha, runs)

  if (!result.ok) {
    return {
      ok: false,
      error: { code: result.error.code, message: result.error.message },
    }
  }

  task.tddEvidence = result.value

  return {
    ok: true,
    evidence: result.value,
    evidenceRevision: result.value.revision,
  }
}

function handleAbandonCycle(req: TddCheckpointRequest, evidence: TddEvidence): TddCheckpointResponse {
  const cycleId = req.cycleId
  const reason = req.reason ?? "no reason given"

  if (!cycleId) {
    return {
      ok: false,
      error: { code: "POLICY_INVALID", message: "abandon-cycle requires cycleId" },
    }
  }

  const result = abandonCycle(evidence, cycleId, reason)

  if (!result.ok) {
    return {
      ok: false,
      error: { code: result.error.code, message: result.error.message },
    }
  }

  return {
    ok: true,
    evidence: result.value,
    evidenceRevision: result.value.revision,
  }
}

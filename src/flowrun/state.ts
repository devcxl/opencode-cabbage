import type {
  TddEvidence,
  TddCycleEvidence,
  TddCommandEvidence,
  AcceptanceCriterion,
  VersionedDigest,
} from "./types.js"

// ─── 错误类型 ───

export interface StateError {
  code: string
  message: string
}

export type StateResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: StateError }

// ─── 辅助函数 ───

function findCycle(evidence: TddEvidence, cycleId: string): TddCycleEvidence | undefined {
  return evidence.cycles.find(c => c.cycleId === cycleId)
}

function replaceCycle(evidence: TddEvidence, updated: TddCycleEvidence): TddCycleEvidence[] {
  return evidence.cycles.map(c => c.cycleId === updated.cycleId ? updated : c)
}

function bumpRevision(evidence: TddEvidence): TddEvidence {
  return { ...evidence, revision: evidence.revision + 1, updatedAt: new Date().toISOString() }
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

function digestEqual(a: VersionedDigest | null, b: VersionedDigest | null): boolean {
  if (a === null || b === null) return a === b
  return a.algorithm === b.algorithm && a.value === b.value
}

/**
 * 判断 RED failure 是否有效：
 * 只有 assertion 和 missing-behavior 才是有效的 RED failure。
 */
function isValidRedFailure(failureKind: string | null): boolean {
  return failureKind === "assertion" || failureKind === "missing-behavior"
}

// ─── 公开函数 ───

/**
 * 创建初始 TddEvidence（status=not-recorded, revision=0）。
 */
export function createTaskEvidence(): TddEvidence {
  return {
    revision: 0,
    reworkRevision: 0,
    status: "not-recorded",
    taskStart: { status: "pending", headSha: null, treeSha: null, startedAt: null },
    cycles: [],
    regression: { status: "pending", headSha: null, treeSha: null, reworkRevision: 0, runs: [] },
    verification: { status: "pending", headSha: null, treeSha: null, runs: [] },
    alternativeValidation: [],
    reworks: [],
    warnings: [],
    updatedAt: null,
  }
}

/**
 * 启动一个新的 TDD cycle。
 *
 * 验证：
 * - criterion 存在且 verification=tdd
 * - testPaths 匹配 testFilePatterns
 * - 同 cycleId + 同 workspace digest → 幂等返回原 evidence
 * - 同 cycleId + 不同 workspace digest → CYCLE_CONFLICT
 */
export function startCycle(
  evidence: TddEvidence,
  cycleId: string,
  criterionId: string,
  testPaths: string[],
  testSelector: string,
  workspaceDigest: VersionedDigest,
  acceptanceCriteria: AcceptanceCriterion[],
  testFilePatterns: string[],
): StateResult<{ evidence: TddEvidence; cycle: TddCycleEvidence }> {
  // ── 验证 criterion 存在且为 tdd ──
  const criterion = acceptanceCriteria.find(c => c.id === criterionId)
  if (!criterion || criterion.verification !== "tdd") {
    return {
      ok: false,
      error: { code: "CRITERION_NOT_FOUND", message: `Criterion "${criterionId}" not found or not verification=tdd` },
    }
  }

  // ── 验证 testPaths 匹配 testFilePatterns ──
  for (const tp of testPaths) {
    if (!matchesAnyPattern(tp, testFilePatterns)) {
      return {
        ok: false,
        error: { code: "POLICY_INVALID", message: `Test path "${tp}" does not match testFilePatterns` },
      }
    }
  }

  // ── 检查已有 cycle ──
  const existing = findCycle(evidence, cycleId)
  if (existing) {
    // 幂等：相同 workspace digest
    if (digestEqual(existing.startWorkspaceDigest, workspaceDigest)) {
      return { ok: true, value: { evidence, cycle: existing } }
    }
    // 冲突
    return {
      ok: false,
      error: { code: "CYCLE_CONFLICT", message: `Cycle "${cycleId}" already exists with different workspace digest` },
    }
  }

  // ── 创建新 cycle ──
  const cycle: TddCycleEvidence = {
    cycleId,
    criterionId,
    reworkRevision: evidence.reworkRevision,
    status: "started",
    startWorkspaceDigest: workspaceDigest,
    testFiles: testPaths,
    redTestDigest: null,
    redAttempts: [],
    greenAttempts: [],
  }

  const newEvidence = bumpRevision({
    ...evidence,
    status: evidence.status === "not-recorded" ? "in-progress" : evidence.status,
    cycles: [...evidence.cycles, cycle],
  })

  return { ok: true, value: { evidence: newEvidence, cycle } }
}

/**
 * 记录 RED 尝试。
 *
 * 验证：
 * - cycle 存在且 status ∈ {started, red}
 * - failureKind 为 assertion 或 missing-behavior（有效 RED）
 * - 幂等：相同 outputDigest → 返回原结果
 */
export function recordRed(
  evidence: TddEvidence,
  cycleId: string,
  redEvidence: TddCommandEvidence,
): StateResult<{ evidence: TddEvidence; cycle: TddCycleEvidence }> {
  const existing = findCycle(evidence, cycleId)
  if (!existing) {
    return {
      ok: false,
      error: { code: "CYCLE_CONFLICT", message: `Cycle "${cycleId}" not found` },
    }
  }

  // cycle 必须处于 started 或 red 状态
  if (existing.status !== "started" && existing.status !== "red") {
    return {
      ok: false,
      error: { code: "INVALID_TRANSITION", message: `Cycle "${cycleId}" is in "${existing.status}" state, cannot record RED` },
    }
  }

  // ── 失败分类校验 ──
  const exitCode = redEvidence.exitCode

  // 测试通过（exitCode === 0）→ RED_EXPECTED_FAILURE
  if (exitCode === 0) {
    return {
      ok: false,
      error: { code: "RED_EXPECTED_FAILURE", message: "RED requires test failure (exitCode !== 0)" },
    }
  }

  // timeout
  if (redEvidence.failureKind === "timeout") {
    return {
      ok: false,
      error: { code: "COMMAND_TIMEOUT", message: "Test execution timed out" },
    }
  }

  // infrastructure 或 unknown → 不算 RED
  if (!isValidRedFailure(redEvidence.failureKind)) {
    return {
      ok: false,
      error: { code: "RED_INFRASTRUCTURE_FAILURE", message: `Failure kind "${redEvidence.failureKind}" is not a valid RED failure (expected assertion or missing-behavior)` },
    }
  }

  // ── 幂等检查：相同 outputDigest ──
  const dup = existing.redAttempts.find(a => digestEqual(a.outputDigest, redEvidence.outputDigest))
  if (dup) {
    // 已经记录过相同的 RED，返回原 evidence（不修改）
    return { ok: true, value: { evidence, cycle: existing } }
  }

  // ── 记录 RED ──
  const updatedCycle: TddCycleEvidence = {
    ...existing,
    status: "red",
    redTestDigest: redEvidence.executionInputDigest,
    redAttempts: [...existing.redAttempts, redEvidence],
  }

  const newEvidence = bumpRevision({
    ...evidence,
    cycles: replaceCycle(evidence, updatedCycle),
  })

  return { ok: true, value: { evidence: newEvidence, cycle: updatedCycle } }
}

/**
 * 记录 GREEN 尝试。
 *
 * 验证：
 * - cycle 存在且已有有效 RED（redTestDigest !== null）
 * - GREEN exitCode === 0
 * - implementation files 有变化
 * - 幂等：相同 outputDigest → 返回原结果
 */
export function recordGreen(
  evidence: TddEvidence,
  cycleId: string,
  greenEvidence: TddCommandEvidence,
  implementationFilesChanged: boolean,
): StateResult<{ evidence: TddEvidence; cycle: TddCycleEvidence }> {
  const existing = findCycle(evidence, cycleId)
  if (!existing) {
    return {
      ok: false,
      error: { code: "CYCLE_CONFLICT", message: `Cycle "${cycleId}" not found` },
    }
  }

  // 必须有 RED
  if (existing.redTestDigest === null || existing.redAttempts.length === 0) {
    return {
      ok: false,
      error: { code: "INVALID_TRANSITION", message: `Cycle "${cycleId}" has no RED recorded` },
    }
  }

  // GREEN 测试必须通过
  if (greenEvidence.exitCode !== 0) {
    return {
      ok: false,
      error: { code: "GREEN_EXPECTED_PASS", message: "GREEN requires all tests to pass (exitCode === 0)" },
    }
  }

  // 必须有实现变化
  if (!implementationFilesChanged) {
    return {
      ok: false,
      error: { code: "IMPLEMENTATION_CHANGE_REQUIRED", message: "GREEN requires implementation file changes" },
    }
  }

  // ── 幂等检查：相同 outputDigest ──
  const dup = existing.greenAttempts.find(a => digestEqual(a.outputDigest, greenEvidence.outputDigest))
  if (dup) {
    return { ok: true, value: { evidence, cycle: existing } }
  }

  // ── 记录 GREEN ──
  const updatedCycle: TddCycleEvidence = {
    ...existing,
    status: "pass",
    greenAttempts: [...existing.greenAttempts, greenEvidence],
  }

  const newEvidence = bumpRevision({
    ...evidence,
    cycles: replaceCycle(evidence, updatedCycle),
  })

  return { ok: true, value: { evidence: newEvidence, cycle: updatedCycle } }
}

/**
 * 记录最终 regression 结果。
 *
 * 验证：
 * - runs 非空
 * - 所有 run exitCode === 0 且无 timeout 则 pass，否则 fail
 */
export function recordFinalRegression(
  evidence: TddEvidence,
  headSha: string,
  treeSha: string,
  runs: TddCommandEvidence[],
): StateResult<TddEvidence> {
  if (runs.length === 0) {
    return {
      ok: false,
      error: { code: "REGRESSION_FAILED", message: "Regression requires at least one run" },
    }
  }

  const allPass = runs.every(r => r.exitCode === 0 && r.failureKind !== "timeout")
  const status = allPass ? "pass" : "fail"

  const newEvidence = bumpRevision({
    ...evidence,
    regression: {
      status,
      headSha,
      treeSha,
      reworkRevision: evidence.reworkRevision,
      runs,
    },
  })

  return { ok: true, value: newEvidence }
}

/**
 * 记录最终 verification 结果。
 *
 * 规则：
 * - runs 为空 → pass（未配置 verifyCommands）
 * - 所有 run exitCode === 0 则 pass，否则 fail
 */
export function recordFinalVerification(
  evidence: TddEvidence,
  headSha: string,
  treeSha: string,
  runs: TddCommandEvidence[],
): StateResult<TddEvidence> {
  if (runs.length === 0) {
    // 未配置 verifyCommands，视为 pass
    const newEvidence = bumpRevision({
      ...evidence,
      verification: {
        status: "pass",
        headSha,
        treeSha,
        runs: [],
      },
    })
    return { ok: true, value: newEvidence }
  }

  const allPass = runs.every(r => r.exitCode === 0)
  const status = allPass ? "pass" : "fail"

  const newEvidence = bumpRevision({
    ...evidence,
    verification: {
      status,
      headSha,
      treeSha,
      runs,
    },
  })

  return { ok: true, value: newEvidence }
}

/**
 * 放弃一个 cycle。
 *
 * 规则：
 * - cycle 必须存在
 * - cycle 状态不能是 "pass"（已通过的 cycle 不能放弃）
 * - 保留审计记录，reason 写入 warnings
 */
export function abandonCycle(
  evidence: TddEvidence,
  cycleId: string,
  reason: string,
): StateResult<TddEvidence> {
  const existing = findCycle(evidence, cycleId)
  if (!existing) {
    return {
      ok: false,
      error: { code: "CYCLE_CONFLICT", message: `Cycle "${cycleId}" not found` },
    }
  }

  if (existing.status === "pass") {
    return {
      ok: false,
      error: { code: "INVALID_TRANSITION", message: `Cannot abandon cycle "${cycleId}" that has already passed` },
    }
  }

  const updatedCycle: TddCycleEvidence = {
    ...existing,
    status: "abandoned",
  }

  const newEvidence = bumpRevision({
    ...evidence,
    cycles: replaceCycle(evidence, updatedCycle),
    warnings: [...evidence.warnings, reason],
  })

  return { ok: true, value: newEvidence }
}

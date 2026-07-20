import type {
  TddPolicy,
  TddEvidence,
  AcceptanceCriterion,
} from "./types.js"

/**
 * evaluateTddCompliance 的结果类型。
 *
 * - status = pass    → 合规（advisory 下缺口记 warning）
 * - status = fail    → 不合规，阻断
 * - status = waived  → 豁免（bypass 模式下替代验证全部通过）
 */
export interface EvaluationResult {
  status: "pass" | "fail" | "waived"
  warnings: string[]
}

/**
 * 判定 TDD 模式是否合规的纯函数。
 *
 * 规则（参见 Spec Section 4.3）：
 *
 * **strict**：
 * - 必须至少有一个 verification=tDD 的 criterion
 * - 每个 TDD criterion 都必须有 status=pass 的 cycle 覆盖
 * - verification=regression 的 criterion 由 final regression 覆盖
 * - verification=manual 不允许在 strict 模式下使用
 * - final regression 和 final verification 必须 pass
 *
 * **relaxed**：
 * - 仅要求 final regression 为 pass，不检查 cycle
 * - final verification 必须 pass
 *
 * **bypass**：
 * - 必须有 exception 且其 alternativeValidation 全部完成（evidence 中对应 status=pass）
 * - final verification 仍必须 pass
 * - 不要求 runner / cycle / regression
 *
 * **enforcement**：
 * - advisory：缺失 evidence 仅产生 warning，不阻断（仍返回 pass/waived）
 * - runtime：缺失 evidence 直接阻断（返回 fail）
 */
export function evaluateTddCompliance(
  policy: TddPolicy,
  evidence: TddEvidence,
  criteria: AcceptanceCriterion[]
): EvaluationResult {
  const warnings: string[] = []
  const isAdvisory = policy.enforcement === "advisory"

  // ── 通用检查：final verification ──

  const verificationOk = evidence.verification.status === "pass"
  if (!verificationOk) {
    if (isAdvisory) {
      warnings.push("final verification 未通过（advisory 模式：仅记录 warning）")
    } else {
      warnings.push("final verification 未通过")
      return { status: "fail", warnings }
    }
  }

  // ── bypass 模式 ──

  if (policy.mode === "bypass") {
    return evaluateBypass(policy, evidence, isAdvisory, warnings, verificationOk)
  }

  // ── strict 模式 ──

  if (policy.mode === "strict") {
    return evaluateStrict(policy, evidence, criteria, isAdvisory, warnings, verificationOk)
  }

  // ── relaxed 模式 ──

  return evaluateRelaxed(evidence, isAdvisory, warnings, verificationOk)
}

// ── 私有辅助函数 ──

function evaluateBypass(
  policy: TddPolicy,
  evidence: TddEvidence,
  isAdvisory: boolean,
  warnings: string[],
  verificationOk: boolean
): EvaluationResult {
  // bypass 必须有 exception
  if (!policy.exception) {
    if (isAdvisory) {
      warnings.push("bypass 模式缺少 exception（advisory 模式：仅记录 warning）")
      return { status: "waived", warnings }
    }
    warnings.push("bypass 模式缺少 exception")
    return { status: "fail", warnings }
  }

  // verification 失败时已在主函数中返回 fail，此处 verificationOk 保证为 true（或 advisory 已记 warning）
  if (!verificationOk) {
    // advisory 下 verification 失败已记 warning，继续检查替代验证
    // 统一返回 waived（advisory 不阻断）
    if (isAdvisory) {
      checkAltValidations(policy, evidence, isAdvisory, warnings)
      return { status: "waived", warnings }
    }
    return { status: "fail", warnings }
  }

  // 检查替代验证
  const altOk = checkAltValidations(policy, evidence, isAdvisory, warnings)

  if (isAdvisory) {
    return { status: "waived", warnings }
  }

  if (!altOk) {
    return { status: "fail", warnings }
  }

  return { status: "waived", warnings: warnings.filter(w => w.length > 0) }
}

function evaluateStrict(
  policy: TddPolicy,
  evidence: TddEvidence,
  criteria: AcceptanceCriterion[],
  isAdvisory: boolean,
  warnings: string[],
  verificationOk: boolean
): EvaluationResult {
  // verification 已前置检查，runtime 下失败则已在主函数返回 fail
  if (!verificationOk && !isAdvisory) {
    return { status: "fail", warnings }
  }

  const tddCriteria = criteria.filter(c => c.verification === "tdd")
  const regressionCriteria = criteria.filter(c => c.verification === "regression")
  const manualCriteria = criteria.filter(c => c.verification === "manual")

  let hasFailure = false

  // strict 必须至少有一个 TDD criterion
  if (tddCriteria.length === 0) {
    if (isAdvisory) {
      warnings.push("strict 模式要求至少一个 verification=tdd 的 criterion（advisory 模式：仅记录 warning）")
    } else {
      warnings.push("strict 模式要求至少一个 verification=tdd 的 criterion")
      hasFailure = true
    }
  }

  // manual criterion 不允许在 strict 模式
  if (manualCriteria.length > 0) {
    if (isAdvisory) {
      warnings.push(`strict 模式不允许 verification=manual 的 criterion: ${manualCriteria.map(c => c.id).join(", ")}（advisory 模式：仅记录 warning）`)
    } else {
      warnings.push(`strict 模式不允许 verification=manual 的 criterion: ${manualCriteria.map(c => c.id).join(", ")}`)
      hasFailure = true
    }
  }

  // 每个 TDD criterion 都需要有 pass cycle 覆盖
  for (const c of tddCriteria) {
    const matchingCycles = evidence.cycles.filter(cycle => cycle.criterionId === c.id)
    const hasPassCycle = matchingCycles.some(cycle => cycle.status === "pass")

    if (!hasPassCycle) {
      if (isAdvisory) {
        warnings.push(`TDD criterion "${c.id}" 缺少有效 cycle（advisory 模式：仅记录 warning）`)
      } else {
        warnings.push(`TDD criterion "${c.id}" 缺少有效 cycle`)
        hasFailure = true
      }
    }
  }

  // regression criterion 由 final regression 覆盖
  if (regressionCriteria.length > 0) {
    const regressionOk = evidence.regression.status === "pass"
    if (!regressionOk) {
      if (isAdvisory) {
        warnings.push("final regression 未通过，无法覆盖 regression criterion（advisory 模式：仅记录 warning）")
      } else {
        warnings.push("final regression 未通过，无法覆盖 regression criterion")
        hasFailure = true
      }
    }
  }

  if (isAdvisory) {
    return { status: "pass", warnings }
  }

  if (hasFailure) {
    return { status: "fail", warnings }
  }

  return { status: "pass", warnings }
}

function evaluateRelaxed(
  evidence: TddEvidence,
  isAdvisory: boolean,
  warnings: string[],
  verificationOk: boolean
): EvaluationResult {
  if (!verificationOk && !isAdvisory) {
    return { status: "fail", warnings }
  }

  const regressionOk = evidence.regression.status === "pass"

  if (!regressionOk) {
    if (isAdvisory) {
      warnings.push("relaxed 模式要求 final regression 通过（advisory 模式：仅记录 warning）")
      return { status: "pass", warnings }
    }
    warnings.push("relaxed 模式要求 final regression 通过")
    return { status: "fail", warnings }
  }

  return { status: "pass", warnings }
}

/**
 * 检查 bypass 模式下所有 alternative validation 是否完成。
 * 返回 true 表示全部通过，false 表示有缺失或失败。
 */
function checkAltValidations(
  policy: TddPolicy,
  evidence: TddEvidence,
  isAdvisory: boolean,
  warnings: string[]
): boolean {
  if (!policy.exception) {
    return false
  }

  let allOk = true

  for (const av of policy.exception.alternativeValidation) {
    const matchingEvidence = evidence.alternativeValidation.filter(ev => ev.validationId === av.validationId)
    const hasPass = matchingEvidence.some(ev => ev.status === "pass")

    if (!hasPass) {
      if (isAdvisory) {
        warnings.push(`替代验证 "${av.validationId}" 未完成（advisory 模式：仅记录 warning）`)
      } else {
        warnings.push(`替代验证 "${av.validationId}" 未完成`)
        allOk = false
      }
    }
  }

  return allOk
}

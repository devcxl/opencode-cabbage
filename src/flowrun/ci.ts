import { createHash } from "node:crypto"
import type {
  RepositoryQualityPolicy, TaskCommand, CoveragePolicy,
} from "./types.js"

// ─── 类型 ───

/** 从 gh pr view --json statusCheckRollup 获取的 PR 检查结果 */
export interface PRCheckResult {
  context: string
  state: "EXPECTED" | "ERROR" | "FAILURE" | "PENDING" | "SUCCESS"
  app: { id: number; name: string } | null
}

/** checkRequiredChecks 的返回结果 */
export interface CICheckResult {
  allPassed: boolean
  missingContexts: string[]
  failedContexts: string[]
  pendingContexts: string[]
  untrustedSources: Array<{
    context: string
    expectedAppId: number
    actualAppId: number | null
  }>
}

/** validateRequiredWorkflow 的返回结果 */
export interface RequiredWorkflowValidation {
  valid: boolean
  errors: string[]
}

// ─── checkRequiredChecks ───

/**
 * 验证 PR 的状态检查是否满足 RepositoryQualityPolicy 中定义的 required checks。
 *
 * 规则：
 * - mode 为 "off" 时不校验，直接返回 allPassed: true
 * - mode 为 "required" 时：
 *   1. 每个 requiredChecks 中的 context 必须在 PR checks 中存在
 *   2. 状态必须为 SUCCESS
 *   3. 发布该 check 的 GitHub App ID 必须与配置的 appId 匹配
 *      （appId 为 0 时不校验来源）
 */
export function checkRequiredChecks(
  policy: RepositoryQualityPolicy,
  prChecks: PRCheckResult[],
): CICheckResult {
  // mode off — 不增加额外约束
  if (policy.mode === "off") {
    return {
      allPassed: true,
      missingContexts: [],
      failedContexts: [],
      pendingContexts: [],
      untrustedSources: [],
    }
  }

  // mode required — 逐项验证
  const prCheckMap = new Map<string, PRCheckResult>()
  for (const c of prChecks) {
    prCheckMap.set(c.context, c)
  }

  const missingContexts: string[] = []
  const failedContexts: string[] = []
  const pendingContexts: string[] = []
  const untrustedSources: CICheckResult["untrustedSources"] = []

  for (const required of policy.requiredChecks) {
    const prCheck = prCheckMap.get(required.context)

    // 1. context 缺失
    if (!prCheck) {
      missingContexts.push(required.context)
      continue
    }

    // 2. 状态检查
    if (prCheck.state === "SUCCESS") {
      // 通过 — 继续检查来源
    } else if (prCheck.state === "PENDING" || prCheck.state === "EXPECTED") {
      pendingContexts.push(required.context)
      continue
    } else {
      // FAILURE, ERROR
      failedContexts.push(required.context)
      continue
    }

    // 3. 来源验证（appId 为 0 时不校验）
    if (required.appId !== 0) {
      if (!prCheck.app || prCheck.app.id !== required.appId) {
        untrustedSources.push({
          context: required.context,
          expectedAppId: required.appId,
          actualAppId: prCheck.app?.id ?? null,
        })
      }
    }
  }

  const allPassed =
    missingContexts.length === 0 &&
    failedContexts.length === 0 &&
    pendingContexts.length === 0 &&
    untrustedSources.length === 0

  return {
    allPassed,
    missingContexts,
    failedContexts,
    pendingContexts,
    untrustedSources,
  }
}

// ─── validateRequiredWorkflow ───

/**
 * 验证 RepositoryQualityPolicy 的 requiredChecks 配置有效性。
 *
 * 规则：
 * - mode 为 "off" 时跳过所有校验
 * - mode 为 "required" 时：
 *   1. requiredChecks 不能为空
 *   2. 每个 entry 必须有 workflowPath、workflowRef
 *   3. 不允许重复的 context
 */
export function validateRequiredWorkflow(
  policy: RepositoryQualityPolicy,
): RequiredWorkflowValidation {
  // mode off — 无需校验
  if (policy.mode === "off") {
    return { valid: true, errors: [] }
  }

  const errors: string[] = []

  // 1. requiredChecks 不能为空
  if (policy.requiredChecks.length === 0) {
    errors.push("requiredChecks must not be empty when mode is 'required'")
    return { valid: false, errors }
  }

  // 2. 校验每个 entry
  const seenContexts = new Set<string>()

  for (let i = 0; i < policy.requiredChecks.length; i++) {
    const entry = policy.requiredChecks[i]
    const prefix = `requiredChecks[${i}]`

    // 检查 context 重复
    if (seenContexts.has(entry.context)) {
      errors.push(`${prefix}: duplicate context "${entry.context}"`)
    }
    seenContexts.add(entry.context)

    // 检查 workflowPath
    if (!entry.workflowPath) {
      errors.push(`${prefix}: workflowPath must not be empty`)
    }

    // 检查 workflowRef
    if (!entry.workflowRef) {
      errors.push(`${prefix}: workflowRef must not be empty`)
    }
  }

  return { valid: errors.length === 0, errors }
}

// ─── checkBranchProtection ───

/**
 * checkBranchProtection 委托给 merge.ts 中已有的实现。
 * 这里作为 re-export wrapper，保持 CI 模块的 API 统一性。
 */

export { checkBranchProtection } from "./merge.js"

// ─── computeQualityContractDigest ───

/**
 * JCS (JSON Canonicalization Scheme) 序列化：
 * - 对象的 key 按 UTF-8 字节序排序
 * - 无多余空白
 * - 数字保留原始精度
 */
function jcsStringify(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") {
    if (Number.isFinite(value)) {
      // 使用标准数字序列化
      return String(value)
    }
    return "null"
  }
  if (typeof value === "string") {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    const items = value.map(jcsStringify)
    return `[${items.join(",")}]`
  }
  if (typeof value === "object") {
    // 按 key 排序
    const keys = Object.keys(value).sort((a, b) => {
      const bufA = Buffer.from(a, "utf-8")
      const bufB = Buffer.from(b, "utf-8")
      return Buffer.compare(bufA, bufB)
    })
    const pairs = keys.map(k => {
      const v = (value as Record<string, unknown>)[k]
      return `${JSON.stringify(k)}:${jcsStringify(v)}`
    })
    return `{${pairs.join(",")}}`
  }
  return "null"
}

/**
 * 计算质量契约摘要（Quality Contract Digest）。
 *
 * 绑定 testCommands + verifyCommands + coveragePolicy，
 * 使用 JCS (JSON Canonicalization Scheme) + SHA-256 生成确定性摘要。
 *
 * 用于在 PR checkpoint 中记录期望的契约版本，确保 CI 执行时契约未被修改。
 */
export function computeQualityContractDigest(
  testCommands: TaskCommand[],
  verifyCommands: TaskCommand[],
  coveragePolicy: CoveragePolicy | null,
): string {
  const contract = {
    testCommands,
    verifyCommands,
    coveragePolicy,
  }

  const json = jcsStringify(contract)
  return createHash("sha256").update(json, "utf-8").digest("hex")
}

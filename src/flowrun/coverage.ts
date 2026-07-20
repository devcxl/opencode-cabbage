import { readFile, lstat, realpath } from "node:fs/promises"
import { resolve, isAbsolute, join, normalize } from "node:path"
import { createHash } from "node:crypto"
import type { CoverageEvidence } from "./types.js"

// ─── 常量 ───

const DANGEROUS_PATH = /[\x00-\x1f\x7f]/

// ─── 路径安全校验 ───

/**
 * 检验 coverage report 路径的安全性。
 *
 * 规则：
 * - 拒绝空路径
 * - 拒绝绝对路径
 * - 拒绝包含 null 字节等危险字符的路径
 * - 拒绝包含 `..` 路径遍历的路径
 *
 * 注意：此函数仅检查路径结构，不处理 symlink。symlink 检查由 resolveCoveragePath 通过 realpath 完成。
 */
export function validateCoveragePath(reportPath: string, sandboxRoot: string): void {
  if (!reportPath || reportPath.trim() === "") {
    throw new Error("Coverage report path is empty")
  }

  if (DANGEROUS_PATH.test(reportPath)) {
    throw new Error(`Coverage report path contains dangerous characters: ${reportPath}`)
  }

  const normalized = normalize(reportPath)

  if (isAbsolute(normalized)) {
    throw new Error("Coverage report path must be relative, got absolute path")
  }

  // 拒绝路径穿越：以 .. 开头或包含 /../
  const segments = normalized.split("/")
  if (segments.includes("..") || segments.includes("..\\")) {
    throw new Error(`Coverage report path escapes sandbox: ${reportPath}`)
  }

  // 拒绝 Windows 风格的路径穿越
  const winSegments = normalized.split("\\")
  if (winSegments.includes("..")) {
    throw new Error(`Coverage report path escapes sandbox: ${reportPath}`)
  }
}

/**
 * 在 sandbox 内安全地解析 coverage report 路径。
 *
 * 1. 先执行 validateCoveragePath 结构检查
 * 2. join sandbox + reportPath
 * 3. resolve 后确保不逃逸 sandbox
 * 4. （调用方负责）通过 realpath 检查 symlink 逃逸
 *
 * 返回解析后的绝对路径。
 */
export function resolveCoveragePath(reportPath: string, sandboxRoot: string): string {
  // 步骤 1: 结构检查
  validateCoveragePath(reportPath, sandboxRoot)

  // 步骤 2: 拼接并解析
  const sandboxNorm = resolve(sandboxRoot)
  const resolved = resolve(join(sandboxNorm, reportPath))

  // 步骤 3: 确保未逃逸 sandbox
  if (!resolved.startsWith(sandboxNorm + "/") && resolved !== sandboxNorm) {
    throw new Error(`Coverage report path resolves outside sandbox: ${reportPath} → ${resolved}`)
  }

  return resolved
}

// ─── Coverage 报告解析 ───

interface RawCoverageSummary {
  total?: {
    lines?: {
      total?: number
      covered?: number
      skipped?: number
      pct?: unknown
    }
    [key: string]: unknown
  }
  [key: string]: unknown
}

export interface ParsedCoverageData {
  actual: number
  metric: "lines"
}

/**
 * 解析 istanbul-json-summary 格式的 coverage 报告。
 *
 * 抽取 `total.lines.pct`，执行严格的数值校验：
 * - 拒绝缺少 `total.lines` 字段
 * - 拒绝 `pct` 为 non-number、NaN、`"Unknown"` 等非数值
 * - 拒绝 `pct` 超出 [0, 100] 范围
 *
 * 返回 ParsedCoverageData 或 null（解析失败/数据无效）。
 */
export async function parseCoverageReport(
  reportPath: string,
  metric: "lines",
): Promise<ParsedCoverageData | null> {
  let raw: string
  try {
    raw = await readFile(reportPath, "utf-8")
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null
  }

  const report = parsed as RawCoverageSummary

  // 检查 total 对象
  const total = report.total
  if (!total || typeof total !== "object") {
    return null
  }

  // 检查 lines 对象
  const lines = total.lines
  if (!lines || typeof lines !== "object") {
    return null
  }

  // 提取并校验 pct
  const pct = lines.pct

  // 拒绝 "Unknown" 字符串值
  if (typeof pct === "string") {
    return null
  }

  // 拒绝非 number 类型
  if (typeof pct !== "number") {
    return null
  }

  // 拒绝 NaN
  if (isNaN(pct)) {
    return null
  }

  // 拒绝无穷大
  if (!isFinite(pct)) {
    return null
  }

  // 拒绝范围外数值
  if (pct < 0 || pct > 100) {
    return null
  }

  return {
    actual: pct,
    metric,
  }
}

// ─── Coverage Evidence 构建 ───

export interface BuildCoverageEvidenceInput {
  actual: number | null
  threshold: number
  metric: "lines"
  headSha: string
  reportDigest: string | null
}

/**
 * 构建 CoverageEvidence。
 *
 * - actual >= threshold → pass
 * - actual < threshold → fail
 * - actual 为 null → pending（报告解析失败或不存在）
 */
export function buildCoverageEvidence(input: BuildCoverageEvidenceInput): CoverageEvidence {
  let status: CoverageEvidence["status"]
  let summary: string

  if (input.actual === null) {
    status = "pending"
    summary = `Coverage report not available or could not be parsed for head ${input.headSha.slice(0, 7)}`
  } else if (input.actual >= input.threshold) {
    status = "pass"
    summary = `Coverage ${input.actual}% meets threshold ${input.threshold}% (${input.metric}) at head ${input.headSha.slice(0, 7)}`
  } else {
    status = "fail"
    summary = `Coverage ${input.actual}% below threshold ${input.threshold}% (${input.metric}) at head ${input.headSha.slice(0, 7)}`
  }

  return {
    status,
    headSha: input.headSha,
    actual: input.actual,
    threshold: input.threshold,
    metric: input.metric,
    reportDigest: input.reportDigest,
    summary,
  }
}

/**
 * 简单的阈值校验（纯数字比较）。
 */
export function checkCoverageThreshold(actual: number, threshold: number): boolean {
  return actual >= threshold
}

/**
 * 对 coverage report 文件计算 digest。
 * 用于绑定 report 内容与 evidence。
 */
export async function computeReportDigest(reportPath: string): Promise<string | null> {
  try {
    const content = await readFile(reportPath)
    const hash = createHash("sha256")
    hash.update(content)
    return hash.digest("hex")
  } catch {
    return null
  }
}

/**
 * 检查 symlink 是否逃逸 sandbox。
 * 在 resolveCoveragePath 之后调用，对已解析路径做 realpath 检查。
 *
 * 返回 safe absolute path，或抛出错误。
 */
export async function verifySymlinkSafe(
  resolvedPath: string,
  sandboxRoot: string,
): Promise<string> {
  const sandboxNorm = resolve(sandboxRoot)

  let lstatResult
  try {
    lstatResult = await lstat(resolvedPath)
  } catch {
    // 文件不存在，由调用方处理
    return resolvedPath
  }

  if (lstatResult.isSymbolicLink()) {
    const real = await realpath(resolvedPath)
    const realNorm = resolve(real)
    if (!realNorm.startsWith(sandboxNorm + "/") && realNorm !== sandboxNorm) {
      throw new Error(`Symlink escapes sandbox: ${resolvedPath} → ${realNorm}`)
    }
    return realNorm
  }

  return resolvedPath
}

import { appendTddEvidence } from "../records.js"
import { computeWorkspaceDigest, type DigestOptions } from "./digest.js"
import type { TddFailureKind, VersionedDigest } from "../types.js"

// ─── 基线记录（worktree-start 时快照） ───

/** worktree-start 时记录的干净基线快照 */
export interface WorkspaceBaseline {
  digest: VersionedDigest
  capturedAt: string
  testFilePatterns: string[]
  implementationFilePatterns: string[]
}

/**
 * 计算 worktree 的干净基线 digest 快照。
 * 供 task_control start-task 在 worktree-start 时调用，作为 RED 阶段
 * "实现文件相对基线未变" 与 GREEN "输入未偷换" 校验的基准。
 */
export async function captureWorkspaceBaseline(
  worktreeDir: string,
  options: DigestOptions,
): Promise<WorkspaceBaseline> {
  const digest = await computeWorkspaceDigest(worktreeDir, options)
  return {
    digest,
    capturedAt: new Date().toISOString(),
    testFilePatterns: options.testFilePatterns,
    implementationFilePatterns: options.implementationFilePatterns,
  }
}

// ─── evidence block 组装 ───

/** 组装 evidence block 的输入（criterion/cycle/命令/exit code/failure kind/digest/状态） */
export interface EvidenceBlockInput {
  stage: string
  criterionId?: string
  cycleId?: string
  command: string
  testSelector: string | null
  exitCode: number | null
  failureKind: TddFailureKind | null
  status: string
  workspaceDigest: VersionedDigest | null
  summary: string
}

/**
 * 将结构化证据组装为可追加到 Task Record 受控 comment 的 markdown block。
 * 纯函数：内容含 criterion、cycle、命令、exit code、failure kind、digest、状态、summary。
 */
export function buildEvidenceBlock(input: EvidenceBlockInput): string {
  const lines = [`### stage: ${input.stage}`]
  if (input.criterionId) lines.push(`- criterion: ${input.criterionId}`)
  if (input.cycleId) lines.push(`- cycle: ${input.cycleId}`)
  lines.push(`- command: \`${input.command}\``)
  if (input.testSelector) lines.push(`- selector: \`${input.testSelector}\``)
  lines.push(`- exitCode: ${input.exitCode ?? "null"}`)
  lines.push(`- failureKind: ${input.failureKind ?? "null"}`)
  lines.push(`- status: ${input.status}`)
  if (input.workspaceDigest) {
    lines.push(`- workspaceDigest: ${input.workspaceDigest.algorithm}:${input.workspaceDigest.value}`)
  }
  lines.push(`- summary: ${input.summary}`)
  return lines.join("\n")
}

// ─── evidence 追加（复用 records.appendTddEvidence） ───

/**
 * 组装 evidence block 并追加到 Task Record 的单个受控 comment。
 * 委托 records.appendTddEvidence 完成写入（含 mutex 串行与 revision 管理）。
 */
export async function recordTddEvidence(
  issueNumber: number,
  input: EvidenceBlockInput,
): Promise<{ ok: boolean; revision: number; error?: string }> {
  const block = buildEvidenceBlock(input)
  return appendTddEvidence(issueNumber, block)
}

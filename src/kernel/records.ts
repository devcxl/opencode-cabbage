import { gh as ghCli } from "../util/gh.js"
import { escapeShellArg } from "../util/shell.js"
import { KeyedMutex } from "./mutex.js"
import type { FlowRecordRef, TaskRecordRef } from "./types.js"

/** TDD evidence 受控 comment 的 marker（单个 comment 承载全部证据） */
export const EVIDENCE_MARKER_START = "<!-- cabbage-tdd-evidence:start -->"
export const EVIDENCE_MARKER_END = "<!-- cabbage-tdd-evidence:end -->"

/** Flow Record（Parent Issue）标签 */
export const FLOW_LABEL = "cabbage:flow"
/** 阶段标签前缀：cabbage:stage:<stage> */
export const STAGE_LABEL_PREFIX = "cabbage:stage:"

// ─── 可替换的 gh executor（用于测试） ───

type GhFn = (args: string) => Promise<{ stdout: string; stderr: string }>

let recordsGhExecutor: GhFn | null = null

export function setRecordsGhExecutor(fn: GhFn | null): void {
  recordsGhExecutor = fn
}

async function gh(args: string, timeout?: number): Promise<{ stdout: string; stderr: string }> {
  if (recordsGhExecutor) {
    return recordsGhExecutor(args)
  }
  return ghCli(args, timeout)
}

// ─── evidence comment 纯函数 ───

/** 构造 marker 包裹的受控 comment body，START marker 行内携带 revision */
export function buildEvidenceCommentBody(block: string, revision: number): string {
  return `${EVIDENCE_MARKER_START} revision:${revision}\n${block}\n${EVIDENCE_MARKER_END}`
}

/** 从受控 comment body 提取 revision 与 marker 区间内容；无 marker 或畸形返回 null */
export function extractEvidenceBlock(body: string): { revision: number; content: string } | null {
  const startIdx = body.indexOf(EVIDENCE_MARKER_START)
  const endIdx = body.indexOf(EVIDENCE_MARKER_END)
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
    return null
  }

  const newlineAfterStart = body.indexOf("\n", startIdx)
  if (newlineAfterStart === -1 || newlineAfterStart > endIdx) {
    return null
  }

  const header = body.slice(startIdx, newlineAfterStart)
  const revisionMatch = header.match(/revision:(\d+)/)
  if (!revisionMatch) {
    return null
  }

  const content = body.slice(newlineAfterStart + 1, endIdx).trim()
  if (content === "") {
    return null
  }

  return { revision: Number(revisionMatch[1]), content }
}

// ─── 记录写入互斥（按 issueNumber 串行） ───

const recordMutex = new KeyedMutex()

async function readBody(issueNumber: number): Promise<string> {
  const { stdout } = await gh(`issue view ${issueNumber} --json body --jq .body`)
  return stdout
}

async function writeBody(issueNumber: number, body: string): Promise<void> {
  const escaped = escapeShellArg(body)
  await gh(`issue edit ${issueNumber} --body '${escaped}'`)
}

// ─── Flow Record CRUD（Parent Issue） ───

export interface CreateFlowRecordInput {
  slug: string
  body: string
}

/** 创建 Draft Parent Issue（Flow Record），打 cabbage:flow 标签 */
export async function createFlowRecord(
  input: CreateFlowRecordInput,
): Promise<{ ok: true; ref: FlowRecordRef } | { ok: false; error: string }> {
  try {
    const escapedBody = escapeShellArg(input.body)
    const { stdout } = await gh(
      `issue create --title '${input.slug}' --body '${escapedBody}' --label '${FLOW_LABEL}' --draft --json number --jq .number`,
    )
    const number = Number(stdout.trim())
    if (!Number.isInteger(number)) {
      throw new Error(`invalid issue number: ${stdout}`)
    }
    return { ok: true, ref: { parentIssueNumber: number, slug: input.slug } }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

export async function readFlowRecord(
  parentIssueNumber: number,
): Promise<{ ok: true; body: string } | { ok: false; code: "NOT_FOUND"; error: string }> {
  try {
    const { stdout } = await gh(`issue view ${parentIssueNumber} --json body --jq .body`)
    return { ok: true, body: stdout }
  } catch (err) {
    return { ok: false, code: "NOT_FOUND", error: String(err) }
  }
}

/**
 * 乐观锁更新 Flow Record body：mutex 串行 + previousBody 比对。
 * 比对不一致（外部并发修改）→ 重读最新 body 重试 1 次（retried: true）。
 */
export async function updateFlowRecord(
  parentIssueNumber: number,
  previousBody: string,
  buildNewBody: (current: string) => string,
): Promise<{ ok: true; retried: boolean } | { ok: false; error: string }> {
  return recordMutex.runExclusive(parentIssueNumber, async () => {
    try {
      const current = await readBody(parentIssueNumber)
      if (current === previousBody) {
        await writeBody(parentIssueNumber, buildNewBody(current))
        return { ok: true as const, retried: false }
      }
      // 冲突：重读最新 body 重试 1 次
      const latest = await readBody(parentIssueNumber)
      await writeBody(parentIssueNumber, buildNewBody(latest))
      return { ok: true as const, retried: true }
    } catch (err) {
      return { ok: false as const, error: String(err) }
    }
  })
}

// ─── Task Record CRUD（Sub Issue） ───

export interface CreateTaskRecordInput {
  title: string
  body: string
  parentIssueNumber: number
}

/** 创建关联 Parent 的 Sub Issue（Task Record） */
export async function createTaskRecord(
  input: CreateTaskRecordInput,
): Promise<{ ok: true; ref: TaskRecordRef } | { ok: false; error: string }> {
  try {
    const escapedBody = escapeShellArg(input.body)
    const { stdout } = await gh(
      `issue create --title '${input.title}' --body '${escapedBody}' --parent ${input.parentIssueNumber} --json number --jq .number`,
    )
    const number = Number(stdout.trim())
    if (!Number.isInteger(number)) {
      throw new Error(`invalid issue number: ${stdout}`)
    }
    return {
      ok: true,
      ref: { parentIssueNumber: input.parentIssueNumber, taskId: input.title, issueNumber: number },
    }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

// ─── TDD evidence 受控 comment ───

export interface TddEvidenceComment {
  id: number
  body: string
  revision: number
}

/** 读取 Task Record 的单个受控 evidence comment；不存在返回 null */
export async function readTddEvidenceComment(issueNumber: number): Promise<TddEvidenceComment | null> {
  try {
    const { stdout } = await gh(
      `issue view ${issueNumber} --json comments --jq '[.comments[] | select(.body | contains("${EVIDENCE_MARKER_START}")) | {id: (.id|tonumber), body}] | first'`,
    )
    const trimmed = stdout.trim()
    if (trimmed === "" || trimmed === "null") {
      return null
    }
    const parsed = JSON.parse(trimmed) as { id: number; body: string }
    const extracted = extractEvidenceBlock(parsed.body)
    if (!extracted) {
      return null
    }
    return { id: parsed.id, body: parsed.body, revision: extracted.revision }
  } catch {
    return null
  }
}

/**
 * 追加 TDD evidence 到 Task Record 的单个受控 comment：
 * 无受控 comment → 新建（revision 1）；有 → marker 区间内 append，revision+1（PATCH 更新）。
 * mutex 按 issueNumber 串行；block 已存在则幂等跳过（追加不重复）。
 */
export async function appendTddEvidence(
  issueNumber: number,
  block: string,
): Promise<{ ok: boolean; revision: number; error?: string }> {
  return recordMutex.runExclusive(issueNumber, async () => {
    try {
      const existing = await readTddEvidenceComment(issueNumber)
      if (!existing) {
        const body = buildEvidenceCommentBody(block, 1)
        await gh(`issue comment ${issueNumber} --body '${escapeShellArg(body)}'`)
        return { ok: true as const, revision: 1 }
      }

      // 幂等：block 已在 marker 区间内，不重复追加
      const extracted = extractEvidenceBlock(existing.body)
      if (extracted && extracted.content.includes(block)) {
        return { ok: true as const, revision: existing.revision }
      }

      const newBody = appendBlockToEvidenceBody(existing.body, block, existing.revision)
      const repo = await gh("repo view --json nameWithOwner --jq .nameWithOwner")
      await gh(`api repos/${repo.stdout.trim()}/issues/comments/${existing.id} -X PATCH -f body='${escapeShellArg(newBody)}'`)
      return { ok: true as const, revision: existing.revision + 1 }
    } catch (err) {
      return { ok: false as const, revision: 0, error: String(err) }
    }
  })
}

/** 在 END marker 前插入新 block，并将 START 行 revision 递增 */
function appendBlockToEvidenceBody(body: string, block: string, revision: number): string {
  const endIdx = body.indexOf(EVIDENCE_MARKER_END)
  const prefix = body.slice(0, endIdx)
  const suffix = body.slice(endIdx)
  return `${prefix}${block}\n${suffix}`.replace(/(revision:)\d+/, `$1${revision + 1}`)
}

// ─── labels ───

/** 设置 Flow Record 的阶段标签：移除其它 cabbage:stage:*，添加当前阶段 */
export async function setStageLabel(
  parentIssueNumber: number,
  stage: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { stdout } = await gh(`issue view ${parentIssueNumber} --json labels --jq '[.labels[].name] | join(" ") | tostring'`)
    const currentLabels = stdout.trim() === "" ? [] : stdout.trim().split(" ")
    const target = `${STAGE_LABEL_PREFIX}${stage}`
    const stale = currentLabels.filter(l => l.startsWith(STAGE_LABEL_PREFIX) && l !== target)
    const args: string[] = []
    for (const label of stale) {
      args.push(`--remove-label '${label}'`)
    }
    args.push(`--add-label '${target}'`)
    await gh(`issue edit ${parentIssueNumber} ${args.join(" ")}`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

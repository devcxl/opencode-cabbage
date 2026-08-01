import { gh as ghCli, parsePrUrlNumber } from "../util/gh.js"
import { escapeShellArg } from "../util/shell.js"
import { KeyedMutex } from "./mutex.js"
import type { FlowRecordRef, TaskRecordRef } from "./types.js"

/** TDD evidence 受控 comment 的 marker（单个 comment 承载全部证据） */
export const EVIDENCE_MARKER_START = "<!-- cabbage-tdd-evidence:start -->"
export const EVIDENCE_MARKER_END = "<!-- cabbage-tdd-evidence:end -->"

/** Flow Record（Parent Issue）标签 */
export const FLOW_LABEL = "cabbage:flow"

/** 全自动授权标签：用户打此标签 = 该 flow 全自动运行，阶段确认门禁（requirements/高风险）自动放行 */
export const AUTO_LABEL = "cabbage:auto"
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
  /** 全自动模式：创建时同时打 cabbage:auto 标签（阶段确认门禁自动放行） */
  autoMode?: boolean
}

/** 创建 Parent Issue（Flow Record），打 cabbage:flow 标签（gh 2.96：issue create 无 --draft/--json） */
export async function createFlowRecord(
  input: CreateFlowRecordInput,
): Promise<{ ok: true; ref: FlowRecordRef } | { ok: false; error: string }> {
  try {
    await ensureLabel(FLOW_LABEL)
    if (input.autoMode) await ensureLabel(AUTO_LABEL)
    const escapedBody = escapeShellArg(input.body)
    const labelArgs = input.autoMode
      ? `--label '${FLOW_LABEL}' --label '${AUTO_LABEL}'`
      : `--label '${FLOW_LABEL}'`
    const { stdout } = await gh(
      `issue create --title '${escapeShellArg(input.slug)}' --body '${escapedBody}' ${labelArgs}`,
    )
    // issue create 不支持 --json：解析 stdout 中的 issue URL
    const number = parsePrUrlNumber(stdout)
    if (number === null) {
      throw new Error(`invalid issue create output: ${stdout}`)
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
 * 比对不一致（外部并发修改）→ 重读最新 body，基于最新内容合并写入（retried: true）。
 * 合并语义保留外部修改；跨进程完全串行化需 ETag/If-Match（GitHub REST 限制，超出范围）。
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
      // 冲突：重读最新 body，基于最新内容合并（保留外部修改）
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
      `issue create --title '${escapeShellArg(input.title)}' --body '${escapedBody}' --parent ${input.parentIssueNumber}`,
    )
    // issue create 不支持 --json：解析 stdout 中的 issue URL
    const number = parsePrUrlNumber(stdout)
    if (number === null) {
      throw new Error(`invalid issue create output: ${stdout}`)
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

/**
 * 读取 Task Record 的受控 evidence comment（取最新的，兼容历史多 comment）；不存在返回 null。
 * 兼容旧格式注释：只有 start marker、无 end marker 的注释（旧版本插件写入）也视为受控，
 * revision 从 `revision:N` 行提取；完全无法解析时返回 null。
 */
export async function readTddEvidenceComment(issueNumber: number): Promise<TddEvidenceComment | null> {
  try {
    const { stdout } = await gh(
      `issue view ${issueNumber} --json comments --jq '[.comments[] | select(.body | contains("${EVIDENCE_MARKER_START}")) | {id: (.id|tonumber), body}] | last'`,
    )
    const trimmed = stdout.trim()
    if (trimmed === "" || trimmed === "null") {
      return null
    }
    const parsed = JSON.parse(trimmed) as { id: number; body: string }
    const extracted = extractEvidenceBlock(parsed.body)
    if (extracted) {
      return { id: parsed.id, body: parsed.body, revision: extracted.revision }
    }
    // 旧格式兼容：只有 start marker（无 end marker）→ 从 body 提取 revision
    const legacyRevision = parsed.body.match(/revision:(\d+)/)?.[1]
    if (legacyRevision === undefined) {
      return null
    }
    return { id: parsed.id, body: parsed.body, revision: Number(legacyRevision) }
  } catch {
    return null
  }
}

/** 单条 evidence comment 超过该字节数后滚动到新 comment（GitHub comment body 上限 65536 字节） */
export const MAX_EVIDENCE_COMMENT_BYTES = 55_000

/**
 * 追加 TDD evidence 到 Task Record 的受控 comment：
 * 无受控 comment → 新建（revision 1）；有 → marker 区间内 append，revision+1（PATCH 更新）；
 * 单 comment 超限 → 滚动到新 comment（revision 从当前继续）。
 * mutex 按 issueNumber 串行；block 已存在则幂等跳过（追加不重复）。
 * 跨进程并发为最佳努力（PATCH 前基于最新重读的 body 构造，丢失概率显著降低）；
 * 完全串行化需 ETag/If-Match（GitHub REST 限制，超出当前范围）。
 */
export async function appendTddEvidence(
  issueNumber: number,
  block: string,
): Promise<{ ok: boolean; revision: number; error?: string }> {
  return recordMutex.runExclusive(issueNumber, async () => {
    try {
      // 幂等：block 已在最新 comment 的 marker 区间内，不重复追加
      const existing = await readTddEvidenceComment(issueNumber)
      if (existing && extractEvidenceBlock(existing.body)?.content.includes(block)) {
        return { ok: true as const, revision: existing.revision }
      }

      if (!existing) {
        const body = buildEvidenceCommentBody(block, 1)
        await gh(`issue comment ${issueNumber} --body '${escapeShellArg(body)}'`)
        return { ok: true as const, revision: 1 }
      }

      // 滚动：最新 comment 超限 → 新建 comment 承载新证据
      if (existing.body.length > MAX_EVIDENCE_COMMENT_BYTES) {
        const body = buildEvidenceCommentBody(block, existing.revision + 1)
        await gh(`issue comment ${issueNumber} --body '${escapeShellArg(body)}'`)
        return { ok: true as const, revision: existing.revision + 1 }
      }

      // 追加前基于最新重读的 body 构造（跨进程冲突时尽量以最新为准，防覆盖丢失）
      const current = await readTddEvidenceComment(issueNumber)
      const base = current && current.id === existing.id ? current : existing
      const newBody = appendBlockToEvidenceBody(base.body, block, base.revision)
      const repo = await gh("repo view --json nameWithOwner --jq .nameWithOwner")
      await gh(`api repos/${repo.stdout.trim()}/issues/comments/${base.id} -X PATCH -f body='${escapeShellArg(newBody)}'`)
      return { ok: true as const, revision: base.revision + 1 }
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

/** 确保 label 存在（gh label create --force：存在则更新，幂等）；创建失败不阻塞（后续 add-label 会显式报错） */
export async function ensureLabel(name: string): Promise<void> {
  try {
    await gh(`label create '${escapeShellArg(name)}' --force`)
  } catch {
    // 已存在或权限不足：忽略，add-label 阶段仍会暴露真实错误
  }
}

/** 设置 Flow Record 的阶段标签：移除其它 cabbage:stage:*，添加当前阶段（自动创建目标标签） */
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
      args.push(`--remove-label '${escapeShellArg(label)}'`)
    }
    args.push(`--add-label '${escapeShellArg(target)}'`)
    await ensureLabel(target)
    await gh(`issue edit ${parentIssueNumber} ${args.join(" ")}`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

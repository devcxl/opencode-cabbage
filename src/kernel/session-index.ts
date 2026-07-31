/**
 * Flow → session 轻量索引（替代 session-state.json）。
 * 路径：.opencode/opencode-cabbage/session-index.json
 * 作用：parentIssueNumber → sessionID 绑定；双 session 检测（R7）。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { PLUGIN_ID } from "../util/paths.js"

export type FlowSessionStatus = "active" | "paused" | "completed" | "cancelled"

export interface FlowSessionEntry {
  sessionID: string
  status: FlowSessionStatus
  continuationCount: number
  updatedAt: number
}

export interface SessionIndex {
  flows: Record<string, FlowSessionEntry>
}

export function sessionIndexPath(projectDir: string): string {
  return path.join(projectDir, ".opencode", PLUGIN_ID, "session-index.json")
}

/** 读取索引；文件不存在或损坏时返回空索引。 */
export async function readIndex(projectDir: string): Promise<SessionIndex> {
  try {
    const parsed = JSON.parse(await readFile(sessionIndexPath(projectDir), "utf8")) as { flows?: unknown }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.flows && typeof parsed.flows === "object") {
      return parsed as SessionIndex
    }
    return { flows: {} }
  } catch {
    return { flows: {} }
  }
}

/** 原子写：先写临时文件再 rename。 */
export async function writeIndex(projectDir: string, index: SessionIndex): Promise<void> {
  const target = sessionIndexPath(projectDir)
  const tmp = `${target}.tmp`
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(tmp, JSON.stringify(index, null, 2), "utf8")
  await rename(tmp, target)
}

export function getFlowSession(index: SessionIndex, parentIssueNumber: number): FlowSessionEntry | null {
  return index.flows[String(parentIssueNumber)] ?? null
}

export type BindSessionResult =
  | { ok: true; entry: FlowSessionEntry }
  | { ok: false; code: "FLOW_SESSION_CONFLICT"; message: string }
  | { ok: false; code: "TAKEOVER_NOT_CONFIRMED"; message: string }

/**
 * 绑定 parentIssueNumber → sessionID。
 * 双 session 检测（§10.3）：该 flow 已被另一 active session 绑定时拒绝。
 */
export async function bindSession(
  projectDir: string,
  parentIssueNumber: number,
  sessionID: string,
): Promise<BindSessionResult> {
  const index = await readIndex(projectDir)
  const key = String(parentIssueNumber)
  const existing = index.flows[key]

  if (existing && existing.sessionID !== sessionID && existing.status === "active") {
    return {
      ok: false,
      code: "FLOW_SESSION_CONFLICT",
      message: `Flow #${parentIssueNumber} is already bound to active session "${existing.sessionID}". Use flow_control takeover with user confirmation to take over.`,
    }
  }

  const entry: FlowSessionEntry = {
    sessionID,
    status: "active",
    continuationCount: existing && existing.sessionID === sessionID ? existing.continuationCount : 0,
    updatedAt: Date.now(),
  }
  index.flows[key] = entry
  await writeIndex(projectDir, index)
  return { ok: true, entry }
}

/**
 * 接管绑定：旧 session 置 paused，新 session 绑定 active（R7）。
 * 旧 session 为另一 active session 时要求 userConfirmed（§10.3）；
 * 调用方还需将旧 session 的 goal status 置 paused（goalClient 层）。
 */
export async function takeoverSession(
  projectDir: string,
  parentIssueNumber: number,
  newSessionID: string,
  userConfirmed: boolean,
): Promise<BindSessionResult> {
  const index = await readIndex(projectDir)
  const key = String(parentIssueNumber)
  const existing = index.flows[key]

  if (existing && existing.sessionID !== newSessionID && existing.status === "active" && !userConfirmed) {
    return {
      ok: false,
      code: "TAKEOVER_NOT_CONFIRMED",
      message: `Flow #${parentIssueNumber} is bound to active session "${existing.sessionID}". Takeover requires user confirmation (user_confirmed: true).`,
    }
  }

  if (existing) {
    if (existing.sessionID === newSessionID) {
      const entry: FlowSessionEntry = { ...existing, status: "active", updatedAt: Date.now() }
      index.flows[key] = entry
      await writeIndex(projectDir, index)
      return { ok: true, entry }
    }
    existing.status = "paused"
    existing.updatedAt = Date.now()
  }

  const entry: FlowSessionEntry = {
    sessionID: newSessionID,
    status: "active",
    continuationCount: 0,
    updatedAt: Date.now(),
  }
  index.flows[key] = entry
  await writeIndex(projectDir, index)
  return { ok: true, entry }
}

/** 更新已绑定 flow 的状态/计数；flow 未绑定时返回 null 且不创建 entry。 */
export async function updateFlowSession(
  projectDir: string,
  parentIssueNumber: number,
  patch: Partial<Pick<FlowSessionEntry, "status" | "continuationCount">>,
): Promise<FlowSessionEntry | null> {
  const index = await readIndex(projectDir)
  const key = String(parentIssueNumber)
  const existing = index.flows[key]
  if (!existing) return null
  const entry: FlowSessionEntry = { ...existing, ...patch, updatedAt: Date.now() }
  index.flows[key] = entry
  await writeIndex(projectDir, index)
  return entry
}

/** 解绑：仅当 sessionID 与当前绑定匹配时删除 entry。 */
export async function unbindSession(
  projectDir: string,
  parentIssueNumber: number,
  sessionID: string,
): Promise<boolean> {
  const index = await readIndex(projectDir)
  const key = String(parentIssueNumber)
  const existing = index.flows[key]
  if (!existing || existing.sessionID !== sessionID) return false
  delete index.flows[key]
  await writeIndex(projectDir, index)
  return true
}

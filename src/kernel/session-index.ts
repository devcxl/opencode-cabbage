/**
 * Flow → session 轻量索引（替代 session-state.json）。
 * 路径：.opencode/opencode-cabbage/session-index.json
 * 作用：parentIssueNumber → sessionID 绑定；双 session 检测（R7）。
 * 并发：全部 read-modify-write 按 projectDir 走 KeyedMutex 串行，防丢失更新。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { PLUGIN_ID } from "../util/paths.js"
import { KeyedMutex } from "./mutex.js"

export type FlowSessionStatus = "active" | "paused" | "completed" | "cancelled"

const VALID_STATUSES: FlowSessionStatus[] = ["active", "paused", "completed", "cancelled"]

export interface FlowSessionEntry {
  sessionID: string
  status: FlowSessionStatus
  continuationCount: number
  /** goal-verify 已完成验证（goal complete）——flow 级持久化，不依赖会话一致性 */
  goalComplete?: boolean
  updatedAt: number
}

export interface SessionIndex {
  flows: Record<string, FlowSessionEntry>
}

/** 按 projectDir 串行化索引读写（防并发 bind/update 互覆盖） */
const indexMutex = new KeyedMutex()

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

/** 原子写：先写临时文件（PID 后缀防跨进程 tmp 冲突）再 rename。 */
export async function writeIndex(projectDir: string, index: SessionIndex): Promise<void> {
  const target = sessionIndexPath(projectDir)
  const tmp = `${target}.${process.pid}.tmp`
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(tmp, JSON.stringify(index, null, 2), "utf8")
  await rename(tmp, target)
}

/**
 * 绑定 parentIssueNumber → sessionID（goal create 时建立，供插件重启后的 autoResume 恢复）。
 * 已绑定其它 session 时更新绑定（覆盖式，无双 session 强制）。
 */
export async function bindSession(
  projectDir: string,
  parentIssueNumber: number,
  sessionID: string,
): Promise<void> {
  return indexMutex.runExclusive(projectDir, async () => {
    const index = await readIndex(projectDir)
    const key = String(parentIssueNumber)
    const existing = index.flows[key]
    const entry: FlowSessionEntry = {
      sessionID,
      status: "active",
      continuationCount: existing && existing.sessionID === sessionID ? existing.continuationCount : 0,
      updatedAt: Date.now(),
    }
    index.flows[key] = entry
    await writeIndex(projectDir, index)
  })
}

/** 更新已绑定 flow 的状态/计数/goal 完成标记；flow 未绑定时返回 null 且不创建 entry。 */
export async function updateFlowSession(
  projectDir: string,
  parentIssueNumber: number,
  patch: Partial<Pick<FlowSessionEntry, "status" | "continuationCount" | "goalComplete">>,
): Promise<FlowSessionEntry | null> {
  if (patch.status !== undefined && !VALID_STATUSES.includes(patch.status)) {
    return null
  }
  return indexMutex.runExclusive(projectDir, async () => {
    const index = await readIndex(projectDir)
    const key = String(parentIssueNumber)
    const existing = index.flows[key]
    if (!existing) return null
    const entry: FlowSessionEntry = { ...existing, ...patch, updatedAt: Date.now() }
    index.flows[key] = entry
    await writeIndex(projectDir, index)
    return entry
  })
}

/** 删除 flow 的索引 entry（goal cancel 时调用，避免重启 autoResume 恢复已取消 goal）。 */
export async function removeFlowSession(
  projectDir: string,
  parentIssueNumber: number,
): Promise<boolean> {
  return indexMutex.runExclusive(projectDir, async () => {
    const index = await readIndex(projectDir)
    const key = String(parentIssueNumber)
    if (!index.flows[key]) return false
    delete index.flows[key]
    await writeIndex(projectDir, index)
    return true
  })
}

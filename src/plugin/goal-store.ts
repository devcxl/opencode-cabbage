import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { GoalData } from "./goal.js"

/**
 * goal 存储抽象（V2 迁移解耦准备）。
 *
 * V1 实现 = session.metadata.goal（createMetadataGoalStore）。
 * V2 候选 = ctx.storage / 本地文件——切换时只替换实现，不改调用方。
 * 见 docs/dev/research/2026-08-31-opencode-v2-compat-spike.md §6.3.1。
 */

/** goal 宿主会话的最小面：goal 工具判定子会话（parentID）与元数据保留（write 全量替换）所需 */
export interface GoalSession {
  parentID: string | null
  metadata: Record<string, unknown>
}

/** 宽松消息面：记账与尾部检查的最小形状（V1 实现直接透传 SDK messages data，不做映射） */
export interface GoalMessage {
  info?: {
    id?: string
    role?: string
    time?: { completed?: number; created?: number } | null
    tokens?: unknown
    error?: unknown
  } | null
  parts?: Array<{ type?: string; text?: string }>
}

/** goal 状态存储。read 的 fail-closed 语义（异常 → null）由实现保证，调用方依赖此兜底。 */
export interface GoalStore {
  read(sessionID: string): Promise<{ goal: GoalData | null; session: GoalSession | null }>
  /** 写 goal；null 表示删除。existingSession 复用 read 结果避免二次读取。 */
  write(sessionID: string, goal: GoalData | null, existingSession?: GoalSession | null): Promise<void>
  /** 最近消息（记账基线 + 续接尾部检查用）。data 非数组时返回 null（与 SDK 语义一致）。 */
  messages(sessionID: string, limit: number): Promise<GoalMessage[] | null>
}

/** GoalStore V1 实现所需的最小 SDK 客户端面（createOpencodeClient 返回类型的子集） */
export interface GoalStoreClient {
  session: {
    get(args: { sessionID: string }): Promise<{ data?: { parentID?: string | null; metadata?: Record<string, unknown> } | null }>
    update(args: { sessionID: string; metadata: Record<string, unknown> }): Promise<unknown>
    messages(args: { sessionID: string; limit?: number }): Promise<{ data?: GoalMessage[] }>
  }
}

/** V1 实现：goal 持久化在 session metadata 的 goal 键；messages 直接透传 SDK 消息面 */
export function createMetadataGoalStore(client: GoalStoreClient): GoalStore {
  return {
    async read(sessionID) {
      try {
        const result = await client.session.get({ sessionID })
        const session = result?.data ?? null
        if (!session) return { goal: null, session: null }
        const goalSession: GoalSession = {
          parentID: session.parentID ?? null,
          metadata: session.metadata ?? {},
        }
        if (!goalSession.metadata.goal) return { goal: null, session: goalSession }
        return { goal: goalSession.metadata.goal as GoalData, session: goalSession }
      } catch {
        return { goal: null, session: null }
      }
    },

    async write(sessionID, goal, existingSession) {
      const session = existingSession ?? (await this.read(sessionID)).session
      if (!session) throw new Error("Failed to get session")

      const existing: Record<string, unknown> = session.metadata ?? {}
      const metadata = goal === null
        ? Object.fromEntries(Object.entries(existing).filter(([k]) => k !== "goal"))
        : { ...existing, goal }

      await client.session.update({ sessionID, metadata })
    },

    async messages(sessionID, limit) {
      const result = await client.session.messages({ sessionID, limit })
      return Array.isArray(result?.data) ? result.data : null
    },
  }
}

/**
 * 从插件上下文构建 SDK client（V1 宿主机制）。
 * V2 下 ctx 本身即 server client，本函数与 createMetadataGoalStore 一起被替换。
 */
export function createGoalClient(serverUrl: URL, v1Client: any) {
  const v1Config = v1Client?.getConfig?.() ?? {}
  return createOpencodeClient({
    baseUrl: serverUrl.origin,
    headers: v1Config.headers,
    fetch: v1Config.fetch,
    // SDK v2 默认 ThrowOnError=false（4xx/5xx 静默 resolve 为 {error}），
    // 必须显式开启，否则 readGoal/writeGoal 的 try/catch 与错误传播全部失效
    throwOnError: true,
  })
}

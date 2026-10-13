import type { GoalData } from "./goal.js"

/**
 * goal 存储抽象（OpenCode V2）。
 *
 * V2 实现 = 会话 metadata（ctx.session.get/update）；
 * 消息面用 session.context 投影；记账快照用会话累计 tokens。
 * read 的 fail-closed 语义（异常 → null）由实现保证，调用方依赖此兜底。
 */

/** goal 宿主会话的最小面（V2 SessionInfo 子集） */
export interface GoalSession {
  parentID: string | null
  metadata: Record<string, unknown>
  agent?: string | null
  model?: { providerID?: string; id?: string; variant?: string } | null
  tokens?: unknown
}

/** V2 消息投影的最小形状（session.context 返回值的子集） */
export interface GoalContextMessage {
  type?: string
  time?: { completed?: number; created?: number } | null
  content?: Array<{ type?: string; text?: string }>
}

/**
 * GoalStore V2 实现所需的 session 域最小面（ctx.session 的子集）。
 * 参数/返回值放宽为 any：该接口是插件到存储的唯一适配边界，
 * 内部做运行时形状校验后以强类型 GoalStore 暴露（避免把平台品牌类型渗入内核）。
 */
export interface GoalStoreSessionApi {
  get(args: { sessionID: string }): Promise<any> // eslint-disable-line @typescript-eslint/no-explicit-any
  update(args: { sessionID: string; metadata: any }): Promise<any> // eslint-disable-line @typescript-eslint/no-explicit-any
  context(args: { sessionID: string }): Promise<any> // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** goal 状态存储。read 的 fail-closed 语义（异常 → null）由实现保证，调用方依赖此兜底。 */
export interface GoalStore {
  read(sessionID: string): Promise<{ goal: GoalData | null; session: GoalSession | null }>
  /** 写 goal；null 表示删除。existingSession 复用 read 结果避免二次读取。 */
  write(sessionID: string, goal: GoalData | null, existingSession?: GoalSession | null): Promise<void>
  /** 会话消息投影（续接尾部检查与信号检测用）。异常/非数组时返回 null。 */
  context(sessionID: string): Promise<GoalContextMessage[] | null>
  /** 会话累计 token 快照（预算护栏记账用）。异常时返回 null。 */
  sessionTokens(sessionID: string): Promise<unknown | null>
}

function toGoalSession(session: {
  parentID?: string
  metadata?: Record<string, unknown>
  agent?: string
  model?: { providerID?: string; id?: string; variant?: string } | null
  tokens?: unknown
} | null | undefined): GoalSession {
  return {
    parentID: session?.parentID ?? null,
    metadata: session?.metadata ?? {},
    agent: session?.agent ?? null,
    model: session?.model ?? null,
    tokens: session?.tokens,
  }
}

/** V2 实现：goal 持久化在 session metadata 的 goal 键；消息/tokens 走 session 域读取。 */
export function createSessionGoalStore(session: GoalStoreSessionApi): GoalStore {
  return {
    async read(sessionID) {
      try {
        const result = await session.get({ sessionID })
        if (!result) return { goal: null, session: null }
        const goalSession = toGoalSession(result)
        if (!goalSession.metadata.goal) return { goal: null, session: goalSession }
        return { goal: goalSession.metadata.goal as GoalData, session: goalSession }
      } catch {
        return { goal: null, session: null }
      }
    },

    async write(sessionID, goal, existingSession) {
      const current = existingSession ?? (await this.read(sessionID)).session
      if (!current) throw new Error("Failed to get session")

      const existing: Record<string, unknown> = current.metadata ?? {}
      const metadata = goal === null
        ? Object.fromEntries(Object.entries(existing).filter(([k]) => k !== "goal"))
        : { ...existing, goal }

      await session.update({ sessionID, metadata })
    },

    async context(sessionID) {
      try {
        const result = await session.context({ sessionID })
        return Array.isArray(result) ? result : null
      } catch {
        return null
      }
    },

    async sessionTokens(sessionID) {
      try {
        const result = await session.get({ sessionID })
        return result?.tokens ?? null
      } catch {
        return null
      }
    },
  }
}

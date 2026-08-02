import type { ToolContext, ToolResult } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { Session } from "@opencode-ai/sdk/v2"
import { bindSession, updateFlowSession, removeFlowSession } from "../kernel/session-index.js"
import { KeyedMutex } from "../kernel/mutex.js"
import { resolveProjectDir } from "../util/paths.js"

/** goal 会话级串行：readGoal→修改→writeGoal 整个序列互斥，防 queueContinuation/message.updated 丢失更新 */
const goalMutex = new KeyedMutex()

export type GoalStatus = "active" | "paused" | "complete"

/** 用户最后使用的会话配置快照：续接注入时显式传回，防止 idle 后回落/切换默认 agent 与模型 */
export interface GoalSessionProfile {
  agent: string
  model?: { providerID: string; modelID: string }
}

/** 最小化 goal（§10.2）：目标与验收条件从 Flow Record（Parent Issue body）读取 */
export interface GoalData {
  parentIssueNumber: number
  status: GoalStatus
  continuationCount: number
  /** 用户最后使用的 agent/模型（create 或用户消息时快照） */
  sessionProfile?: GoalSessionProfile
}

export function createGoal(parentIssueNumber: number, sessionProfile?: GoalSessionProfile): GoalData {
  return {
    parentIssueNumber,
    status: "active",
    continuationCount: 0,
    ...(sessionProfile ? { sessionProfile } : {}),
  }
}

export function canTransitionTo(goal: GoalData, target: GoalStatus): boolean {
  switch (target) {
    case "paused": return goal.status === "active"
    case "active": return goal.status === "paused"
    case "complete": return goal.status === "active"
    default: return false
  }
}

export function formatGoal(goal: GoalData): string {
  return [
    `Flow: #${goal.parentIssueNumber}`,
    `Status: ${goal.status}`,
    `Continuations: ${goal.continuationCount}`,
    goal.sessionProfile ? `Agent: ${goal.sessionProfile.agent}` : "",
    `Objective/acceptance: read from Flow Record (Parent Issue #${goal.parentIssueNumber})`,
  ].filter(Boolean).join("\n")
}

export const MAX_CONTINUATIONS = 50

export function continuationPrompt(parentIssueNumber: number): string {
  return `Continue working toward the active goal.

Read the Flow Record (Parent Issue #${parentIssueNumber}) for the objective and completion criteria.

<flow_issue>
#${parentIssueNumber}
</flow_issue>

Work from evidence — inspect the current state before relying on anything.
If the work is not done, just keep working. Do not narrate that you are continuing — execute.`
}

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

export async function readGoal(
  client: ReturnType<typeof createOpencodeClient>,
  sessionID: string,
): Promise<{ goal: GoalData | null; session: Session | null }> {
  try {
    const result = await client.session.get({ sessionID })
    const session = (result as { data?: Session | null })?.data ?? null
    if (!session?.metadata?.goal) return { goal: null, session }
    return { goal: session.metadata.goal as GoalData, session }
  } catch {
    return { goal: null, session: null }
  }
}

export async function writeGoal(
  client: ReturnType<typeof createOpencodeClient>,
  sessionID: string,
  goal: GoalData | null,
  existingSession?: Session | null,
): Promise<void> {
  const session = existingSession ?? (await readGoal(client, sessionID)).session
  if (!session) throw new Error("Failed to get session")

  const existing: Record<string, unknown> = session.metadata ?? {}
  const metadata = goal === null
    ? Object.fromEntries(Object.entries(existing).filter(([k]) => k !== "goal"))
    : { ...existing, goal }

  await client.session.update({ sessionID, metadata })
}

export function createGoalTool(
  client: ReturnType<typeof createOpencodeClient>,
  projectDirFallback?: string,
) {
  /** 会话级项目目录：优先 ToolContext.directory，退化到插件级 projectDir（异常会话下避免写入根目录） */
  const sessionProjectDir = (ctxDirectory?: string) => resolveProjectDir(ctxDirectory, projectDirFallback ?? "")
  return tool({
    description: `Manage the active goal-mode objective (minimal: parentIssueNumber/status/continuationCount).

Use a single op field:
- create: starts a goal bound to a Flow Record. Requires parent_issue_number.
- get: returns the current goal.
- resume: re-activates a paused goal.
- cancel: discards the current goal.
- pause: pauses the active goal.
- complete: marks the goal as completed. Follow the returned instructions.`,
    args: {
      op: tool.schema.enum(["create", "get", "complete", "resume", "cancel", "pause"]).describe("Goal operation"),
      parent_issue_number: tool.schema.number().optional().describe("Parent GitHub Issue number of the Flow Record (required for create)"),
    },
    async execute(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const sessionID = (ctx as any).sessionID as string
      // 会话级串行：整个 goal 读改写序列互斥（防与 queueContinuation/message.updated 并发丢失更新）
      return goalMutex.runExclusive(sessionID, async () => {
      const session = await readGoal(client, sessionID)
      const isSubAgent = !!session.session?.parentID
      const targetSessionID = session.session?.parentID ?? sessionID

      if (isSubAgent && ["create", "pause", "resume", "cancel"].includes(args.op)) {
        return `Error: sub-agents cannot call goal({op:"${args.op}"}). Goal lifecycle operations are restricted to the main session.`
      }

      if (isSubAgent && args.op === "complete") {
        const agentName = ctx.agent
        if (agentName !== "goal-verify") {
          return `Error: only the goal-verify agent can complete the goal. Agent "${agentName}" is not authorized.`
        }
        const parent = await readGoal(client, targetSessionID)
        if (!parent.goal) return "No goal to complete in the parent session."
        if (parent.goal.status !== "active") {
          return `Parent session goal is not active (status: ${parent.goal.status}).`
        }

        parent.goal.status = "complete"
        await writeGoal(client, targetSessionID, parent.goal, parent.session)
        // flow 级持久化：complete-flow 可跨会话识别验证完成（不依赖 index 会话一致性）
        try {
          await updateFlowSession(sessionProjectDir(ctx.directory), parent.goal.parentIssueNumber, { goalComplete: true })
        } catch {
          // 索引写入失败不阻塞 goal 完成（goal 本身已持久化）
        }
        return `Goal completed and verified: Flow #${parent.goal.parentIssueNumber}`
      }

      switch (args.op) {
        case "create": {
          if (!args.parent_issue_number) return "Error: parent_issue_number is required"
          const existing = (await readGoal(client, sessionID)).goal
          if (existing?.status === "active") {
            return `Error: an active goal already exists for Flow #${existing.parentIssueNumber}`
          }
          // 快照创建时的 agent（模型由 message.updated 用户消息事件补充）
          const goal = createGoal(Number(args.parent_issue_number), { agent: ctx.agent })
          await writeGoal(client, sessionID, goal)
          // flow 级绑定：供插件重启后的 autoResume 恢复 active goal
          try {
            await bindSession(sessionProjectDir(ctx.directory), goal.parentIssueNumber, sessionID)
          } catch {
            // 索引写入失败不阻塞 goal 创建（goal 本身已持久化在 session metadata）
          }
          return `Goal created: Flow #${goal.parentIssueNumber}\nStatus: active`
        }

        case "get": {
          const { goal } = await readGoal(client, targetSessionID)
          return goal ? formatGoal(goal) : "No active goal."
        }

        case "complete": {
          const { goal } = await readGoal(client, sessionID)
          if (!goal) return "No active goal."
          if (goal.status !== "active") return `Goal is not active (status: ${goal.status}).`
          return `BLOCKED: Call the goal-verify sub-agent via the Task tool. Only the sub-agent can complete verification.`
        }

        case "resume": {
          const { goal, session: s } = await readGoal(client, sessionID)
          if (!goal) return "No goal to resume."
          if (!canTransitionTo(goal, "active")) return `Goal cannot be resumed (status: ${goal.status}).`
          goal.status = "active"
          goal.continuationCount = 0
          await writeGoal(client, sessionID, goal, s)
          return `Goal resumed: Flow #${goal.parentIssueNumber}\nStatus: active`
        }

        case "pause": {
          const { goal, session: s } = await readGoal(client, sessionID)
          if (!goal) return "No goal to pause."
          if (!canTransitionTo(goal, "paused")) return `Goal cannot be paused (status: ${goal.status}).`
          goal.status = "paused"
          await writeGoal(client, sessionID, goal, s)
          return `Goal paused: Flow #${goal.parentIssueNumber}\nStatus: paused`
        }

        case "cancel": {
          const { goal, session: s } = await readGoal(client, sessionID)
          if (!goal) return "No goal to cancel."
          await writeGoal(client, sessionID, null, s)
          // 同步清除 session-index entry，避免重启 autoResume 恢复已取消 goal
          try {
            await removeFlowSession(sessionProjectDir(ctx.directory), goal.parentIssueNumber)
          } catch {
            // 索引清理失败不阻塞取消（goal 本身已移除）
          }
          return `Goal cancelled: Flow #${goal.parentIssueNumber}`
        }

        default:
          return `Error: unknown operation "${args.op}"`
      }
      })
    },
  })
}

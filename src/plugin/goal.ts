import type { ToolContext, ToolResult } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { Session } from "@opencode-ai/sdk/v2"

export type GoalStatus = "active" | "paused" | "complete"

/** 最小化 goal（§10.2）：目标与验收条件从 Flow Record（Parent Issue body）读取 */
export interface GoalData {
  parentIssueNumber: number
  status: GoalStatus
  continuationCount: number
}

export function createGoal(parentIssueNumber: number): GoalData {
  return {
    parentIssueNumber,
    status: "active",
    continuationCount: 0,
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
    `Objective/acceptance: read from Flow Record (Parent Issue #${goal.parentIssueNumber})`,
  ].join("\n")
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

export function verifyAgentPrompt(): string {
  return `You are the goal-verify agent. Your ONLY job is to determine whether a goal has been fully achieved by inspecting the current state.

You are the only agent authorized to call goal({op:"complete"}). Other agents (reviewer, developer, architect) cannot complete the goal.

You start with a FRESH context — do not assume any prior work was done correctly.

First step: Call goal({op:"get"}) to retrieve the active flow's parent issue number, then read the Flow Record (Parent Issue body) for the objective and completion criteria.

---

## Verification Procedure

1. Call goal({op:"get"}) to retrieve the parent issue number.
2. Read the Flow Record (Parent Issue body) for the objective and completion criteria.
3. Break them into concrete, individual requirements.
4. For EACH requirement, gather evidence:
   - Read full files — not just snippets
   - Run tests, builds, lint
   - Check imports, exports, types resolve correctly
5. Classify each finding: SATISFIED / NOT SATISFIED / UNCERTAIN
6. If ALL requirements are SATISFIED:
   Call goal({op:"complete"}) — only you can do this
7. If ANY requirement is NOT SATISFIED or UNCERTAIN:
   Do NOT call goal({op:"complete"}). Return a detailed report.

---

Do not create or modify any files. You are a read-only verifier.`
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
) {
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
      parent_issue_number: tool.schema.number().describe("Parent GitHub Issue number of the Flow Record (required for create)"),
    },
    async execute(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult> {
      const sessionID = (ctx as any).sessionID as string

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
        return `Goal completed and verified: Flow #${parent.goal.parentIssueNumber}`
      }

      switch (args.op) {
        case "create": {
          if (!args.parent_issue_number) return "Error: parent_issue_number is required"
          const existing = (await readGoal(client, sessionID)).goal
          if (existing?.status === "active") {
            return `Error: an active goal already exists for Flow #${existing.parentIssueNumber}`
          }
          const goal = createGoal(Number(args.parent_issue_number))
          await writeGoal(client, sessionID, goal)
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
          return `Goal cancelled: Flow #${goal.parentIssueNumber}`
        }

        default:
          return `Error: unknown operation "${args.op}"`
      }
    },
  })
}

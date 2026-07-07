import type { ToolContext, ToolResult } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import type { Session } from "@opencode-ai/sdk/v2"

export type GoalStatus = "active" | "paused" | "complete"

export interface GoalData {
  objective: string
  completionCriterion: string
  status: GoalStatus
  continuationCount: number
}

function createGoal(objective: string, completionCriterion: string): GoalData {
  return {
    objective: objective.trim(),
    completionCriterion: completionCriterion.trim(),
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
    `Goal: ${goal.objective}`,
    `Completion criterion: ${goal.completionCriterion}`,
    `Status: ${goal.status}`,
  ].join("\n")
}

export const MAX_CONTINUATIONS = 50

export function continuationPrompt(objective: string, completionCriterion: string): string {
  return `Continue working toward the active goal.

<objective>
${objective}
</objective>

<completion_criterion>
${completionCriterion}
</completion_criterion>

Keep the full objective intact. Do not redefine success around a smaller or easier task.
Work from evidence — inspect the current state before relying on anything.
If the work is not done, just keep working. Do not narrate that you are continuing — execute.`
}

export function verifyAgentPrompt(): string {
  return `You are an independent goal verification agent. Your ONLY job is to determine whether a goal has been fully achieved by inspecting the current state.

You start with a FRESH context — do not assume any prior work was done correctly.

First step: Call goal({op:"get"}) to retrieve the objective and completion criterion.

---

## Verification Procedure

1. Call goal({op:"get"}) to retrieve the objective and completion criterion.
2. Break them into concrete, individual requirements.
3. For EACH requirement, gather evidence:
   - Read full files — not just snippets
   - Run tests, builds, lint
   - Check imports, exports, types resolve correctly
4. Classify each finding: SATISFIED / NOT SATISFIED / UNCERTAIN
5. If ALL requirements are SATISFIED:
   Call goal({op:"complete"})
6. If ANY requirement is NOT SATISFIED or UNCERTAIN:
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

export function createGoalTool(client: ReturnType<typeof createOpencodeClient>) {
  return tool({
    description: `Manage the active goal-mode objective.

Use a single op field:
- create: starts a goal. Requires both objective and completion_criterion.
- get: returns the current goal.
- resume: re-activates a paused goal.
- cancel: discards the current goal.
- pause: pauses the active goal.
- complete: marks the goal as completed. Follow the returned instructions.`,
    args: {
      op: tool.schema.enum(["create", "get", "complete", "resume", "cancel", "pause"]).describe("Goal operation"),
      objective: tool.schema.string().describe("Goal objective (required for create)"),
      completion_criterion: tool.schema.string().describe("Concrete, checkable conditions (required for create)"),
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
        const parent = await readGoal(client, targetSessionID)
        if (!parent.goal) return "No goal to complete in the parent session."
        if (parent.goal.status !== "active") {
          return `Parent session goal is not active (status: ${parent.goal.status}).`
        }
        parent.goal.status = "complete"
        await writeGoal(client, targetSessionID, parent.goal, parent.session)
        return `Goal completed and verified: "${parent.goal.objective}"`
      }

      switch (args.op) {
        case "create": {
          if (!args.objective?.trim()) return "Error: objective is required"
          if (!args.completion_criterion?.trim()) return "Error: completion_criterion is required"
          const existing = (await readGoal(client, sessionID)).goal
          if (existing?.status === "active") {
            return `Error: an active goal already exists: "${existing.objective}"`
          }
          const goal = createGoal(args.objective, args.completion_criterion)
          await writeGoal(client, sessionID, goal)
          return `Goal created: "${goal.objective}"\nStatus: active`
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
          return `Goal resumed: "${goal.objective}"\nStatus: active`
        }

        case "pause": {
          const { goal, session: s } = await readGoal(client, sessionID)
          if (!goal) return "No goal to pause."
          if (!canTransitionTo(goal, "paused")) return `Goal cannot be paused (status: ${goal.status}).`
          goal.status = "paused"
          await writeGoal(client, sessionID, goal, s)
          return `Goal paused: "${goal.objective}"\nStatus: paused`
        }

        case "cancel": {
          const { goal, session: s } = await readGoal(client, sessionID)
          if (!goal) return "No goal to cancel."
          await writeGoal(client, sessionID, null, s)
          return `Goal cancelled: "${goal.objective}"`
        }

        default:
          return `Error: unknown operation "${args.op}"`
      }
    },
  })
}

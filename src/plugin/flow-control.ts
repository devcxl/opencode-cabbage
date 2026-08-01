/**
 * flow_control 工具（spec §2.3）：Flow Record 生命周期（替代旧 FlowRun 状态机）。
 * 九 op：create-flow / status / planning-start / planning-pr / stage-start / stage-complete /
 *       complete-flow / cancel-flow / takeover。
 * caller：primary 全量（除 complete-flow）；complete-flow 仅 goal-verify。
 * server.ts 接线由后续批次统一处理（本批不注册，避免文件冲突）。
 */
import { tool } from "@opencode-ai/plugin/tool"
import { resolveProjectDir } from "../util/paths.js"
import { requireToolCaller, CALLER_NOT_AUTHORIZED } from "../kernel/caller.js"
import {
  FLOW_STAGES,
  createFlow,
  readFlowStatus,
  planningStart,
  planningPr,
  applyStageOp,
  completeFlow,
  cancelFlow,
  takeoverFlow,
  type FlowStage,
} from "../kernel/flow.js"
import { readIndex, getFlowSession } from "../kernel/session-index.js"
import { detectLegacyFlowRun, type LegacyFlowDetection } from "../kernel/legacy.js"
import { flowGh } from "../kernel/flow.js"

/** session client 最小可见面：get（caller 判定 + goal 读取）+ update（goal 写入） */
export interface FlowControlSessionClient {
  session: {
    get(input: { sessionID: string }): Promise<{ data?: { parentID?: string | null; metadata?: Record<string, unknown> } }>
    update(input: { sessionID: string; metadata: Record<string, unknown> }): Promise<unknown>
  }
}

/** flow_control 工具依赖 */
export interface FlowControlDeps {
  projectDir: string
  sessionClient: FlowControlSessionClient
}

export type FlowControlResponse = {
  ok: boolean
  flow?: { parentIssueNumber: number; slug?: string }
  status?: unknown
  stage?: FlowStage
  completedStages?: FlowStage[]
  prNumber?: number
  worktreePath?: string
  branch?: string
  oldSessionID?: string | null
  error?: { code: string; message: string }
}

/**
 * flow_control 工具工厂（spec §2.3）。
 * caller 门禁：primary（除 complete-flow 外）；complete-flow 仅 goal-verify。
 */
export function createFlowControlTool(deps: FlowControlDeps) {
  return tool({
    description: `Control the Flow Record lifecycle (a Flow = one GitHub Parent Issue).

Operations:
- create-flow: Validate the functional title, derive the slug, create a Draft Parent Issue (body contains goal/acceptance/stage checklist, label cabbage:flow), bind the session, and write the minimal goal. When parent_issue_number is given, bind an existing issue instead (legacy FlowRun detection + double-session check).
- status: Aggregate the Flow Record body, subtasks (issue list --json parent 过滤), and related PR checks into one report.
- planning-start: Create the planning worktree .worktree/planning-<slug> for the architect.
- planning-pr: Commit/push the planning worktree changes and open the Planning PR (Planning Baseline).
- stage-start / stage-complete: Enforce stage gates (requirements baseline confirmed once; design must complete before tasks; high-risk flows pause between design and tasks) and update the Parent Issue checklist + cabbage:stage:* label.
- complete-flow: goal-verify only. After independent verification, close the Parent Issue.
- cancel-flow: Controlled cancellation (requires user_confirmed).
- takeover: Take over a flow bound to another active session (requires user_confirmed; old session goal is paused).

Caller: primary for all ops except complete-flow (goal-verify only).`,
    args: {
      op: tool.schema
        .enum(["create-flow", "status", "planning-start", "planning-pr", "stage-start", "stage-complete", "complete-flow", "cancel-flow", "takeover"])
        .describe("Flow control operation"),
      title: tool.schema.string().optional().describe("Functional title (kebab-case slug) for create-flow"),
      auto_mode: tool.schema
        .boolean()
        .optional()
        .describe("Full-auto mode: label the flow cabbage:auto so stage confirmation gates (requirements/high-risk) pass without user_confirmed"),
      goal: tool.schema.string().optional().describe("Initial objective to fill the Flow Record Goal block (create-flow)"),
      acceptance_criteria: tool.schema
        .array(tool.schema.string())
        .optional()
        .describe("Initial acceptance criteria list to fill the Flow Record Acceptance Criteria block (create-flow)"),
      parent_issue_number: tool.schema.number().optional().describe("Parent GitHub Issue number of the Flow Record"),
      stage: tool.schema
        .enum(["requirements", "design", "tasks", "code", "review"])
        .optional()
        .describe("Stage name (for stage-start/stage-complete)"),
      risk: tool.schema
        .enum(["high", "low"])
        .optional()
        .describe("Risk declaration for stage-start/stage-complete tasks handoff: high triggers the R11 user-confirmation gate (user_confirmed) and persists the cabbage:risk:high label"),
      user_confirmed: tool.schema.boolean().optional().describe("User confirmation (required for cancel-flow/takeover and high-risk gates)"),
    },
    async execute(args, ctx) {
      const op = args.op as string

      // caller 门禁（矩阵单一来源，§2.2）：complete-flow 仅 goal-verify；status 另开放 architect；其余仅 primary
      const denied = await requireToolCaller(ctx, "flow_control", op, deps.sessionClient)
      if (denied) return errorResponse(CALLER_NOT_AUTHORIZED, denied)

      // 会话级项目目录优先（workspace root 异常会话下插件级 projectDir 可能是 `/`）
      const runtimeDeps = { ...deps, projectDir: resolveProjectDir(ctx.directory, deps.projectDir) }

      try {
        switch (op) {
          case "create-flow":
            return handleCreateFlow(runtimeDeps, args, ctx.sessionID)
          case "status":
            return handleStatus(runtimeDeps, args)
          case "planning-start":
            return handlePlanningStart(runtimeDeps, args)
          case "planning-pr":
            return handlePlanningPr(runtimeDeps, args)
          case "stage-start":
          case "stage-complete":
            return handleStage(runtimeDeps, args, op)
          case "complete-flow":
            return handleCompleteFlow(runtimeDeps, args, ctx)
          case "cancel-flow":
            return handleCancelFlow(runtimeDeps, args)
          case "takeover":
            return handleTakeover(runtimeDeps, args, ctx.sessionID)
          default:
            return errorResponse("UNKNOWN_OP", `Unknown op: "${op}"`)
        }
      } catch (err) {
        return errorResponse("INTERNAL_ERROR", String(err))
      }
    },
  })
}

/** 独立注册辅助：把 flow_control 挂到工具注册表（后续接线批次使用） */
export function registerFlowControl(registry: Record<string, unknown>, deps: FlowControlDeps): void {
  registry.flow_control = createFlowControlTool(deps)
}

// ─── op handlers ───

async function handleCreateFlow(
  deps: FlowControlDeps,
  args: Record<string, unknown>,
  sessionID: string,
): Promise<string> {
  const parent = args.parent_issue_number !== undefined ? Number(args.parent_issue_number) : undefined
  const title = (args.title as string | undefined) ?? ""
  if (parent === undefined && title.trim() === "") {
    return errorResponse("POLICY_INVALID", "title is required for create-flow (or pass parent_issue_number to bind an existing issue)")
  }

  const result = await createFlow({
    projectDir: deps.projectDir,
    title,
    sessionID,
    autoMode: args.auto_mode === true,
    goal: args.goal as string | undefined,
    acceptanceCriteria: args.acceptance_criteria as string[] | undefined,
    parentIssueNumber: parent,
  })
  if (!result.ok) {
    return errorResponse(result.code, result.message)
  }

  const goalWritten = await writeMinimalGoal(deps.sessionClient, sessionID, result.ref.parentIssueNumber)
  if (!goalWritten) {
    return errorResponse("GOAL_WRITE_FAILED", "flow created but failed to write the minimal goal to the session")
  }

  return okResponse({ flow: result.ref })
}

async function handleStatus(_deps: FlowControlDeps, args: Record<string, unknown>): Promise<string> {
  const n = requireParentIssueNumber(args)
  if (typeof n === "string") return n

  const legacy = await detectLegacyFlowRun(n, flowGh)
  if (legacy.legacy) return legacyDetectedResponse(legacy)

  const result = await readFlowStatus(n)
  if (!result.ok) {
    return errorResponse(result.code, result.message)
  }
  return okResponse({ status: result.status })
}

async function handlePlanningStart(deps: FlowControlDeps, args: Record<string, unknown>): Promise<string> {
  const n = requireParentIssueNumber(args)
  if (typeof n === "string") return n

  const result = await planningStart(deps.projectDir, n)
  if (!result.ok) {
    return errorResponse(result.code, result.message)
  }
  return okResponse({ worktreePath: result.worktreePath, branch: result.branch })
}

async function handlePlanningPr(deps: FlowControlDeps, args: Record<string, unknown>): Promise<string> {
  const n = requireParentIssueNumber(args)
  if (typeof n === "string") return n

  const result = await planningPr(deps.projectDir, n)
  if (!result.ok) {
    return errorResponse(result.code, result.message)
  }
  return okResponse({ prNumber: result.prNumber, worktreePath: result.worktreePath, branch: result.branch })
}

async function handleStage(
  deps: FlowControlDeps,
  args: Record<string, unknown>,
  op: string,
): Promise<string> {
  const n = requireParentIssueNumber(args)
  if (typeof n === "string") return n

  const stage = args.stage as FlowStage | undefined
  if (!stage || !FLOW_STAGES.includes(stage)) {
    return errorResponse("POLICY_INVALID", "stage is required for stage ops: requirements|design|tasks|code|review")
  }

  const risk = args.risk as "high" | "low" | undefined
  if (risk !== undefined && risk !== "high" && risk !== "low") {
    return errorResponse("POLICY_INVALID", "risk must be \"high\" or \"low\"")
  }

  const result = await applyStageOp(deps.projectDir, n, op as "stage-start" | "stage-complete", stage, args.user_confirmed === true, risk)
  if (!result.ok) {
    return errorResponse(result.code, result.message)
  }
  const note = op === "stage-complete" && stage === "requirements"
    ? "requirements 产物（PRD/CONTEXT/decision-map）请 commit+push 到 main：planning worktree 基于 main HEAD 创建，未提交的文件在其中不可见"
    : undefined
  return okResponse({
    stage: result.stage,
    completedStages: result.completedStages,
    ...(result.highRisk ? { highRisk: true } : {}),
    ...(note ? { note } : {}),
  })
}

async function handleCompleteFlow(
  deps: FlowControlDeps,
  args: Record<string, unknown>,
  ctx: { sessionID: string },
): Promise<string> {
  const n = requireParentIssueNumber(args)
  if (typeof n === "string") return n

  // 独立 goal-verify 验证通过：flow 级 goalComplete 标记（跨会话持久，最可靠）
  // 或绑定 session 的 goal 已 complete（向后兼容）
  const index = await readIndex(deps.projectDir)
  const entry = getFlowSession(index, n)
  const goalCompleteAtFlowLevel = entry?.goalComplete === true
  const targetSessionID = entry?.sessionID ?? ctx.sessionID
  const goalStatus = await readGoalStatus(deps.sessionClient, targetSessionID)
  if (!goalCompleteAtFlowLevel && goalStatus !== "complete") {
    return errorResponse(
      "GOAL_NOT_COMPLETE",
      "complete-flow requires the goal to be verified complete first (goal({op:'complete'}) by goal-verify)",
    )
  }

  const result = await completeFlow(deps.projectDir, n)
  if (!result.ok) {
    return errorResponse(result.code, result.message)
  }
  return okResponse({ flow: { parentIssueNumber: result.parentIssueNumber } })
}

async function handleCancelFlow(deps: FlowControlDeps, args: Record<string, unknown>): Promise<string> {
  const n = requireParentIssueNumber(args)
  if (typeof n === "string") return n

  const result = await cancelFlow(deps.projectDir, n, args.user_confirmed === true)
  if (!result.ok) {
    return errorResponse(result.code, result.message)
  }
  return okResponse({ flow: { parentIssueNumber: result.parentIssueNumber } })
}

async function handleTakeover(
  deps: FlowControlDeps,
  args: Record<string, unknown>,
  sessionID: string,
): Promise<string> {
  const n = requireParentIssueNumber(args)
  if (typeof n === "string") return n

  const result = await takeoverFlow(deps.projectDir, n, sessionID, args.user_confirmed === true)
  if (!result.ok) {
    return errorResponse(result.code, result.message)
  }
  if (result.oldSessionID && result.oldSessionID !== sessionID) {
    await pauseOldSessionGoal(deps.sessionClient, result.oldSessionID)
  }
  return okResponse({ flow: { parentIssueNumber: result.parentIssueNumber }, oldSessionID: result.oldSessionID })
}

// ─── helpers ───

function requireParentIssueNumber(args: Record<string, unknown>): number | string {
  const n = Number(args.parent_issue_number)
  if (!Number.isInteger(n) || n <= 0) {
    return errorResponse("POLICY_INVALID", "parent_issue_number is required")
  }
  return n
}

/** 写最小 goal（§10.2）：{parentIssueNumber, status:"active", continuationCount:0} */
async function writeMinimalGoal(client: FlowControlSessionClient, sessionID: string, parentIssueNumber: number): Promise<boolean> {
  try {
    const { data } = await client.session.get({ sessionID })
    const existing = data?.metadata ?? {}
    await client.session.update({
      sessionID,
      metadata: { ...existing, goal: { parentIssueNumber, status: "active", continuationCount: 0 } },
    })
    return true
  } catch {
    return false
  }
}

/** 读指定 session 的 goal 状态；无 goal 返回 null */
async function readGoalStatus(client: FlowControlSessionClient, sessionID: string): Promise<string | null> {
  try {
    const { data } = await client.session.get({ sessionID })
    const goal = data?.metadata?.goal as { status?: string } | undefined
    return goal?.status ?? null
  } catch {
    return null
  }
}

/** takeover 后把旧 session 的 goal 置 paused（§10.3） */
async function pauseOldSessionGoal(client: FlowControlSessionClient, sessionID: string): Promise<void> {
  try {
    const { data } = await client.session.get({ sessionID })
    const metadata = data?.metadata as Record<string, unknown> | undefined
    const goal = metadata?.goal as { status?: string } | undefined
    if (!goal) return
    await client.session.update({ sessionID, metadata: { ...metadata, goal: { ...goal, status: "paused" } } })
  } catch {
    // 旧 session goal 置 paused 失败不阻断 takeover
  }
}

function legacyDetectedResponse(legacy: Extract<LegacyFlowDetection, { legacy: true }>): string {
  const detail = legacy.flowRunId ? ` (flowRunId: ${legacy.flowRunId})` : ""
  return errorResponse(
    "LEGACY_FLOW_DETECTED",
    `This issue is a legacy-architecture FlowRun${detail}; complete it with the old plugin version (0.x). New versions do not auto-migrate.`,
  )
}

function okResponse(overrides: Partial<FlowControlResponse> = {}): string {
  const resp: FlowControlResponse = { ok: true, ...overrides }
  return JSON.stringify(resp, null, 2)
}

function errorResponse(code: string, message: string): string {
  const resp: FlowControlResponse = { ok: false, error: { code, message } }
  return JSON.stringify(resp, null, 2)
}

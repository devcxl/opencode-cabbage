import type { GoalSession, GoalStore } from "./goal-store.js"
import { bindSession, updateFlowSession, removeFlowSession } from "../kernel/session-index.js"
import { KeyedMutex } from "../kernel/mutex.js"
import { clearAborted } from "./session-abort.js"

/** goal 会话级串行锁：所有读改写统一经 mutateGoal 走该锁，防并发丢失更新 */
const goalMutex = new KeyedMutex()

export type GoalStatus = "active" | "paused" | "complete"

/** 用户最后使用的会话配置快照：续接注入时显式传回，防止回落/切换默认 agent 与模型 */
export interface GoalSessionProfile {
  agent: string
  /** V1 存量语义：{providerID, modelID}；V2 新写入为 {providerID, id, variant?}，读取时两种都接受 */
  model?: { providerID: string; modelID?: string; id?: string; variant?: string }
}

/** 最小化 goal（§10.2）：目标与验收条件从 Flow Record（Parent Issue body）读取 */
export interface GoalData {
  parentIssueNumber: number
  status: GoalStatus
  continuationCount: number
  /** 用户最后使用的 agent/模型（create 或用户切换时快照） */
  sessionProfile?: GoalSessionProfile
  /** 可选 token 预算（护栏）：tokensUsed 达限后自动 pause，防止长跑成本失控 */
  tokenBudget?: number
  /** 已用 token（会话累计快照 − baseline，单调不减；护栏非账单） */
  tokensUsed?: number
  /** 记账基线：create 时点的会话累计 token 快照 */
  tokensBaseline?: number
  /** goal 创建时刻（ms）：记账基线与诊断用 */
  createdAt?: number
  /** 状态原因：'resumed' 是 UI/resume 的 kickoff 信号（首次 tick 豁免 blocked 检测后消费清除） */
  statusReason?: string
}

export function createGoal(
  parentIssueNumber: number,
  sessionProfile?: GoalSessionProfile,
  tokenBudget?: number,
): GoalData {
  return {
    parentIssueNumber,
    status: "active",
    continuationCount: 0,
    ...(sessionProfile ? { sessionProfile } : {}),
    ...(tokenBudget ? { tokenBudget } : {}),
    tokensUsed: 0,
    createdAt: Date.now(),
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
  const budgetLine = typeof goal.tokenBudget === "number"
    ? `Tokens: ${goal.tokensUsed ?? 0}/${goal.tokenBudget}`
    : ""
  return [
    `Flow: #${goal.parentIssueNumber}`,
    `Status: ${goal.status}`,
    `Continuations: ${goal.continuationCount}`,
    goal.sessionProfile ? `Agent: ${goal.sessionProfile.agent}` : "",
    budgetLine,
    `Objective/acceptance: read from Flow Record (Parent Issue #${goal.parentIssueNumber})`,
  ].filter(Boolean).join("\n")
}

/** 把存储的 profile.model（V1/V2 两种形状）归一为 V2 的 ModelRef；无法识别时返回 null */
export function normalizeProfileModel(
  model: { providerID?: string; modelID?: string; id?: string; variant?: string } | undefined,
): { providerID: string; id: string; variant?: string } | null {
  if (!model?.providerID) return null
  const id = model.id ?? model.modelID
  if (!id) return null
  return { providerID: model.providerID, id, ...(model.variant ? { variant: model.variant } : {}) }
}

export const MAX_CONTINUATIONS = 50

/**
 * token 快照 = input + reasoning + cache.read + output。
 * OpenCode 每轮的 cache.read 已含此前所有轮次付费 token，
 * 最新快照即整段成本，无需跨消息求和。reasoning 也计费，护栏方向偏严。
 */
export function snapshotTokenTotal(tokens: unknown): number {
  if (!tokens || typeof tokens !== "object") return 0
  const t = tokens as { input?: unknown; output?: unknown; reasoning?: unknown; cache?: { read?: unknown } }
  const input = typeof t.input === "number" && Number.isFinite(t.input) ? Math.max(0, t.input) : 0
  const output = typeof t.output === "number" && Number.isFinite(t.output) ? Math.max(0, t.output) : 0
  const reasoning = typeof t.reasoning === "number" && Number.isFinite(t.reasoning) ? Math.max(0, t.reasoning) : 0
  const cacheRead = typeof t.cache?.read === "number" && Number.isFinite(t.cache.read) ? Math.max(0, t.cache.read) : 0
  return input + reasoning + cacheRead + output
}

/** token 预算护栏：达到或超过预算即应暂停（null 表示未设预算） */
export function budgetReached(goal: GoalData): boolean {
  return typeof goal.tokenBudget === "number" && (goal.tokensUsed ?? 0) >= goal.tokenBudget
}

/**
 * 识别 agent 在续接回复中输出的显式阻塞报告（continuationPrompt 要求格式：
 * 无法推进时必须输出 [BLOCKED: <原因>]）。大小写与空白容错。
 */
export const BLOCKED_REPORT_RE = /\[BLOCKED\s*:\s*\S/i

export function isBlockedReport(text: string): boolean {
  return BLOCKED_REPORT_RE.test(String(text ?? ""))
}

/**
 * 识别 agent 的显式完成报告（continuationPrompt 要求格式：[DONE: <摘要>]）。
 * 命中 → goal 暂停并提示用户派 goal-verify 做最终独立验证（与 [BLOCKED:] 对称）。
 */
export const DONE_REPORT_RE = /\[DONE\s*:\s*\S/i

export function isDoneReport(text: string): boolean {
  return DONE_REPORT_RE.test(String(text ?? ""))
}

export function continuationPrompt(parentIssueNumber: number): string {
  return `Continue working toward the active goal.

Read the Flow Record (Parent Issue #${parentIssueNumber}) for the objective and completion criteria.

<flow_issue>
#${parentIssueNumber}
</flow_issue>

Work from evidence — inspect the current state before relying on anything.
If the work is not done, just keep working. Do not narrate that you are continuing — execute.

Blocking protocol: if you genuinely cannot make further progress without the user
(missing credentials, a missing decision, or a hard external failure), start your
reply with the exact marker [BLOCKED: reason] and state the blocking condition.
Do not use the marker merely because the work is hard, slow, or uncertain —
only for real blockers that need the user.

Completion protocol: when you believe every acceptance criterion of the Flow
Record is verifiably met, run the relevant verification (tests, build, checks)
instead of claiming it. If verification passes, end your reply with the exact
marker [DONE: short summary of what was verified]. Do not use the marker unless
you actually ran the verification and it passed — the goal will pause for an
independent goal-verify pass.`
}

/**
 * 带锁的 goal 读-改-写单一入口：同一 sessionID 的操作串行，杜绝并发丢失更新。
 * fn 接收当前 goal 与宿主会话，返回写回的 goal（null 表示删除）与调用方结果 value。
 * 当前无 goal 且 fn 也返回 null 时跳过写回（避免对不存在 goal 的无谓删除/写入）。
 */
export async function mutateGoal<T>(
  store: GoalStore,
  sessionID: string,
  fn: (goal: GoalData | null, session: GoalSession | null) => Promise<{ goal: GoalData | null; value: T }>,
): Promise<T> {
  return goalMutex.runExclusive(sessionID, async () => {
    const current = await store.read(sessionID)
    const { goal: next, value } = await fn(current.goal, current.session)
    if (next !== null || current.goal !== null) {
      await store.write(sessionID, next, current.session)
    }
    return value
  })
}

// ─── V2 goal 工具（tool.transform 注册用描述符） ───

/** goal 工具执行时可见的 context 最小面（V2 ToolContext 子集） */
export interface GoalToolContext {
  sessionID: string
  agent?: string
}

export interface GoalToolInput {
  op: "create" | "get" | "complete" | "resume" | "cancel" | "pause" | "edit"
  parent_issue_number?: number
  token_budget?: number
}

export interface GoalToolResult {
  content: string
}

/**
 * goal 工具的允许名单（与权限规则层一致）。
 * 规则层通过 agent permissions 隐藏/放行工具；此处的检查是工具级兜底，
 * 覆盖规则层未覆盖的 agent（例如后续新注册的 agent）。
 */
export const GOAL_ALLOWED_AGENTS = new Set(["dev-lifecycle", "goal-verify"])

export const GOAL_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    op: {
      type: "string",
      enum: ["create", "get", "complete", "resume", "cancel", "pause", "edit"],
      description: "Goal operation",
    },
    parent_issue_number: {
      type: "number",
      description: "Parent GitHub Issue number of the Flow Record (required for create; editable via edit)",
    },
    token_budget: {
      type: "number",
      description: "Optional token budget guardrail; goal auto-pauses when tokensUsed reaches it. Pass 0 via edit to remove the budget",
    },
  },
  required: ["op"],
  additionalProperties: false,
} as const

export const GOAL_TOOL_DESCRIPTION = `Manage the active goal-mode objective (minimal: parentIssueNumber/status/continuationCount).

Use a single op field:
- create: starts a goal bound to a Flow Record. Requires parent_issue_number.
- get: returns the current goal.
- resume: re-activates a paused goal.
- cancel: discards the current goal.
- pause: pauses the active goal.
- complete: marks the goal as completed. Follow the returned instructions.`

/**
 * 构建 goal 工具描述符：{name, description, input(JSON Schema), options, execute}。
 * execute 返回 {content}（V2 Tool.Result 形状）；授权在工具内自检（见 GOAL_ALLOWED_AGENTS）。
 */
export function buildGoalTool(store: GoalStore, projectDir: string) {
  return {
    name: "goal",
    description: GOAL_TOOL_DESCRIPTION,
    input: GOAL_TOOL_INPUT_SCHEMA,
    options: { permission: "goal" },

    async execute(args: GoalToolInput, context: GoalToolContext): Promise<GoalToolResult> {
      if (!context.agent || !GOAL_ALLOWED_AGENTS.has(context.agent)) {
        return {
          content: `Error: the goal tool is restricted to the cabbage flow agents (dev-lifecycle, goal-verify). Agent "${context.agent ?? "unknown"}" is not authorized.`,
        }
      }

      const sessionID = context.sessionID
      // 只读判断：当前会话是否为子 agent、目标会话（父会话）ID
      const { session } = await store.read(sessionID)
      const isSubAgent = !!session?.parentID
      const targetSessionID = session?.parentID ?? sessionID

      if (isSubAgent && ["create", "pause", "resume", "cancel", "edit"].includes(args.op)) {
        return { content: `Error: sub-agents cannot call goal({op:"${args.op}"}). Goal lifecycle operations are restricted to the main session.` }
      }

      if (isSubAgent && args.op === "complete") {
        const agentName = context.agent
        if (agentName !== "goal-verify") {
          return { content: `Error: only the goal-verify agent can complete the goal. Agent "${agentName}" is not authorized.` }
        }
        return { content: await mutateGoal(store, targetSessionID, async (goal) => {
          if (!goal) return { goal, value: "No goal to complete in the parent session." }
          if (goal.status !== "active") {
            return { goal, value: `Parent session goal is not active (status: ${goal.status}).` }
          }
          goal.status = "complete"
          // flow 级持久化：complete-flow 可跨会话识别验证完成（不依赖 index 会话一致性）
          try {
            await updateFlowSession(projectDir, goal.parentIssueNumber, { goalComplete: true, status: "completed" })
          } catch {
            // 索引写入失败不阻塞 goal 完成（goal 本身已持久化）
          }
          return { goal, value: `Goal completed and verified: Flow #${goal.parentIssueNumber}` }
        }) }
      }

      switch (args.op) {
        case "create":
          return { content: await mutateGoal(store, sessionID, async (goal) => {
            if (goal?.status === "active") {
              // 必须返回原 goal（不能返回 null）：mutateGoal 在 next===null 且 current 非 null
              // 时会删除现有 goal，错误分支返回 null 等于把活动 goal 取消了
              return { goal, value: `Error: an active goal already exists for Flow #${goal.parentIssueNumber}` }
            }
            const parentIssue = Number(args.parent_issue_number)
            if (!Number.isInteger(parentIssue) || parentIssue <= 0) {
              const got = args.parent_issue_number === undefined ? "" : ` (got: ${args.parent_issue_number})`
              return { goal, value: `Error: parent_issue_number is required (positive integer)${got}` }
            }
            // 快照创建时的 agent/模型（模型来自会话当前选择；此后由 selection 事件刷新）
            const sessionModel = session?.model
            const createdProfile = {
              agent: context.agent!,
              ...(sessionModel && sessionModel.providerID && sessionModel.id
                ? { model: { providerID: sessionModel.providerID, id: sessionModel.id, ...(sessionModel.variant ? { variant: sessionModel.variant } : {}) } }
                : {}),
            }
            const created = createGoal(
              parentIssue,
              createdProfile,
              typeof args.token_budget === "number" && Number.isFinite(args.token_budget) && args.token_budget > 0
                ? Math.floor(args.token_budget)
                : undefined,
            )
            // 记账基线：create 时点的会话累计 token 快照（后续 used = 当前累计 − baseline）。
            // 拉取失败 → baseline 0（护栏方向保守：把全部可见消耗计入）。
            try {
              created.tokensBaseline = snapshotTokenTotal(await store.sessionTokens(sessionID))
            } catch {
              created.tokensBaseline = 0
            }
            // flow 级绑定：供插件重启后的 autoResume 恢复 active goal
            try {
              await bindSession(projectDir, created.parentIssueNumber, sessionID)
            } catch {
              // 索引写入失败不阻塞 goal 创建（goal 本身已持久化在 session metadata）
            }
            return { goal: created, value: `Goal created: Flow #${created.parentIssueNumber}\nStatus: active` }
          }) }

        case "get": {
          const { goal } = await store.read(targetSessionID)
          return { content: goal ? formatGoal(goal) : "No active goal." }
        }

        case "complete": {
          const { goal } = await store.read(sessionID)
          if (!goal) return { content: "No active goal." }
          if (goal.status !== "active") return { content: `Goal is not active (status: ${goal.status}).` }
          return { content: `BLOCKED: Call the goal-verify sub-agent via the Task tool. Only the sub-agent can complete verification.` }
        }

        case "resume":
          return { content: await mutateGoal(store, sessionID, async (goal) => {
            if (!goal) return { goal, value: "No goal to resume." }
            if (!canTransitionTo(goal, "active")) return { goal, value: `Goal cannot be resumed (status: ${goal.status}).` }
            // 用户显式恢复：清除用户中断标记，避免恢复后被残留标记立即再次暂停
            clearAborted(sessionID)
            goal.status = "active"
            goal.continuationCount = 0
            // kickoff 信号：resume 后首次 tick 豁免 [BLOCKED:] 检测，防止被旧报告立即再次暂停
            goal.statusReason = "resumed"
            return { goal, value: `Goal resumed: Flow #${goal.parentIssueNumber}\nStatus: active` }
          }) }

        case "pause":
          return { content: await mutateGoal(store, sessionID, async (goal) => {
            if (!goal) return { goal, value: "No goal to pause." }
            if (!canTransitionTo(goal, "paused")) return { goal, value: `Goal cannot be paused (status: ${goal.status}).` }
            goal.status = "paused"
            return { goal, value: `Goal paused: Flow #${goal.parentIssueNumber}\nStatus: paused` }
          }) }

        case "cancel":
          return { content: await mutateGoal(store, sessionID, async (goal) => {
            if (!goal) return { goal, value: "No goal to cancel." }
            // 同步清除 session-index entry，避免重启 autoResume 恢复已取消 goal
            try {
              await removeFlowSession(projectDir, goal.parentIssueNumber)
            } catch {
              // 索引清理失败不阻塞取消（goal 本身已移除）
            }
            return { goal: null, value: `Goal cancelled: Flow #${goal.parentIssueNumber}` }
          }) }

        case "edit":
          return { content: await mutateGoal(store, sessionID, async (goal) => {
            if (!goal) return { goal, value: "No goal to edit." }
            if (goal.status === "complete") {
              return { goal, value: "Error: completed goals are read-only. Remove the goal and create a new one." }
            }
            const budgetGiven = typeof args.token_budget === "number"
              && Number.isFinite(args.token_budget)
              && args.token_budget > 0
            const budgetRemoved = args.token_budget === 0
            const nextParent = typeof args.parent_issue_number === "number"
              && Number.isFinite(args.parent_issue_number)
              && args.parent_issue_number > 0
              ? Math.floor(args.parent_issue_number)
              : null
            if (!budgetGiven && !budgetRemoved && nextParent === null) {
              return { goal, value: "Error: nothing to edit — pass parent_issue_number and/or token_budget" }
            }
            if (budgetGiven) goal.tokenBudget = Math.floor(args.token_budget as number)
            if (budgetRemoved) delete goal.tokenBudget
            if (nextParent !== null && nextParent !== goal.parentIssueNumber) {
              const oldParent = goal.parentIssueNumber
              goal.parentIssueNumber = nextParent
              // 换 Flow：旧目标的记账/基线/创建时刻全部重置（新目标从 edit 时点起算）。
              goal.tokensUsed = 0
              delete goal.tokensBaseline
              goal.createdAt = Date.now()
              try {
                goal.tokensBaseline = snapshotTokenTotal(await store.sessionTokens(sessionID))
              } catch {
                goal.tokensBaseline = 0
              }
              try {
                await bindSession(projectDir, goal.parentIssueNumber, sessionID)
              } catch (error) {
                // 新 Flow 索引绑定失败：新 entry 缺失，重启 autoResume 无法恢复新 goal
                console.warn(`[cabbage] goal edit: bindSession #${goal.parentIssueNumber} failed:`, (error as Error | null)?.message ?? error)
              }
              try {
                await removeFlowSession(projectDir, oldParent)
              } catch (error) {
                // 旧 entry 清理失败：残留 active entry 会在重启时被 autoResume 一致性自愈清理
                console.warn(`[cabbage] goal edit: removeFlowSession #${oldParent} failed:`, (error as Error | null)?.message ?? error)
              }
            }
            return { goal, value: `Goal updated: Flow #${goal.parentIssueNumber}\nStatus: ${goal.status}` }
          }) }

        default:
          return { content: `Error: unknown operation "${args.op}"` }
      }
    },
  }
}

/**
 * task_control 工具（spec §2.3）：Task Record + worktree + PR + merge（核心）。
 * 八 op：create-task / start-task / submit-task / submit-review /
 *       merge-task / cancel-task / destroy-worktree / status-task。
 * caller：primary 全量；developer 不允许调用 task_control（无门禁绕过面）。
 * server.ts 接线由后续批次统一处理（本批不注册，避免文件冲突）。
 */
import { tool } from "@opencode-ai/plugin/tool"
import { requireToolCaller, CALLER_NOT_AUTHORIZED } from "../kernel/caller.js"
import {
  createTask,
  startTask,
  submitTask,
  submitReview,
  mergeTask,
  cancelTask,
  destroyTaskWorktree,
  readTaskStatus,
  parseDependenciesArg,
} from "../kernel/task.js"

/** task_control 工具依赖 */
export interface TaskControlDeps {
  projectDir: string
  sessionClient: {
    session: {
      get(input: { sessionID: string }): Promise<{ data?: { parentID?: string | null } }>
    }
  }
}

export type TaskControlResponse = {
  ok: boolean
  task?: { parentIssueNumber?: number; taskId?: string; issueNumber?: number }
  issueNumber?: number
  branch?: string
  worktreePath?: string
  policy?: unknown
  baseline?: unknown
  prNumber?: number
  evidenceRevision?: number
  verdict?: string
  risk?: string
  reason?: string
  report?: unknown
  missing?: string[]
  error?: { code: string; message: string }
}

/**
 * task_control 工具工厂（spec §2.3）。
 * caller 门禁：primary 全量；developer 拒绝（无门禁绕过面）。
 */
export function createTaskControlTool(deps: TaskControlDeps) {
  return tool({
    description: `Control the Task Record lifecycle (a Task = one GitHub Sub Issue under a Flow Parent Issue).

Operations:
- create-task: Validate the functional title, derive the slug, and create a Sub Issue (body contains acceptance criteria, dependencies, and the Closes convention) linked to the parent.
- start-task: Gate checks (Planning Baseline merged, dependencies merged, parallel < 5), then worktree-start, capture the clean workspace baseline, freeze the TDD policy, and mark the task running.
- submit-task: TDD hard gate — reject PR creation when evidence is incomplete (no comment / regression not pass / compliance fail). On pass: push the branch, create the PR (body references the Task Record + evidence comment link, Closes convention), and mark reviewing.
- submit-review: primary submits the reviewer's dual-axis result via gh pr review --approve/--request-changes (the reviewer itself is read-only).
- merge-task: Merge gates (CI checks pass + branch protection + dual-layer risk escalation, only up not down; high risk needs a non-author human approval) → merge PR (--match-head-commit) → close the Sub Issue → cleanly destroy the worktree.
- cancel-task / destroy-worktree: controlled cancellation / preflight destruction, both require user_confirmed (unless the PR is merged and clean).
- status-task: Aggregate the Task Record, PR, and checks into one report.

Caller: primary only (developer has no task_control access).`,
    args: {
      op: tool.schema
        .enum(["create-task", "start-task", "submit-task", "submit-review", "merge-task", "cancel-task", "destroy-worktree", "status-task"])
        .describe("Task control operation"),
      title: tool.schema.string().optional().describe("Functional title (kebab-case slug) for create-task"),
      parent_issue_number: tool.schema.number().optional().describe("Parent GitHub Issue number of the Flow Record"),
      task_id: tool.schema.string().optional().describe("Task slug (kernel-derived)"),
      acceptance_criteria: tool.schema.string().optional().describe("JSON array of acceptance criteria for create-task"),
      depends_on: tool.schema.string().optional().describe("Comma-separated dependency issue numbers for create-task"),
      pr_number: tool.schema.number().optional().describe("PR number (submit-review/status)"),
      risk: tool.schema.enum(["low", "high"]).optional().describe("Model-assessed risk for merge-task (kernel may escalate, never downgrade)"),
      verdict: tool.schema.enum(["approve", "request-changes"]).optional().describe("Review verdict for submit-review"),
      comment: tool.schema.string().optional().describe("Review comment for submit-review request-changes"),
      user_confirmed: tool.schema.boolean().optional().describe("User confirmation (required for cancel-task/destroy-worktree)"),
    },
    async execute(args, ctx) {
      const op = args.op as string

      // caller 门禁（矩阵单一来源，§2.2）：task_control 仅 primary（developer 拒绝）
      const denied = await requireToolCaller(ctx, "task_control", op, deps.sessionClient)
      if (denied) return errorResponse(CALLER_NOT_AUTHORIZED, denied)

      try {
        switch (op) {
          case "create-task":
            return handleCreateTask(deps, args)
          case "start-task":
            return handleStartTask(deps, args)
          case "submit-task":
            return handleSubmitTask(deps, args)
          case "submit-review":
            return handleSubmitReview(args)
          case "merge-task":
            return handleMergeTask(deps, args)
          case "cancel-task":
            return handleCancelTask(deps, args)
          case "destroy-worktree":
            return handleDestroyWorktree(deps, args)
          case "status-task":
            return handleStatusTask(deps, args)
          default:
            return errorResponse("UNKNOWN_OP", `Unknown op: "${op}"`)
        }
      } catch (err) {
        return errorResponse("INTERNAL_ERROR", String(err))
      }
    },
  })
}

/** 独立注册辅助：把 task_control 挂到工具注册表（后续接线批次使用） */
export function registerTaskControl(registry: Record<string, unknown>, deps: TaskControlDeps): void {
  registry.task_control = createTaskControlTool(deps)
}

// ─── op handlers ───

async function handleCreateTask(deps: TaskControlDeps, args: Record<string, unknown>): Promise<string> {
  const parent = Number(args.parent_issue_number)
  const title = (args.title as string | undefined) ?? ""
  if (!Number.isInteger(parent) || parent <= 0) {
    return errorResponse("POLICY_INVALID", "parent_issue_number is required")
  }
  if (title.trim() === "") {
    return errorResponse("POLICY_INVALID", "title is required for create-task")
  }

  const result = await createTask({
    projectDir: deps.projectDir,
    parentIssueNumber: parent,
    title,
    acceptanceCriteriaJson: args.acceptance_criteria as string | undefined,
    dependencies: parseDependenciesArg(args.depends_on as string | undefined),
  })
  if (!result.ok) {
    return errorResponse(result.code, result.message)
  }
  return okResponse({ task: result.ref })
}

async function handleStartTask(deps: TaskControlDeps, args: Record<string, unknown>): Promise<string> {
  const req = requireTaskRef(args)
  if (typeof req === "string") return req

  const result = await startTask(deps.projectDir, req.parent, req.taskId)
  if (!result.ok) {
    return errorResponse(result.code, result.message)
  }
  return okResponse({ issueNumber: result.issueNumber, branch: result.branch, worktreePath: result.worktreePath, policy: result.policy, baseline: result.baseline })
}

async function handleSubmitTask(deps: TaskControlDeps, args: Record<string, unknown>): Promise<string> {
  const req = requireTaskRef(args)
  if (typeof req === "string") return req

  const result = await submitTask(deps.projectDir, req.parent, req.taskId)
  if (!result.ok) {
    return errorResponse(result.code, result.message, result.missing)
  }
  return okResponse({ prNumber: result.prNumber, evidenceRevision: result.evidenceRevision })
}

async function handleSubmitReview(args: Record<string, unknown>): Promise<string> {
  const pr = Number(args.pr_number)
  const verdict = args.verdict as "approve" | "request-changes" | undefined
  if (!Number.isInteger(pr) || pr <= 0) {
    return errorResponse("POLICY_INVALID", "pr_number is required")
  }
  if (verdict !== "approve" && verdict !== "request-changes") {
    return errorResponse("POLICY_INVALID", "verdict is required: approve|request-changes")
  }

  const result = await submitReview(pr, verdict, args.comment as string | undefined)
  if (!result.ok) {
    return errorResponse(result.code, result.message)
  }
  return okResponse({ prNumber: result.prNumber, verdict: result.verdict })
}

async function handleMergeTask(deps: TaskControlDeps, args: Record<string, unknown>): Promise<string> {
  const req = requireTaskRef(args)
  if (typeof req === "string") return req
  const risk = args.risk === "high" ? "high" : "low"

  const result = await mergeTask(deps.projectDir, req.parent, req.taskId, risk)
  if (!result.ok) {
    return errorResponse(result.code, result.message)
  }
  return okResponse({ prNumber: result.prNumber, risk: result.risk })
}

async function handleCancelTask(deps: TaskControlDeps, args: Record<string, unknown>): Promise<string> {
  const req = requireTaskRef(args)
  if (typeof req === "string") return req

  const result = await cancelTask(deps.projectDir, req.parent, req.taskId, args.user_confirmed === true)
  if (!result.ok) {
    return errorResponse(result.code, result.message)
  }
  return okResponse({ issueNumber: result.issueNumber })
}

async function handleDestroyWorktree(deps: TaskControlDeps, args: Record<string, unknown>): Promise<string> {
  const req = requireTaskRef(args)
  if (typeof req === "string") return req

  const result = await destroyTaskWorktree(deps.projectDir, req.parent, req.taskId, args.user_confirmed === true)
  if (!result.ok) {
    return errorResponse(result.code, result.message)
  }
  return okResponse({ reason: result.reason })
}

async function handleStatusTask(deps: TaskControlDeps, args: Record<string, unknown>): Promise<string> {
  const req = requireTaskRef(args)
  if (typeof req === "string") return req

  const result = await readTaskStatus(deps.projectDir, req.parent, req.taskId)
  if (!result.ok) {
    return errorResponse(result.code, result.message)
  }
  return okResponse({ report: result.report })
}

// ─── helpers ───

/** 提取 parent_issue_number + task_id；缺失返回错误响应字符串 */
function requireTaskRef(args: Record<string, unknown>): { parent: number; taskId: string } | string {
  const parent = Number(args.parent_issue_number)
  const taskId = (args.task_id as string | undefined) ?? ""
  if (!Number.isInteger(parent) || parent <= 0) {
    return errorResponse("POLICY_INVALID", "parent_issue_number is required")
  }
  if (taskId.trim() === "") {
    return errorResponse("POLICY_INVALID", "task_id is required")
  }
  return { parent, taskId }
}

function okResponse(overrides: Partial<TaskControlResponse> = {}): string {
  const resp: TaskControlResponse = { ok: true, ...overrides }
  return JSON.stringify(resp, null, 2)
}

function errorResponse(code: string, message: string, missing?: string[]): string {
  const resp: TaskControlResponse = { ok: false, error: { code, message }, ...(missing ? { missing } : {}) }
  return JSON.stringify(resp, null, 2)
}

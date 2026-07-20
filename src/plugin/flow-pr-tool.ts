import type { FlowRun, TaskState, PRCheckpoints } from "../flowrun/types.js"
import { preflightPRCreate, createOrReusePR, type CreatePRResult } from "../flowrun/pr.js"
import type { FlowBroker } from "./broker.js"

// ─── 请求 / 响应类型 ───

export interface FlowPRCreateRequest {
  op: string
  parentIssueNumber: number
  taskId?: string
  currentHeadSha?: string
  prTitle?: string
  prBody?: string
  baseBranch?: string
}

export interface FlowPRCreateResponse {
  ok: boolean
  conflictPause: boolean
  persisted: boolean
  prNumber?: number
  prUrl?: string
  created?: boolean
  taskStatus?: string
  error?: {
    code: string
    message: string
  }
}

// ─── 内部辅助 ───

function initPRCheckpoints(prNumber: number): PRCheckpoints {
  return {
    prNumber,
    localChecks: { name: "localChecks", status: "pending", evidence: [] },
    ciChecks: { name: "ciChecks", status: "pending", evidence: [] },
    reviewerApproval: { name: "reviewerApproval", status: "pending", evidence: [] },
    goalVerification: { name: "goalVerification", status: "pending", evidence: [] },
    branchProtection: { name: "branchProtection", status: "pending", evidence: [] },
    mergeResult: { name: "mergeResult", status: "pending", evidence: [] },
    tddCompliance: null,
    verification: null,
    coverage: null,
    qualityContractDigest: null,
  }
}

// ─── Broker-aware handler ───

/**
 * 通过 FlowBroker 执行 flow_pr create 操作。
 *
 * 流程：
 * 1. 通过 broker.writeFlowRunWithLock 读取 FlowRun
 * 2. 提取目标 TaskState，执行 preflight
 * 3. 调用 createOrReusePR（幂等：已有 PR 则复用）
 * 4. 写入 prNumber + 初始化 prCheckpoints → task status → "reviewing"
 * 5. 成功时持久化回 Issue（broker 自动处理 revision + 乐观锁）
 * 6. PERSIST_CONFLICT 时设置 conflictPause=true
 *
 * 补偿：GitHub 创建成功但 FlowRun 写入失败 → 重试时通过 head branch 找回同一 PR
 */
export async function handleFlowPrCreateWithBroker(
  broker: FlowBroker,
  req: FlowPRCreateRequest,
): Promise<FlowPRCreateResponse> {
  const taskId = req.taskId
  const currentHeadSha = req.currentHeadSha
  const prTitle = req.prTitle
  const prBody = req.prBody
  const baseBranch = req.baseBranch ?? "main"

  if (!taskId) {
    return {
      ok: false,
      conflictPause: false,
      persisted: false,
      error: { code: "POLICY_INVALID", message: "task_id is required for pr-create" },
    }
  }

  if (!currentHeadSha) {
    return {
      ok: false,
      conflictPause: false,
      persisted: false,
      error: { code: "POLICY_INVALID", message: "current_head_sha is required for pr-create" },
    }
  }

  if (!prTitle) {
    return {
      ok: false,
      conflictPause: false,
      persisted: false,
      error: { code: "POLICY_INVALID", message: "pr_title is required for pr-create" },
    }
  }

  if (!prBody) {
    return {
      ok: false,
      conflictPause: false,
      persisted: false,
      error: { code: "POLICY_INVALID", message: "pr_body is required for pr-create" },
    }
  }

  // ── 先创建/复用 PR（可能已经存在） ──
  let prResult: CreatePRResult

  try {
    // Step 1: 读取 FlowRun 获取 repo + branch 信息
    const { flowRunResult, currentBody } = await (async () => {
      const mod = await import("../flowrun/github.js")
      return mod.readFlowRunWithLock(req.parentIssueNumber)
    })()

    if (!flowRunResult.ok || currentBody === null) {
      return {
        ok: false,
        conflictPause: false,
        persisted: false,
        error: {
          code: "READ_FAILED",
          message: `Failed to read FlowRun from issue #${req.parentIssueNumber}`,
        },
      }
    }

    const flowRun = flowRunResult.data
    const task = flowRun.tasks[taskId]
    if (!task) {
      return {
        ok: false,
        conflictPause: false,
        persisted: false,
        error: { code: "TASK_NOT_FOUND", message: `Task "${taskId}" not found in FlowRun` },
      }
    }

    // Step 2: Preflight 检查（无副作用）
    const preflight = preflightPRCreate(task, currentHeadSha)
    if (!preflight.ok) {
      return {
        ok: false,
        conflictPause: false,
        persisted: false,
        error: preflight,
      }
    }

    // Step 3: 确定 head branch（从 executionBinding）
    const headBranch = task.executionBinding?.branch ?? taskId

    // Step 4: 创建或复用 PR
    prResult = await createOrReusePR({
      repo: flowRun.repo,
      headBranch,
      baseBranch,
      title: prTitle,
      body: prBody,
    })
  } catch (err) {
    return {
      ok: false,
      conflictPause: false,
      persisted: false,
      error: { code: "INTERNAL_ERROR", message: String(err) },
    }
  }

  // Step 5: 通过 broker 持久化（乐观锁写入）
  const writeResult = await broker.writeFlowRunWithLock<{
    prNumber: number
    prUrl: string
    created: boolean
    taskStatus: string
  }>(req.parentIssueNumber, (flowRun) => {
    const task = flowRun.tasks[taskId]
    if (!task) {
      return {
        flowRun,
        result: { prNumber: 0, prUrl: "", created: false, taskStatus: "" },
        shouldPersist: false,
      }
    }

    // 写入 prNumber 和 checkpoints
    task.prNumber = prResult.prNumber
    task.prCheckpoints = initPRCheckpoints(prResult.prNumber)
    task.status = "reviewing"

    return {
      flowRun,
      result: {
        prNumber: prResult.prNumber,
        prUrl: prResult.prUrl,
        created: prResult.created,
        taskStatus: task.status,
      },
      shouldPersist: true,
    }
  })

  if (!writeResult.ok) {
    // PERSIST_CONFLICT or READ_FAILED
    return {
      ok: false,
      conflictPause: writeResult.code === "PERSIST_CONFLICT",
      persisted: false,
      prNumber: prResult.prNumber, // 补偿信息：PR 已创建，重试时可找回
      error: {
        code: writeResult.code,
        message: writeResult.message,
      },
    }
  }

  return {
    ok: true,
    conflictPause: false,
    persisted: writeResult.persisted,
    prNumber: writeResult.result.prNumber,
    prUrl: writeResult.result.prUrl,
    created: writeResult.result.created,
    taskStatus: writeResult.result.taskStatus,
  }
}

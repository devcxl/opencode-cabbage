import {
  type FlowRun, type FlowStage, type TaskState,
  FLOW_RUN_STAGES, TASK_STATUSES,
} from "./types.js"

export interface GateResult {
  allowed: boolean
  reason?: string
  missing: string[]
  failedChecks: string[]
}

function ok(): GateResult {
  return { allowed: true, missing: [], failedChecks: [] }
}

function block(reason: string, missing: string[] = [], failedChecks: string[] = []): GateResult {
  return { allowed: false, reason, missing, failedChecks }
}

export function canStartStage(flowRun: FlowRun, stage: FlowStage): GateResult {
  const stageIdx = FLOW_RUN_STAGES.indexOf(stage)
  if (stageIdx === -1) return block(`Unknown stage: ${stage}`)

  if (flowRun.status !== "running") {
    return block(`FlowRun is ${flowRun.status}, not running`)
  }

  const prevStages = FLOW_RUN_STAGES.slice(0, stageIdx)
  for (const prev of prevStages) {
    const s = flowRun.stages[prev]
    if (s.status !== "pass") {
      return block(`Prerequisite stage "${prev}" is not complete (status: ${s.status})`, [prev])
    }
  }

  const stageState = flowRun.stages[stage]
  if (!stageState) return block(`Stage state not found: ${stage}`)

  if (stageState.status === "pass") {
    return block(`Stage "${stage}" already completed`)
  }

  return ok()
}

export function canCompleteStage(flowRun: FlowRun, stage: FlowStage): GateResult {
  const stageState = flowRun.stages[stage]
  if (!stageState) return block(`Stage state not found: ${stage}`)

  const missingArtifacts = stageState.requiredArtifacts.filter(a => !a)
  const failedChecks = stageState.checks.filter(c => c.status === "fail").map(c => c.name)

  if (missingArtifacts.length > 0) {
    return block(`Stage "${stage}" has missing required artifacts`, missingArtifacts)
  }

  if (failedChecks.length > 0) {
    return block(`Stage "${stage}" has failed checks`, [], failedChecks)
  }

  const pendingChecks = stageState.checks.filter(c => c.status === "pending")
  if (pendingChecks.length > 0) {
    return block(`Stage "${stage}" has pending checks: ${pendingChecks.map(c => c.name).join(", ")}`)
  }

  if (stage === "merge") {
    return canMerge(flowRun)
  }

  return ok()
}

export function canStartTask(flowRun: FlowRun, taskId: string): GateResult {
  const task = flowRun.tasks[taskId]
  if (!task) return block(`Task not found: ${taskId}`)

  if (flowRun.status !== "running") {
    return block(`FlowRun is ${flowRun.status}, not running`)
  }

  const codeStage = flowRun.stages.code
  if (codeStage.status !== "running" && codeStage.status !== "pass") {
    return block("Code stage is not active")
  }

  if (task.status === "merged") return block(`Task "${taskId}" already merged`)
  if (task.status === "running") return block(`Task "${taskId}" already running`)
  if (task.status === "blocked") return block(`Task "${taskId}" is blocked: ${task.blockedReason || "unknown reason"}`)

  for (const dep of task.dependsOn) {
    const depTask = flowRun.tasks[dep]
    if (!depTask) return block(`Dependency task "${dep}" not found`)
    if (depTask.status !== "merged") {
      return block(`Dependency "${dep}" is not merged (status: ${depTask.status})`, [], [dep])
    }
  }

  return ok()
}

export function canCompleteTask(flowRun: FlowRun, taskId: string): GateResult {
  const task = flowRun.tasks[taskId]
  if (!task) return block(`Task not found: ${taskId}`)

  if (task.status !== "running") {
    return block(`Task "${taskId}" is not running (status: ${task.status})`)
  }

  return ok()
}

/**
 * 检查 Task 是否满足创建 PR 的前置条件。
 *
 * 规则：
 * - Task 状态必须为 running
 * - regression.status === "pass"
 * - verification.status === "pass"
 * - regression.headSha 和 verification.headSha 非空且一致
 */
export function canCreatePR(task: TaskState): GateResult {
  if (task.status !== "running") {
    return block(`Task "${task.id}" is not running (status: ${task.status})`)
  }

  const { regression, verification } = task.tddEvidence

  if (regression.status !== "pass") {
    return block(`Regression is not complete (status: ${regression.status})`, [],
      ["regression"])
  }

  if (verification.status !== "pass") {
    return block(`Verification is not complete (status: ${verification.status})`, [],
      ["verification"])
  }

  if (!regression.headSha || !verification.headSha) {
    return block("Regression or verification is missing head SHA", [],
      ["headSha"])
  }

  if (regression.headSha !== verification.headSha) {
    return block(
      `Head SHA mismatch: regression=${regression.headSha}, verification=${verification.headSha}`,
      [],
      ["headSha"],
    )
  }

  return ok()
}

export function canMerge(flowRun: FlowRun): GateResult {
  if (flowRun.status !== "running" && flowRun.status !== "merging") {
    return block("FlowRun is not in a mergeable state")
  }

  const reviewStage = flowRun.stages.review
  if (reviewStage.status !== "pass") {
    return block("Review stage is not complete")
  }

  return ok()
}

export function allTasksComplete(flowRun: FlowRun): boolean {
  const taskIds = Object.keys(flowRun.tasks)
  if (taskIds.length === 0) return false
  return taskIds.every(id => flowRun.tasks[id].status === "merged")
}

export function getReadyTasks(flowRun: FlowRun): TaskState[] {
  return Object.values(flowRun.tasks).filter(t => {
    if (t.status !== "pending" && t.status !== "ready") return false

    const depsMet = t.dependsOn.every(dep => {
      const depTask = flowRun.tasks[dep]
      return depTask && depTask.status === "merged"
    })

    return depsMet
  })
}

export function determineNextStage(flowRun: FlowRun): { stage: FlowStage | null; reason: string } {
  for (const stage of FLOW_RUN_STAGES) {
    const s = flowRun.stages[stage]
    if (s.status === "pending" || s.status === "failed" || s.status === "blocked") {
      const gate = canStartStage(flowRun, stage)
      if (gate.allowed) {
        return { stage, reason: `Stage "${stage}" is ready to start` }
      }
      return { stage: null, reason: `Cannot start "${stage}": ${gate.reason}` }
    }
    if (s.status === "running") {
      return { stage, reason: `Stage "${stage}" is in progress` }
    }
  }
  return { stage: null, reason: "All stages complete" }
}

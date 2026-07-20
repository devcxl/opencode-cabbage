import type {
  FlowRun, FlowStage, TaskState, TaskExecutionBinding, TddPolicy,
  FlowRunStatus, StageStatus, TaskStatus,
} from "./types.js"
import {
  canStartStage, canCompleteStage, canStartTask, canMerge,
} from "./gate.js"
import type { GateResult } from "./gate.js"

// ─── 错误类型 ───

export interface TransitionError {
  code: string
  message: string
}

export type TransitionResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: TransitionError }

// ─── 受控 stage 集合 ───

/** flow_control 可启动的 stage */
const STARTABLE_STAGES: FlowStage[] = ["requirements", "design", "tasks", "code"]

/** flow_control 可完成的 stage（code/test/review/merge 由 finalize 完成） */
const COMPLETABLE_STAGES: FlowStage[] = ["requirements", "design", "tasks"]

function gateToError(gate: GateResult): TransitionError {
  return {
    code: "GATE_BLOCKED",
    message: gate.reason ?? "Gate check failed",
  }
}

// ─── FlowRun 状态迁移 ───

/**
 * 启动 FlowRun：planned → running
 *
 * 幂等：已经是 running 则直接返回（不报错）。
 */
export function flowRunStart(flowRun: FlowRun): TransitionResult<FlowRun> {
  if (flowRun.status === "running") {
    return { ok: true, value: flowRun }
  }
  if (flowRun.status !== "planned") {
    return {
      ok: false,
      error: { code: "INVALID_TRANSITION", message: `FlowRun is ${flowRun.status}, not planned` },
    }
  }
  flowRun.status = "running"
  flowRun.startedAt = new Date().toISOString()
  return { ok: true, value: flowRun }
}

// ─── Stage 状态迁移 ───

/**
 * 启动 Stage：pending → running
 *
 * 约束：
 * - 仅允许 requirements/design/tasks/code
 * - 验证前置 stage 已 pass
 *
 * 幂等：已经是 running 则直接返回。
 */
export function flowStageStart(flowRun: FlowRun, stage: FlowStage): TransitionResult<FlowRun> {
  if (!STARTABLE_STAGES.includes(stage)) {
    return {
      ok: false,
      error: { code: "STAGE_NOT_CONTROLLABLE", message: `Stage "${stage}" cannot be started via flow_control` },
    }
  }

  if (flowRun.stages[stage].status === "running") {
    return { ok: true, value: flowRun }
  }

  const gate = canStartStage(flowRun, stage)
  if (!gate.allowed) {
    return { ok: false, error: gateToError(gate) }
  }

  flowRun.stages[stage].status = "running"
  return { ok: true, value: flowRun }
}

/**
 * 完成 Stage：running → pass
 *
 * 约束：
 * - 仅允许 requirements/design/tasks
 * - code/test/review/merge 由 finalize 完成
 * - 验证 pending checks 均已 pass
 *
 * 幂等：已经是 pass 则直接返回。
 */
export function flowStageComplete(flowRun: FlowRun, stage: FlowStage): TransitionResult<FlowRun> {
  if (!COMPLETABLE_STAGES.includes(stage)) {
    return {
      ok: false,
      error: { code: "STAGE_NOT_CONTROLLABLE", message: `Stage "${stage}" completion is only via finalize` },
    }
  }

  if (flowRun.stages[stage].status === "pass") {
    return { ok: true, value: flowRun }
  }

  const gate = canCompleteStage(flowRun, stage)
  if (!gate.allowed) {
    return { ok: false, error: gateToError(gate) }
  }

  flowRun.stages[stage].status = "pass"
  flowRun.stages[stage].completedAt = new Date().toISOString()
  return { ok: true, value: flowRun }
}

// ─── Task 状态迁移 ───

/**
 * 启动 Task：pending/ready → running
 *
 * 步骤：
 * 1. gate check：canStartTask（依赖已 merged、code stage 活跃等）
 * 2. policy 冻结：如果传入 tddPolicy，则覆盖 TaskState.tddPolicy
 * 3. 写入 executionBinding
 * 4. status → running
 *
 * 幂等：已经是 running 则直接返回（相同 taskId）。
 */
export function flowTaskStart(
  flowRun: FlowRun,
  taskId: string,
  executionBinding: TaskExecutionBinding,
  tddPolicy?: TddPolicy,
): TransitionResult<{ flowRun: FlowRun; task: TaskState }> {
  const task = flowRun.tasks[taskId]
  if (!task) {
    return {
      ok: false,
      error: { code: "TASK_NOT_FOUND", message: `Task "${taskId}" not found in FlowRun` },
    }
  }

  // 幂等：已经是 running
  if (task.status === "running") {
    // 更新 executionBinding（可能重连）
    task.executionBinding = executionBinding
    return { ok: true, value: { flowRun, task } }
  }

  const gate = canStartTask(flowRun, taskId)
  if (!gate.allowed) {
    return { ok: false, error: gateToError(gate) }
  }

  // 冻结 policy
  if (tddPolicy) {
    task.tddPolicy = tddPolicy
  }

  // 写入 execution binding
  task.executionBinding = executionBinding
  task.status = "running"
  task.startedAt = new Date().toISOString()

  return { ok: true, value: { flowRun, task } }
}

// ─── FlowRun Finalize ───

/**
 * FlowRun 终态绑定：所有 Task merged 后，顺序标记 code→test→review→merge 为 pass，
 * 并将 FlowRun 状态设为 completed。
 *
 * 规则：
 * - canMerge() 必须通过（所有 Task merged + FlowRun status 为 running/merging）
 * - 对 code/test/review/merge 四个 stage：若未 pass 则逐个标记 pass
 * - FlowRun status → completed，设置 completedAt
 *
 * 幂等：已经是 completed 则直接返回（不修改任何字段）。
 */
export function flowRunFinalize(flowRun: FlowRun): TransitionResult<FlowRun> {
  // 幂等：已 completed
  if (flowRun.status === "completed") {
    return { ok: true, value: flowRun }
  }

  // 前置检查：canMerge（所有 Task merged + FlowRun 状态正确）
  const mergeGate = canMerge(flowRun)
  if (!mergeGate.allowed) {
    return { ok: false, error: gateToError(mergeGate) }
  }

  // 顺序标记 finalize stages
  const finalizeStages: FlowStage[] = ["code", "test", "review", "merge"]

  for (const stage of finalizeStages) {
    const stageState = flowRun.stages[stage]
    if (!stageState) continue

    // 已经是 pass → 跳过
    if (stageState.status === "pass") continue

    // 标记 pass
    stageState.status = "pass"
    stageState.completedAt = new Date().toISOString()
  }

  // FlowRun → completed
  flowRun.status = "completed"
  flowRun.completedAt = new Date().toISOString()

  return { ok: true, value: flowRun }
}

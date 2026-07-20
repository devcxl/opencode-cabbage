import {
  type FlowRun, type FlowStage, type TaskState, type StageState, type PRCheckpoints,
  type FlowRunStatus, type TaskStatus, type StageStatus,
  FLOW_RUN_STAGES, FLOW_RUN_STATUSES, TASK_STATUSES, STAGE_STATUSES, CHECKPOINT_STATUSES,
  type ValidationError,
} from "./types.js"

export type { ValidationError } from "./types.js"

export function validateFlowRun(raw: unknown): { data: FlowRun | null; errors: ValidationError[] } {
  const errors: ValidationError[] = []

  if (!raw || typeof raw !== "object") {
    errors.push({ path: "", message: "FlowRun must be a non-null object" })
    return { data: null, errors }
  }

  const obj = raw as Record<string, unknown>

  if (typeof obj.flowRunId !== "string" || !obj.flowRunId) {
    errors.push({ path: "flowRunId", message: "Required string" })
  }

  if (typeof obj.repo !== "string" || !obj.repo) {
    errors.push({ path: "repo", message: "Required string" })
  }

  if (typeof obj.parentIssueNumber !== "number" || obj.parentIssueNumber <= 0) {
    errors.push({ path: "parentIssueNumber", message: "Required positive number" })
  }

  if (!FLOW_RUN_STATUSES.includes(obj.status as FlowRunStatus)) {
    errors.push({ path: "status", message: `Must be one of: ${FLOW_RUN_STATUSES.join(", ")}` })
  }

  if (typeof obj.schemaVersion !== "number") {
    errors.push({ path: "schemaVersion", message: "Required number" })
  }

  if (typeof obj.revision !== "number" || obj.revision < 0) {
    errors.push({ path: "revision", message: "Required non-negative number" })
  }

  // v2: FlowRun 级 repositoryQualityPolicy
  if (!obj.repositoryQualityPolicy || typeof obj.repositoryQualityPolicy !== "object") {
    errors.push({ path: "repositoryQualityPolicy", message: "Required object" })
  } else {
    const rqp = obj.repositoryQualityPolicy as Record<string, unknown>
    if (typeof rqp.mode !== "string" || !["off", "required"].includes(rqp.mode as string)) {
      errors.push({ path: "repositoryQualityPolicy.mode", message: 'Must be "off" or "required"' })
    }
    if (!Array.isArray(rqp.requiredChecks)) {
      errors.push({ path: "repositoryQualityPolicy.requiredChecks", message: "Required array" })
    }
  }

  validateStages(obj.stages, errors)
  validateTasks(obj.tasks, errors)

  const data = errors.length === 0 ? (raw as FlowRun) : null
  return { data, errors }
}

function validateStages(stages: unknown, errors: ValidationError[]): boolean {
  if (!stages || typeof stages !== "object") {
    errors.push({ path: "stages", message: "Required object with stage keys" })
    return false
  }

  const stageObj = stages as Record<string, unknown>

  for (const key of FLOW_RUN_STAGES) {
    const s = stageObj[key]
    if (!s || typeof s !== "object") {
      errors.push({ path: `stages.${key}`, message: "Missing or invalid stage object" })
      continue
    }
    validateStage(key as FlowStage, s as Record<string, unknown>, errors)
  }

  return true
}

function validateStage(stageKey: string, stage: Record<string, unknown>, errors: ValidationError[]) {
  if (!STAGE_STATUSES.includes(stage.status as StageStatus)) {
    errors.push({ path: `stages.${stageKey}.status`, message: "Invalid stage status" })
  }
  if (!Array.isArray(stage.requiredArtifacts)) {
    errors.push({ path: `stages.${stageKey}.requiredArtifacts`, message: "Required array" })
  }
  if (typeof stage.completedAt !== "string" && stage.completedAt !== null) {
    errors.push({ path: `stages.${stageKey}.completedAt`, message: "Must be string or null" })
  }
  if (!Array.isArray(stage.checks)) {
    errors.push({ path: `stages.${stageKey}.checks`, message: "Required array" })
  }
  if (!Array.isArray(stage.evidence)) {
    errors.push({ path: `stages.${stageKey}.evidence`, message: "Required array" })
  }
}

function validateTasks(tasks: unknown, errors: ValidationError[]): boolean {
  if (!tasks || typeof tasks !== "object") {
    errors.push({ path: "tasks", message: "Required object with task keys" })
    return false
  }

  const taskObj = tasks as Record<string, unknown>

  for (const [key, value] of Object.entries(taskObj)) {
    if (!value || typeof value !== "object") {
      errors.push({ path: `tasks.${key}`, message: "Invalid task object" })
      continue
    }
    validateTask(key, value as Record<string, unknown>, errors)
  }

  return true
}

function validateTask(taskKey: string, task: Record<string, unknown>, errors: ValidationError[]) {
  if (!task.id || typeof task.id !== "string") {
    errors.push({ path: `tasks.${taskKey}.id`, message: "Required string" })
  }
  if (!TASK_STATUSES.includes(task.status as TaskStatus)) {
    errors.push({ path: `tasks.${taskKey}.status`, message: "Invalid task status" })
  }
  if (!Array.isArray(task.dependsOn)) {
    errors.push({ path: `tasks.${taskKey}.dependsOn`, message: "Required array" })
  }
  if (!Array.isArray(task.expectedFiles)) {
    errors.push({ path: `tasks.${taskKey}.expectedFiles`, message: "Required array" })
  }
  if (!Array.isArray(task.testCommands)) {
    errors.push({ path: `tasks.${taskKey}.testCommands`, message: "Required array" })
  }
  // v2: acceptanceCriteria
  if (!Array.isArray(task.acceptanceCriteria)) {
    errors.push({ path: `tasks.${taskKey}.acceptanceCriteria`, message: "Required array" })
  }
  // v2: verifyCommands
  if (!Array.isArray(task.verifyCommands)) {
    errors.push({ path: `tasks.${taskKey}.verifyCommands`, message: "Required array" })
  }
  // v2: tddPolicy
  if (!task.tddPolicy || typeof task.tddPolicy !== "object") {
    errors.push({ path: `tasks.${taskKey}.tddPolicy`, message: "Required object" })
  }
  // v2: tddEvidence
  if (!task.tddEvidence || typeof task.tddEvidence !== "object") {
    errors.push({ path: `tasks.${taskKey}.tddEvidence`, message: "Required object" })
  }
}

// ─── DAG Validator ───

export interface DagValidationError {
  path: string
  message: string
}

/**
 * 验证 Task DAG：
 * - Task ID 唯一
 * - record key 与 Task.id 一致
 * - 所有依赖存在
 * - 禁止自依赖
 * - 检测环路
 */
export function validateFlowRunDag(tasks: Record<string, TaskState>): DagValidationError[] {
  const errors: DagValidationError[] = []

  // Task ID 唯一（Record key 天然唯一，检查 key 与 id 是否一致）
  const seenIds = new Set<string>()
  for (const [key, task] of Object.entries(tasks)) {
    if (key !== task.id) {
      errors.push({ path: `tasks.${key}`, message: `Record key "${key}" does not match task.id "${task.id}"` })
    }
    if (seenIds.has(task.id)) {
      errors.push({ path: `tasks.${key}`, message: `Duplicate task id "${task.id}"` })
    }
    seenIds.add(task.id)
  }

  // 禁止自依赖 + 依赖存在
  for (const [key, task] of Object.entries(tasks)) {
    for (const dep of task.dependsOn) {
      if (dep === task.id) {
        errors.push({ path: `tasks.${key}.dependsOn`, message: `Task "${task.id}" depends on itself` })
      }
      if (!seenIds.has(dep)) {
        errors.push({ path: `tasks.${key}.dependsOn`, message: `Dependency "${dep}" not found in tasks` })
      }
    }
  }

  // 环路检测（拓扑排序）
  if (errors.length === 0) {
    const cycleError = detectCycle(tasks, seenIds)
    if (cycleError) {
      errors.push(cycleError)
    }
  }

  return errors
}

/**
 * 拓扑排序检测环路，返回发现环路时的错误
 */
function detectCycle(tasks: Record<string, TaskState>, allIds: Set<string>): DagValidationError | null {
  const inDegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()

  for (const id of allIds) {
    inDegree.set(id, 0)
    adjacency.set(id, [])
  }

  for (const task of Object.values(tasks)) {
    for (const dep of task.dependsOn) {
      adjacency.get(dep)!.push(task.id)
      inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1)
    }
  }

  const queue: string[] = []
  for (const [id, degree] of inDegree) {
    if (degree === 0) queue.push(id)
  }

  let visitedCount = 0
  while (queue.length > 0) {
    const current = queue.shift()!
    visitedCount++
    for (const neighbor of adjacency.get(current) ?? []) {
      const newDegree = (inDegree.get(neighbor) ?? 1) - 1
      inDegree.set(neighbor, newDegree)
      if (newDegree === 0) queue.push(neighbor)
    }
  }

  if (visitedCount !== allIds.size) {
    // 找出环路中的节点
    const cycleNodes = [...allIds].filter(id => (inDegree.get(id) ?? 0) > 0)
    return {
      path: "tasks",
      message: `Circular dependency detected involving: ${cycleNodes.join(", ")}`,
    }
  }

  return null
}

import {
  type FlowRun, type FlowStage, type TaskState, type StageState, type PRCheckpoints,
  FLOW_RUN_STAGES, FLOW_RUN_STATUSES, TASK_STATUSES, STAGE_STATUSES, CHECKPOINT_STATUSES,
  CURRENT_SCHEMA_VERSION,
} from "./types.js"

export interface ValidationError {
  path: string
  message: string
}

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

  if (!FLOW_RUN_STATUSES.includes(obj.status as any)) {
    errors.push({ path: "status", message: `Must be one of: ${FLOW_RUN_STATUSES.join(", ")}` })
  }

  if (typeof obj.schemaVersion !== "number") {
    errors.push({ path: "schemaVersion", message: "Required number" })
  }

  if (typeof obj.revision !== "number" || obj.revision < 0) {
    errors.push({ path: "revision", message: "Required non-negative number" })
  }

  const stageValidation = validateStages(obj.stages, errors)
  const taskValidation = validateTasks(obj.tasks, errors)

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
  if (!STAGE_STATUSES.includes(stage.status as any)) {
    errors.push({ path: `stages.${stageKey}.status`, message: `Invalid stage status` })
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
  if (!TASK_STATUSES.includes(task.status as any)) {
    errors.push({ path: `tasks.${taskKey}.status`, message: `Invalid task status` })
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
}

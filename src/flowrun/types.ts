export const FLOW_RUN_STAGES = ["requirements", "design", "tasks", "code", "test", "review", "merge"] as const
export type FlowStage = typeof FLOW_RUN_STAGES[number]

export const FLOW_RUN_STATUSES = ["planned", "running", "blocked", "merging", "completed", "cancelled"] as const
export type FlowRunStatus = typeof FLOW_RUN_STATUSES[number]

export const TASK_STATUSES = ["pending", "ready", "running", "blocked", "reviewing", "merged", "cancelled"] as const
export type TaskStatus = typeof TASK_STATUSES[number]

export const STAGE_STATUSES = ["pending", "running", "pass", "failed", "blocked"] as const
export type StageStatus = typeof STAGE_STATUSES[number]

export const CHECKPOINT_STATUSES = ["pending", "pass", "fail"] as const
export type CheckpointStatus = typeof CHECKPOINT_STATUSES[number]

export interface EvidenceEntry {
  command: string
  exitCode: number | null
  summary: string
  timestamp: string
}

export interface Checkpoint {
  name: string
  status: CheckpointStatus
  evidence: EvidenceEntry[]
}

export interface StageState {
  status: StageStatus
  requiredArtifacts: string[]
  checks: Checkpoint[]
  completedAt: string | null
  evidence: EvidenceEntry[]
}

export interface PRCheckpoints {
  prNumber: number
  localChecks: Checkpoint
  ciChecks: Checkpoint
  reviewerApproval: Checkpoint
  goalVerification: Checkpoint
  branchProtection: Checkpoint
  mergeResult: Checkpoint
}

export interface TaskState {
  id: string
  name: string
  status: TaskStatus
  dependsOn: string[]
  area: string
  expectedFiles: string[]
  testCommands: string[]
  acceptance: string
  prNumber: number | null
  prCheckpoints: PRCheckpoints | null
  blockedReason: string | null
  startedAt: string | null
}

export const CURRENT_SCHEMA_VERSION = 1
export const DEFAULT_MAX_RUNTIME_MS = 86_400_000

export interface FlowRun {
  flowRunId: string
  repo: string
  parentIssueNumber: number
  status: FlowRunStatus
  schemaVersion: number
  revision: number
  stages: Record<FlowStage, StageState>
  tasks: Record<string, TaskState>
  startedAt: string | null
  lastTickAt: string | null
  nextTickAfter: string | null
  maxRuntime: number
  completedAt: string | null
}

export const CABINET_START_MARKER = "<!-- cabbage-flow-run:start -->"
export const CABINET_END_MARKER = "<!-- cabbage-flow-run:end -->"

export const LABEL_PREFIX = "cabbage:"
export const FLOW_RUN_LABELS = {
  flow: `${LABEL_PREFIX}flow`,
  running: `${LABEL_PREFIX}running`,
  blocked: `${LABEL_PREFIX}blocked`,
  merging: `${LABEL_PREFIX}merging`,
  completed: `${LABEL_PREFIX}completed`,
  cancelled: `${LABEL_PREFIX}cancelled`,
  resume: `${LABEL_PREFIX}resume`,
} as const

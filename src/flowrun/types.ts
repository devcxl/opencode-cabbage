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

// ─── v1 兼容类型（保留） ───

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

// ─── Schema v2 新增类型 ───

export interface AcceptanceCriterion {
  id: string
  description: string
  verification: "tdd" | "regression" | "manual"
}

export type TddMode = "strict" | "relaxed" | "bypass"
export type TddEnforcement = "advisory" | "runtime"

export interface TddRunnerPolicy {
  adapter: "vitest"
  baseCommand: string
  timeoutMs: number
  executionInputPatterns: string[]
}

export interface VersionedDigest {
  algorithm: "sha256-content-v1" | "sha256-output-v1" | "git-tree-v1"
  value: string
}

export type TddApproval =
  | {
      kind: "planning-pr"
      repo: string
      prNumber: number
      reviewId: number
      approver: string
      mergedCommitSha: string
      policyDigest: string
    }
  | {
      kind: "issue-comment"
      repo: string
      issueNumber: number
      commentId: number
      approver: string
      commentBodyDigest: VersionedDigest
      policyDigest: string
    }
  | {
      kind: "legacy-migration"
      fromSchemaVersion: 1
    }

export interface TaskCommand {
  command: string
  cwd: string
  timeoutMs: number
  env: Record<string, string>
}

export type AlternativeValidation =
  | { validationId: string; kind: "command"; command: TaskCommand }
  | { validationId: string; kind: "manual"; description: string }

export interface TddException {
  reason: string
  alternativeValidation: AlternativeValidation[]
  approval: TddApproval
}

export interface TddPolicy {
  mode: TddMode
  enforcement: TddEnforcement
  runner: TddRunnerPolicy | null
  testFilePatterns: string[]
  implementationFilePatterns: string[]
  generatedArtifactPatterns: string[]
  exception: TddException | null
  source: {
    manifestPath: string
    revisionSha: string
  }
}

export type TddFailureKind =
  | "assertion"
  | "missing-behavior"
  | "infrastructure"
  | "timeout"
  | "unknown"

export interface TddCommandEvidence {
  command: string
  testSelector: string | null
  exitCode: number | null
  failureKind: TddFailureKind | null
  testsCollected: number | null
  testsFailed: number | null
  startedAt: string
  finishedAt: string
  durationMs: number
  changedFiles: string[]
  outputDigest: VersionedDigest
  workspaceDigest: VersionedDigest
  executionInputDigest: VersionedDigest
  summary: string
}

export interface TddTaskStartEvidence {
  status: "pending" | "pass" | "fail"
  headSha: string | null
  treeSha: string | null
  startedAt: string | null
}

export interface TaskExecutionBinding {
  branch: string
  baseSha: string
  startHeadSha: string
  worktreeId: string
  sessionId: string
}

export interface TddCycleEvidence {
  cycleId: string
  criterionId: string
  reworkRevision: number
  status: "started" | "red" | "pass" | "failed" | "abandoned"
  startWorkspaceDigest: VersionedDigest
  testFiles: string[]
  redTestDigest: VersionedDigest | null
  redAttempts: TddCommandEvidence[]
  greenAttempts: TddCommandEvidence[]
}

export interface TddRegressionEvidence {
  status: "pending" | "pass" | "fail" | "skipped"
  headSha: string | null
  treeSha: string | null
  reworkRevision: number
  runs: TddCommandEvidence[]
}

export interface FinalVerificationEvidence {
  status: "pending" | "pass" | "fail"
  headSha: string | null
  treeSha: string | null
  runs: TddCommandEvidence[]
}

export type AlternativeValidationEvidence =
  | {
      validationId: string
      kind: "command"
      status: "pass" | "fail"
      headSha: string
      treeSha: string
      reworkRevision: number
      evidence: TddCommandEvidence
    }
  | {
      validationId: string
      kind: "manual"
      status: "pass" | "fail"
      headSha: string
      treeSha: string
      reworkRevision: number
      reviewRef: string
      reviewer: string
      contentDigest: VersionedDigest
      policyDigest: string
      summary: string
    }

export interface ReworkApproval {
  reworkRevision: number
  kind: "refactor"
  headSha: string
  treeSha: string
  reviewerSessionId: string
  reviewerMessageId: string
  contentDigest: VersionedDigest
  policyDigest: string
}

export interface TddReworkEvidence {
  reworkRevision: number
  kind: "behavior" | "refactor"
  affectedCriterionIds: string[]
  status: "started" | "evidence-ready" | "pass" | "fail"
  startHeadSha: string
  approval: ReworkApproval | null
}

export interface TddEvidence {
  revision: number
  reworkRevision: number
  status:
    | "not-recorded"
    | "pending"
    | "in-progress"
    | "pass"
    | "fail"
    | "waived"
  taskStart: TddTaskStartEvidence
  cycles: TddCycleEvidence[]
  regression: TddRegressionEvidence
  verification: FinalVerificationEvidence
  alternativeValidation: AlternativeValidationEvidence[]
  reworks: TddReworkEvidence[]
  warnings: string[]
  updatedAt: string | null
}

export interface CoveragePolicy {
  command: string
  threshold: number
  report: {
    format: "istanbul-json-summary"
    path: string
    metric: "lines"
  }
}

export interface CoverageEvidence {
  status: "pending" | "pass" | "fail"
  headSha: string
  actual: number | null
  threshold: number
  metric: "lines"
  reportDigest: string | null
  summary: string
}

export interface TddComplianceCheckpoint {
  status: "pending" | "pass" | "fail" | "waived"
  evidenceRevision: number
  reworkRevision: number
  headSha: string
  treeSha: string
  summary: string
}

export interface PRCheckpoints {
  prNumber: number
  localChecks: Checkpoint
  ciChecks: Checkpoint
  reviewerApproval: Checkpoint
  goalVerification: Checkpoint
  branchProtection: Checkpoint
  mergeResult: Checkpoint
  // v2 新增
  tddCompliance: TddComplianceCheckpoint | null
  verification: FinalVerificationEvidence | null
  coverage: CoverageEvidence | null
  qualityContractDigest: string | null
}

export interface TaskState {
  // 保留的 v1 字段
  id: string
  name: string
  status: TaskStatus
  dependsOn: string[]
  area: string
  expectedFiles: string[]
  parallelSafe: boolean
  prNumber: number | null
  prCheckpoints: PRCheckpoints | null
  blockedReason: string | null
  startedAt: string | null

  // v2 替换字段（acceptance → acceptanceCriteria，testCommands 类型变更）
  acceptanceCriteria: AcceptanceCriterion[]
  testCommands: TaskCommand[]
  verifyCommands: TaskCommand[]

  // v2 新增字段
  executionBinding: TaskExecutionBinding | null
  tddPolicy: TddPolicy
  tddEvidence: TddEvidence
  coveragePolicy: CoveragePolicy | null
}

export interface RepositoryQualityPolicy {
  mode: "off" | "required"
  requiredChecks: Array<{
    context: string
    appId: number
    workflowPath: string
    workflowRef: string
    workflowBlobSha: string
  }>
}

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
  // v2 新增
  repositoryQualityPolicy: RepositoryQualityPolicy
}

export interface GoalFlowRunRef {
  repo: string
  parentIssueNumber: number
  flowRunId: string
}

// ─── flow_control 工具类型 ───

export type FlowControlOp =
  | "run-start"
  | "stage-start"
  | "stage-complete"
  | "task-start"

export interface FlowControlRequest {
  op: FlowControlOp
  parentIssueNumber: number

  // stage-start / stage-complete 用
  stage?: FlowStage

  // task-start 用
  taskId?: string
  executionBinding?: TaskExecutionBinding
  tddPolicy?: TddPolicy
}

export interface FlowControlResponse {
  ok: boolean
  error?: {
    code: string
    message: string
  }
  flowRunStatus?: FlowRunStatus
  stage?: {
    name: FlowStage
    status: StageStatus
  }
  task?: {
    taskId: string
    status: TaskStatus
    executionBinding?: TaskExecutionBinding | null
  }
}

export interface ValidationError {
  path: string
  message: string
}

export type FlowRunReadResult =
  | { ok: true; data: FlowRun; migrated: boolean }
  | {
      ok: false
      code: "NOT_FOUND" | "INVALID_JSON" | "UNSUPPORTED_SCHEMA" | "MIGRATION_FAILED" | "VALIDATION_FAILED"
      errors: ValidationError[]
    }

// ─── 常量 ───

export const CURRENT_SCHEMA_VERSION = 2
export const DEFAULT_MAX_RUNTIME_MS = 86_400_000

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

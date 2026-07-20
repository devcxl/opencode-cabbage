export {
  type FlowRun, type FlowRunStatus, type FlowStage, type TaskState, type TaskStatus,
  type StageState, type StageStatus, type Checkpoint, type CheckpointStatus,
  type EvidenceEntry, type PRCheckpoints,
  FLOW_RUN_STAGES, FLOW_RUN_STATUSES, TASK_STATUSES, STAGE_STATUSES, CHECKPOINT_STATUSES,
  CURRENT_SCHEMA_VERSION, DEFAULT_MAX_RUNTIME_MS,
  CABINET_START_MARKER, CABINET_END_MARKER, LABEL_PREFIX, FLOW_RUN_LABELS,
  // Schema v2 新增
  type AcceptanceCriterion, type TddMode, type TddEnforcement,
  type TddRunnerPolicy, type TddApproval, type AlternativeValidation,
  type TddException, type TddPolicy,
  type TddFailureKind, type TddCommandEvidence, type VersionedDigest,
  type TddTaskStartEvidence, type TaskExecutionBinding,
  type TddCycleEvidence, type TddRegressionEvidence,
  type FinalVerificationEvidence, type AlternativeValidationEvidence,
  type TddReworkEvidence, type ReworkApproval,
  type TddEvidence, type CoveragePolicy, type CoverageEvidence,
  type TddComplianceCheckpoint, type RepositoryQualityPolicy,
  type GoalFlowRunRef, type FlowRunReadResult, type TaskCommand,
  type ValidationError,
  type FlowControlRequest, type FlowControlResponse, type FlowControlOp,
} from "./types.js"

export {
  validateFlowRun, validateFlowRunDag,
  type DagValidationError,
} from "./validator.js"

export {
  migrateV1ToV2,
} from "./migration.js"

export {
  extractFlowRunFromBody, replaceFlowRunInBody,
  readFlowRun, writeFlowRun,
  readFlowRunWithLock, writeFlowRunWithLock,
  applyLabel, removeLabel, createInitialFlowRun,
} from "./github.js"

export {
  canStartStage, canCompleteStage, canStartTask, canCompleteTask,
  canMerge, allTasksComplete, getReadyTasks, determineNextStage,
  canCreatePR,
  type GateResult,
} from "./gate.js"

export {
  flowRunStart, flowStageStart, flowStageComplete, flowTaskStart,
  flowRunFinalize,
  type TransitionError, type TransitionResult,
} from "./transitions.js"

export {
  checkBranchProtection, validateCheckpoint, validatePRCheckpoints,
  canMergeTaskPR, mergePR, mergeTaskPR, createRevertPR, setMergeGhExecutor,
  type MergeGateResult,
} from "./merge.js"

export {
  checkRuntime, hasRuntimeExpired, getRuntimeMs,
  checkBackpressure, buildContinuationContext,
  type RuntimeCheckResult, type BackpressureStatus,
} from "./resilience.js"

export {
  postAuditComment, postPRComment,
  buildStageAudit, buildMergeAudit,
} from "./audit.js"

export {
  evaluateTddCompliance,
  type EvaluationResult,
} from "./evaluator.js"

export {
  computeWorkspaceDigest,
  type DigestOptions,
} from "./digest.js"

export {
  executeRedCheck,
  validateSelector,
  classifyVitestFailure,
  buildVitestArgs,
  type VitestOutput,
  type FailureInput,
} from "./adapter.js"

export {
  preflightPRCreate,
  createOrReusePR,
  setGhExecutor,
  initiateRework,
  completeRework,
  fetchRemotePRHead,
  revalidateRemoteHead,
  type CreatePRParams,
  type CreatePRResult,
  type PreflightResult,
  type ReworkInput,
  type ReworkResult,
  type CompleteReworkInput,
  type CompleteReworkResult,
  type RemotePRHead,
  type FetchRemoteHeadResult,
  type RevalidateResult,
} from "./pr.js"

export {
  validateCoveragePath,
  resolveCoveragePath,
  parseCoverageReport,
  buildCoverageEvidence,
  checkCoverageThreshold,
  computeReportDigest,
  verifySymlinkSafe,
  type ParsedCoverageData,
  type BuildCoverageEvidenceInput,
} from "./coverage.js"

export {
  checkRequiredChecks,
  validateRequiredWorkflow,
  computeQualityContractDigest,
  type PRCheckResult,
  type CICheckResult,
  type RequiredWorkflowValidation,
} from "./ci.js"

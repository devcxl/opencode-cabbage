/** Flow Record 引用：GitHub Parent Issue 承载 Flow 生命周期与阶段状态 */
export interface FlowRecordRef {
  parentIssueNumber: number
  slug: string
}

/** Task Record 引用：GitHub Sub Issue 承载 Task 生命周期与 TDD 证据 */
export interface TaskRecordRef {
  parentIssueNumber: number
  taskId: string
  issueNumber: number
}

// ─── TDD 证据模型（自 flowrun/types.ts 迁入，结构保持与源一致） ───

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

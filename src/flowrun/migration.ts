import type {
  FlowRun, TaskState, FlowRunReadResult, AcceptanceCriterion, TddPolicy,
  TddEvidence, TaskCommand, TddTaskStartEvidence, TddRegressionEvidence,
  FinalVerificationEvidence, TddReworkEvidence, AlternativeValidationEvidence,
  StageState, Checkpoint, EvidenceEntry,
} from "./types.js"
import { CURRENT_SCHEMA_VERSION } from "./types.js"

type V1FlowRun = Record<string, unknown>
type V1Task = Record<string, unknown>

/**
 * v1→v2 幂等迁移器
 *
 * 纯函数：输入 v1 FlowRun (unknown)，输出 FlowRunReadResult。
 * - 如果输入已经是 v2 格式 → 直接返回（幂等）
 * - 如果 schemaVersion > 2 → 返回 UNSUPPORTED_SCHEMA
 * - 如果 schemaVersion 缺失/非整数/< 1 → 返回 VALIDATION_FAILED
 * - 如果 schemaVersion === 1 → 执行迁移
 */
export function migrateV1ToV2(flowRun: unknown): FlowRunReadResult {
  if (!flowRun || typeof flowRun !== "object") {
    return { ok: false, code: "INVALID_JSON", errors: [{ path: "", message: "FlowRun must be a non-null object" }] }
  }

  const obj = flowRun as Record<string, unknown>

  const version = obj.schemaVersion
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    return {
      ok: false,
      code: "VALIDATION_FAILED",
      errors: [{ path: "schemaVersion", message: `Must be a positive integer, got: ${version}` }],
    }
  }

  if (version > CURRENT_SCHEMA_VERSION) {
    return {
      ok: false,
      code: "UNSUPPORTED_SCHEMA",
      errors: [{ path: "schemaVersion", message: `Schema version ${version} is not supported (current: ${CURRENT_SCHEMA_VERSION})` }],
    }
  }

  // 已经是 v2，直接返回
  if (version === CURRENT_SCHEMA_VERSION) {
    return { ok: true, data: obj as unknown as FlowRun, migrated: false }
  }

  // v1 → v2 迁移
  try {
    const migrated = doMigrateV1ToV2(obj)
    return { ok: true, data: migrated, migrated: true }
  } catch (err) {
    return {
      ok: false,
      code: "MIGRATION_FAILED",
      errors: [{ path: "", message: `Migration failed: ${String(err)}` }],
    }
  }
}

function doMigrateV1ToV2(v1: V1FlowRun): FlowRun {
  const tasks: Record<string, TaskState> = {}

  if (v1.tasks && typeof v1.tasks === "object") {
    const v1Tasks = v1.tasks as Record<string, V1Task>
    for (const [key, v1Task] of Object.entries(v1Tasks)) {
      tasks[key] = migrateTaskV1ToV2(v1Task as V1Task, key)
    }
  }

  // v1 PR checkpoints 有旧的 PR 字段，需要补充 v2 的新字段
  // 这些在 migrateTaskV1ToV2 中处理

  return {
    flowRunId: String(v1.flowRunId ?? ""),
    repo: String(v1.repo ?? ""),
    parentIssueNumber: Number(v1.parentIssueNumber ?? 0),
    status: String(v1.status ?? "planned") as FlowRun["status"],
    schemaVersion: CURRENT_SCHEMA_VERSION,
    revision: Number(v1.revision ?? 0),
    stages: migrateStages(v1.stages),
    tasks,
    startedAt: typeof v1.startedAt === "string" ? v1.startedAt : null,
    lastTickAt: typeof v1.lastTickAt === "string" ? v1.lastTickAt : null,
    nextTickAfter: typeof v1.nextTickAfter === "string" ? v1.nextTickAfter : null,
    maxRuntime: Number(v1.maxRuntime ?? 86_400_000),
    completedAt: typeof v1.completedAt === "string" ? v1.completedAt : null,
    repositoryQualityPolicy: { mode: "off", requiredChecks: [] },
  } as FlowRun
}

function migrateStages(stages: unknown): FlowRun["stages"] {
  function defaultStage(): StageState {
    return {
      status: "pending",
      requiredArtifacts: [],
      checks: [],
      completedAt: null,
      evidence: [],
    }
  }

  if (!stages || typeof stages !== "object") {
    return {
      requirements: defaultStage(),
      design: defaultStage(),
      tasks: defaultStage(),
      code: defaultStage(),
      test: defaultStage(),
      review: defaultStage(),
      merge: defaultStage(),
    }
  }

  const s = stages as Record<string, unknown>
  const stageKeys = ["requirements", "design", "tasks", "code", "test", "review", "merge"]

  const result: Record<string, StageState> = {}
  for (const key of stageKeys) {
    const val = s[key]
    if (val && typeof val === "object") {
      const v = val as Record<string, unknown>
      result[key] = {
        status: (typeof v.status === "string" && ["pending", "running", "pass", "failed", "blocked"].includes(v.status))
          ? v.status as StageState["status"]
          : "pending",
        requiredArtifacts: Array.isArray(v.requiredArtifacts) ? v.requiredArtifacts as string[] : [],
        checks: Array.isArray(v.checks) ? v.checks as Checkpoint[] : [],
        completedAt: typeof v.completedAt === "string" ? v.completedAt : null,
        evidence: Array.isArray(v.evidence) ? v.evidence as EvidenceEntry[] : [],
      }
    } else {
      result[key] = defaultStage()
    }
  }

  return result as FlowRun["stages"]
}

/**
 * 将单个 v1 Task 迁移为 v2 TaskState
 */
function migrateTaskV1ToV2(v1Task: V1Task, recordKey: string): TaskState {
  const hasTestCommands = Array.isArray(v1Task.testCommands) && v1Task.testCommands.length > 0

  // 迁移 testCommands: string[] → TaskCommand[]
  const testCommands: TaskCommand[] = hasTestCommands
    ? (v1Task.testCommands as string[]).map(cmd => ({
        command: cmd,
        cwd: ".",
        timeoutMs: 120_000,
        env: {},
      }))
    : []

  // 迁移 acceptance → acceptanceCriteria
  const v1Acceptance = typeof v1Task.acceptance === "string" ? v1Task.acceptance : ""
  const acceptanceCriteria: AcceptanceCriterion[] = [
    {
      id: "legacy-1",
      description: v1Acceptance || "历史任务验收条件（v1 迁移）",
      verification: hasTestCommands ? "regression" : "manual",
    },
  ]

  // 构造 TDD policy（按 spec 10.2）
  const tddPolicy: TddPolicy = {
    mode: hasTestCommands ? "relaxed" : "bypass",
    enforcement: "advisory",
    runner: null,
    testFilePatterns: [],
    implementationFilePatterns: [],
    generatedArtifactPatterns: [],
    exception: {
      reason: "legacy schema v1 migration",
      alternativeValidation: hasTestCommands
        ? testCommands.map((cmd, i) => ({
            validationId: `legacy-alt-${i + 1}`,
            kind: "command" as const,
            command: cmd,
          }))
        : [{
            validationId: "legacy-alt-1",
            kind: "manual" as const,
            description: "历史任务未记录自动验证",
          }],
      approval: {
        kind: "legacy-migration",
        fromSchemaVersion: 1,
      },
    },
    source: {
      manifestPath: "legacy:v1",
      revisionSha: "migration:v1",
    },
  }

  // 构造 TDD evidence（完整默认对象）
  const tddEvidence: TddEvidence = {
    revision: 0,
    reworkRevision: 0,
    status: "not-recorded",
    taskStart: makeDefaultTaskStart(),
    cycles: [],
    regression: makeDefaultRegression(),
    verification: makeDefaultVerification(),
    alternativeValidation: [] as AlternativeValidationEvidence[],
    reworks: [] as TddReworkEvidence[],
    warnings: ["legacy schema v1 migration: evidence not recorded"],
    updatedAt: null,
  }

  // 迁移 PR checkpoints（保留旧字段 + 新增 null）
  const v1PR = v1Task.prCheckpoints
  const prCheckpoints = v1PR && typeof v1PR === "object"
    ? migratePRCheckpoints(v1PR as Record<string, unknown>)
    : null

  return {
    id: String(v1Task.id ?? recordKey),
    name: String(v1Task.name ?? recordKey),
    status: (typeof v1Task.status === "string" ? v1Task.status : "pending") as TaskState["status"],
    dependsOn: Array.isArray(v1Task.dependsOn) ? v1Task.dependsOn as string[] : [],
    area: String(v1Task.area ?? ""),
    expectedFiles: Array.isArray(v1Task.expectedFiles) ? v1Task.expectedFiles as string[] : [],
    parallelSafe: Boolean(v1Task.parallelSafe ?? false),
    prNumber: typeof v1Task.prNumber === "number" ? v1Task.prNumber : null,
    prCheckpoints,
    blockedReason: typeof v1Task.blockedReason === "string" ? v1Task.blockedReason : null,
    startedAt: typeof v1Task.startedAt === "string" ? v1Task.startedAt : null,
    // v2 新字段
    acceptanceCriteria,
    testCommands,
    verifyCommands: [],
    executionBinding: null,
    tddPolicy,
    tddEvidence,
    coveragePolicy: null,
  }
}

function migratePRCheckpoints(v1PR: Record<string, unknown>) {
  function makeCheckpoint(name: string): Checkpoint {
    return {
      name,
      status: "pending",
      evidence: [],
    }
  }

  const getCheckpoint = (key: string): Checkpoint => {
    const cp = v1PR[key]
    if (cp && typeof cp === "object") {
      const c = cp as Record<string, unknown>
      return {
        name: String(c.name ?? key),
        status: (typeof c.status === "string" && ["pending", "pass", "fail"].includes(c.status))
          ? c.status as Checkpoint["status"]
          : "pending",
        evidence: Array.isArray(c.evidence) ? c.evidence as EvidenceEntry[] : [],
      }
    }
    return makeCheckpoint(key)
  }

  return {
    prNumber: Number(v1PR.prNumber ?? 0),
    localChecks: getCheckpoint("localChecks"),
    ciChecks: getCheckpoint("ciChecks"),
    reviewerApproval: getCheckpoint("reviewerApproval"),
    goalVerification: getCheckpoint("goalVerification"),
    branchProtection: getCheckpoint("branchProtection"),
    mergeResult: getCheckpoint("mergeResult"),
    // v2 新增
    tddCompliance: null,
    verification: null,
    coverage: null,
    qualityContractDigest: null,
  }
}

function makeDefaultTaskStart(): TddTaskStartEvidence {
  return {
    status: "pending",
    headSha: null,
    treeSha: null,
    startedAt: null,
  }
}

function makeDefaultRegression(): TddRegressionEvidence {
  return {
    status: "pending",
    headSha: null,
    treeSha: null,
    reworkRevision: 0,
    runs: [],
  }
}

function makeDefaultVerification(): FinalVerificationEvidence {
  return {
    status: "pending",
    headSha: null,
    treeSha: null,
    runs: [],
  }
}

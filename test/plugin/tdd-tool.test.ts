import { describe, it, expect } from "vitest"
import type {
  TddEvidence,
  TddCycleEvidence,
  TddCommandEvidence,
  TddPolicy,
  TaskState,
  AcceptanceCriterion,
  VersionedDigest,
  TaskExecutionBinding,
} from "../../src/flowrun/types.js"
import type { TddCheckpointRequest, TddCheckpointResponse } from "../../src/plugin/tdd-tool.js"
import { handleTddCheckpoint, createTaskEvidence } from "../../src/plugin/tdd-tool.js"

// ─── 辅助工厂 ───

function emptyDigest(): VersionedDigest {
  return { algorithm: "sha256-content-v1", value: "a".repeat(64) }
}

function makeBinding(overrides: Partial<TaskExecutionBinding> = {}): TaskExecutionBinding {
  return {
    branch: "feat/test-task",
    baseSha: "baseSha1",
    startHeadSha: "startHead1",
    worktreeId: "worktree-1",
    sessionId: "session-1",
    ...overrides,
  }
}

function makePolicy(overrides: Partial<TddPolicy> = {}): TddPolicy {
  return {
    mode: "strict",
    enforcement: "runtime",
    runner: {
      adapter: "vitest",
      baseCommand: "npx vitest run",
      timeoutMs: 30000,
      executionInputPatterns: ["package.json", "vitest.config.ts"],
    },
    testFilePatterns: ["test/**/*.test.ts"],
    implementationFilePatterns: ["src/**/*.ts"],
    generatedArtifactPatterns: [],
    exception: null,
    source: { manifestPath: "test.yml", revisionSha: "sha1" },
    ...overrides,
  }
}

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: "task-1",
    name: "Test Task",
    status: "running",
    dependsOn: [],
    area: "backend",
    expectedFiles: [],
    parallelSafe: false,
    prNumber: null,
    prCheckpoints: null,
    blockedReason: null,
    startedAt: "2026-01-01T00:00:00Z",
    acceptanceCriteria: [{ id: "AC-1", description: "TDD test", verification: "tdd" }],
    testCommands: [{ command: "npm test", cwd: ".", timeoutMs: 30000, env: {} }],
    verifyCommands: [{ command: "npm run typecheck", cwd: ".", timeoutMs: 30000, env: {} }],
    executionBinding: makeBinding(),
    tddPolicy: makePolicy(),
    tddEvidence: createTaskEvidence(),
    coveragePolicy: null,
    ...overrides,
  }
}

function makeCommandEvidence(overrides: Partial<TddCommandEvidence> = {}): TddCommandEvidence {
  return {
    command: "npx vitest run test/foo.test.ts",
    testSelector: "test/foo.test.ts",
    exitCode: 1,
    failureKind: "assertion",
    testsCollected: 3,
    testsFailed: 1,
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:01Z",
    durationMs: 1000,
    changedFiles: ["test/foo.test.ts"],
    outputDigest: { algorithm: "sha256-output-v1", value: "a".repeat(64) },
    workspaceDigest: emptyDigest(),
    executionInputDigest: emptyDigest(),
    summary: "1/3 tests failed",
    ...overrides,
  }
}

function passingEvidence(): TddCommandEvidence {
  return makeCommandEvidence({ exitCode: 0, failureKind: null, testsFailed: 0, summary: "3/3 tests passed" })
}

// ─── 基础验证 ───

describe("handleTddCheckpoint — validation", () => {
  it("rejects when task is not running", () => {
    const task = makeTask({ status: "pending" })
    const req: TddCheckpointRequest = { op: "status", parentIssueNumber: 1, taskId: "task-1" }

    const resp = handleTddCheckpoint(req, task)
    expect(resp.ok).toBe(false)
    expect(resp.error).toBeDefined()
    expect(resp.error!.code).toBe("TASK_NOT_RUNNING")
  })

  it("rejects when task has no executionBinding", () => {
    const task = makeTask({ executionBinding: null })
    const req: TddCheckpointRequest = { op: "status", parentIssueNumber: 1, taskId: "task-1" }

    const resp = handleTddCheckpoint(req, task)
    expect(resp.ok).toBe(false)
    expect(resp.error!.code).toBe("TASK_NOT_FOUND")
  })

  it("rejects unknown op", () => {
    const task = makeTask()
    const req = { op: "unknown-op" } as unknown as TddCheckpointRequest

    const resp = handleTddCheckpoint(req, task)
    expect(resp.ok).toBe(false)
    expect(resp.error!.code).toBe("POLICY_INVALID")
  })
})

// ─── status op ───

describe("handleTddCheckpoint — status", () => {
  it("returns current evidence revision and status", () => {
    const task = makeTask()
    const req: TddCheckpointRequest = { op: "status", parentIssueNumber: 1, taskId: "task-1" }

    const resp = handleTddCheckpoint(req, task)
    expect(resp.ok).toBe(true)
    expect(resp.evidenceRevision).toBe(0)
    expect(resp.evidence).toBeDefined()
    expect(resp.evidence!.status).toBe("not-recorded")
  })
})

// ─── cycle-start op ───

describe("handleTddCheckpoint — cycle-start", () => {
  it("creates a new cycle", () => {
    const task = makeTask()
    const req: TddCheckpointRequest = {
      op: "cycle-start",
      parentIssueNumber: 1,
      taskId: "task-1",
      cycleId: "cycle-1",
      criterionId: "AC-1",
      testPaths: ["test/foo.test.ts"],
      testSelector: "test/foo.test.ts",
    }

    const resp = handleTddCheckpoint(req, task)
    expect(resp.ok).toBe(true)
    expect(resp.cycle).toBeDefined()
    expect(resp.cycle!.cycleId).toBe("cycle-1")
    expect(resp.cycle!.status).toBe("started")
    expect(resp.evidenceRevision).toBeGreaterThan(0)
  })

  it("rejects for non-existent criterion", () => {
    const task = makeTask()
    const req: TddCheckpointRequest = {
      op: "cycle-start",
      parentIssueNumber: 1,
      taskId: "task-1",
      cycleId: "cycle-1",
      criterionId: "NONEXISTENT",
      testPaths: ["test/foo.test.ts"],
      testSelector: "test/foo.test.ts",
    }

    const resp = handleTddCheckpoint(req, task)
    expect(resp.ok).toBe(false)
    expect(resp.error!.code).toBe("CRITERION_NOT_FOUND")
  })

  it("rejects test paths not matching patterns", () => {
    const task = makeTask()
    const req: TddCheckpointRequest = {
      op: "cycle-start",
      parentIssueNumber: 1,
      taskId: "task-1",
      cycleId: "cycle-1",
      criterionId: "AC-1",
      testPaths: ["src/foo.ts"],
      testSelector: "src/foo.ts",
    }

    const resp = handleTddCheckpoint(req, task)
    expect(resp.ok).toBe(false)
    expect(resp.error!.code).toBe("POLICY_INVALID")
  })
})

// ─── red op ───

describe("handleTddCheckpoint — red", () => {
  function setupCycle(task?: TaskState): TaskState {
    const t = task ?? makeTask()
    const req: TddCheckpointRequest = {
      op: "cycle-start",
      parentIssueNumber: 1,
      taskId: "task-1",
      cycleId: "cycle-1",
      criterionId: "AC-1",
      testPaths: ["test/foo.test.ts"],
      testSelector: "test/foo.test.ts",
    }
    const resp = handleTddCheckpoint(req, t)
    if (!resp.ok) throw new Error(`cycle-start failed: ${resp.error?.message}`)
    // Update task with new evidence
    return { ...t, tddEvidence: resp.evidence! }
  }

  it("rejects when task has no runner policy", () => {
    // 先创建 cycle（不需要 runner）
    const task = setupCycle()
    // 然后去掉 runner 测试 RED
    const taskNoRunner = {
      ...task,
      tddPolicy: makePolicy({ runner: null }),
    }
    const req: TddCheckpointRequest = {
      op: "red",
      parentIssueNumber: 1,
      taskId: "task-1",
      cycleId: "cycle-1",
    }

    const resp = handleTddCheckpoint(req, taskNoRunner)
    expect(resp.ok).toBe(false)
    expect(resp.error!.code).toBe("RUNNER_UNSUPPORTED")
  })

  it("records RED when valid failure evidence provided", () => {
    const task = setupCycle()
    const req: TddCheckpointRequest = {
      op: "red",
      parentIssueNumber: 1,
      taskId: "task-1",
      cycleId: "cycle-1",
      // In production, evidence comes from executing vitest
      // Here we simulate by passing it inline for testing
      redEvidence: makeCommandEvidence({ failureKind: "assertion" }),
    }

    const resp = handleTddCheckpoint(req, task)
    expect(resp.ok).toBe(true)
    expect(resp.cycle!.status).toBe("red")
    expect(resp.cycle!.redAttempts).toHaveLength(1)
  })

  it("rejects when RED passes (exitCode 0)", () => {
    const task = setupCycle()
    const req: TddCheckpointRequest = {
      op: "red",
      parentIssueNumber: 1,
      taskId: "task-1",
      cycleId: "cycle-1",
      redEvidence: makeCommandEvidence({ exitCode: 0, failureKind: null }),
    }

    const resp = handleTddCheckpoint(req, task)
    expect(resp.ok).toBe(false)
    expect(resp.error!.code).toBe("RED_EXPECTED_FAILURE")
  })

  it("rejects infrastructure failure as RED", () => {
    const task = setupCycle()
    const req: TddCheckpointRequest = {
      op: "red",
      parentIssueNumber: 1,
      taskId: "task-1",
      cycleId: "cycle-1",
      redEvidence: makeCommandEvidence({ failureKind: "infrastructure" }),
    }

    const resp = handleTddCheckpoint(req, task)
    expect(resp.ok).toBe(false)
    expect(resp.error!.code).toBe("RED_INFRASTRUCTURE_FAILURE")
  })
})

// ─── green op ───

describe("handleTddCheckpoint — green", () => {
  function setupWithRed(task?: TaskState): TaskState {
    const t = task ?? makeTask()
    // cycle-start
    let r = handleTddCheckpoint(
      { op: "cycle-start", parentIssueNumber: 1, taskId: "task-1", cycleId: "cycle-1", criterionId: "AC-1", testPaths: ["test/foo.test.ts"], testSelector: "test/foo.test.ts" },
      t,
    )
    if (!r.ok) throw new Error(`cycle-start failed: ${r.error?.message}`)
    t.tddEvidence = r.evidence!

    // record red
    r = handleTddCheckpoint(
      { op: "red", parentIssueNumber: 1, taskId: "task-1", cycleId: "cycle-1", redEvidence: makeCommandEvidence() },
      t,
    )
    if (!r.ok) throw new Error(`red failed: ${r.error?.message}`)
    t.tddEvidence = r.evidence!
    return t
  }

  it("rejects when task has no runner policy", () => {
    // 用有 runner 的 task 先记录 RED
    const task = setupWithRed(makeTask())

    // 然后去掉 runner 来测试 GREEN
    const taskNoRunner = {
      ...task,
      tddPolicy: makePolicy({ runner: null }),
    }

    const req: TddCheckpointRequest = {
      op: "green",
      parentIssueNumber: 1,
      taskId: "task-1",
      cycleId: "cycle-1",
    }

    const resp = handleTddCheckpoint(req, taskNoRunner)
    expect(resp.ok).toBe(false)
    expect(resp.error!.code).toBe("RUNNER_UNSUPPORTED")
  })

  it("records GREEN when tests pass and implementation changed", () => {
    const task = setupWithRed()
    const greenEvidence = passingEvidence()
    greenEvidence.changedFiles = ["src/foo.ts"]

    const req: TddCheckpointRequest = {
      op: "green",
      parentIssueNumber: 1,
      taskId: "task-1",
      cycleId: "cycle-1",
      greenEvidence,
    }

    const resp = handleTddCheckpoint(req, task)
    expect(resp.ok).toBe(true)
    expect(resp.cycle!.status).toBe("pass")
    expect(resp.cycle!.greenAttempts).toHaveLength(1)
  })

  it("rejects when GREEN test still fails", () => {
    const task = setupWithRed()
    const greenEvidence = makeCommandEvidence({ exitCode: 1, failureKind: "assertion" })

    const req: TddCheckpointRequest = {
      op: "green",
      parentIssueNumber: 1,
      taskId: "task-1",
      cycleId: "cycle-1",
      greenEvidence,
    }

    const resp = handleTddCheckpoint(req, task)
    expect(resp.ok).toBe(false)
    expect(resp.error!.code).toBe("GREEN_EXPECTED_PASS")
  })

  it("rejects when no implementation files changed", () => {
    const task = setupWithRed()
    const greenEvidence = passingEvidence()
    greenEvidence.changedFiles = ["README.md"] // not matching implementationFilePatterns

    const req: TddCheckpointRequest = {
      op: "green",
      parentIssueNumber: 1,
      taskId: "task-1",
      cycleId: "cycle-1",
      greenEvidence,
    }

    const resp = handleTddCheckpoint(req, task)
    expect(resp.ok).toBe(false)
    expect(resp.error!.code).toBe("IMPLEMENTATION_CHANGE_REQUIRED")
  })
})

// ─── final-regression op ───

describe("handleTddCheckpoint — final-regression", () => {
  it("rejects when no test commands configured", () => {
    const task = makeTask({ testCommands: [] })
    const req: TddCheckpointRequest = { op: "final-regression", parentIssueNumber: 1, taskId: "task-1" }

    const resp = handleTddCheckpoint(req, task)
    expect(resp.ok).toBe(false)
    expect(resp.error!.code).toBe("REGRESSION_FAILED")
  })

  it("records regression runs (via inline evidence for testing)", () => {
    const task = makeTask()
    const req: TddCheckpointRequest = {
      op: "final-regression",
      parentIssueNumber: 1,
      taskId: "task-1",
      regressionRuns: [
        makeCommandEvidence({ exitCode: 0, failureKind: null, testsFailed: 0 }),
      ],
    }

    const resp = handleTddCheckpoint(req, task)
    expect(resp.ok).toBe(true)
    expect(resp.evidence!.regression.status).toBe("pass")
    expect(resp.evidenceRevision).toBeGreaterThan(0)
  })

  it("records regression as fail when a run fails", () => {
    const task = makeTask()
    const req: TddCheckpointRequest = {
      op: "final-regression",
      parentIssueNumber: 1,
      taskId: "task-1",
      regressionRuns: [
        makeCommandEvidence({ exitCode: 1, failureKind: "assertion", testsFailed: 1 }),
      ],
    }

    const resp = handleTddCheckpoint(req, task)
    expect(resp.ok).toBe(true)
    expect(resp.evidence!.regression.status).toBe("fail")
  })
})

// ─── final-verification op ───

describe("handleTddCheckpoint — final-verification", () => {
  it("records verification as pass when runs succeed", () => {
    const task = makeTask()
    const req: TddCheckpointRequest = {
      op: "final-verification",
      parentIssueNumber: 1,
      taskId: "task-1",
      verificationRuns: [
        makeCommandEvidence({ exitCode: 0, failureKind: null, testsFailed: 0 }),
      ],
    }

    const resp = handleTddCheckpoint(req, task)
    expect(resp.ok).toBe(true)
    expect(resp.evidence!.verification.status).toBe("pass")
  })

  it("records verification as fail when a run fails", () => {
    const task = makeTask()
    const req: TddCheckpointRequest = {
      op: "final-verification",
      parentIssueNumber: 1,
      taskId: "task-1",
      verificationRuns: [
        makeCommandEvidence({ exitCode: 1, failureKind: "unknown" }),
      ],
    }

    const resp = handleTddCheckpoint(req, task)
    expect(resp.ok).toBe(true)
    expect(resp.evidence!.verification.status).toBe("fail")
  })

  it("allows empty verification when no verifyCommands", () => {
    const task = makeTask({ verifyCommands: [] })
    const req: TddCheckpointRequest = {
      op: "final-verification",
      parentIssueNumber: 1,
      taskId: "task-1",
    }

    const resp = handleTddCheckpoint(req, task)
    expect(resp.ok).toBe(true)
    expect(resp.evidence!.verification.status).toBe("pass")
  })
})

// ─── abandon-cycle op ───

describe("handleTddCheckpoint — abandon-cycle", () => {
  it("abandons a started cycle", () => {
    const task = makeTask()
    // cycle-start first
    let resp = handleTddCheckpoint(
      { op: "cycle-start", parentIssueNumber: 1, taskId: "task-1", cycleId: "cycle-1", criterionId: "AC-1", testPaths: ["test/foo.test.ts"], testSelector: "test/foo.test.ts" },
      task,
    )
    expect(resp.ok).toBe(true)
    task.tddEvidence = resp.evidence!

    // abandon
    resp = handleTddCheckpoint(
      { op: "abandon-cycle", parentIssueNumber: 1, taskId: "task-1", cycleId: "cycle-1", reason: "wrong test design" },
      task,
    )
    expect(resp.ok).toBe(true)
    expect(resp.evidence!.cycles[0].status).toBe("abandoned")
    expect(resp.evidence!.warnings).toContain("wrong test design")
  })

  it("rejects abandoning a non-existent cycle", () => {
    const task = makeTask()
    const resp = handleTddCheckpoint(
      { op: "abandon-cycle", parentIssueNumber: 1, taskId: "task-1", cycleId: "nonexistent", reason: "oops" },
      task,
    )

    expect(resp.ok).toBe(false)
    expect(resp.error!.code).toBe("CYCLE_CONFLICT")
  })
})

// ─── idempotency ───

describe("handleTddCheckpoint — idempotency", () => {
  it("same cycle-start with same workspace digest returns same evidence revision", () => {
    const task = makeTask()
    const req: TddCheckpointRequest = {
      op: "cycle-start",
      parentIssueNumber: 1, taskId: "task-1", cycleId: "cycle-1",
      criterionId: "AC-1", testPaths: ["test/foo.test.ts"], testSelector: "test/foo.test.ts",
    }

    const r1 = handleTddCheckpoint(req, task)
    expect(r1.ok).toBe(true)
    const rev1 = r1.evidenceRevision

    // Update task with new evidence for idempotency check
    const taskAfter = { ...task, tddEvidence: r1.evidence! }
    const r2 = handleTddCheckpoint(req, taskAfter)
    expect(r2.ok).toBe(true)
    // Should be idempotent (same evidence, same revision)
    expect(r2.evidenceRevision).toBe(rev1)
  })
})

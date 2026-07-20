import { describe, it, expect, beforeAll } from "vitest"
import {
  validateCheckpoint, validatePRCheckpoints,
} from "../../src/flowrun/merge.js"
import { createInitialFlowRun } from "../../src/flowrun/github.js"
import type {
  PRCheckpoints, TaskState, Checkpoint,
  TddComplianceCheckpoint, FlowRun, TaskCommand,
} from "../../src/flowrun/types.js"

function passCP(name: string): Checkpoint {
  return { name, status: "pass", evidence: [{ command: "test", exitCode: 0, summary: "ok", timestamp: "now" }] }
}

function failCP(name: string): Checkpoint {
  return { name, status: "fail", evidence: [{ command: "test", exitCode: 1, summary: "failed", timestamp: "now" }] }
}

function pendingCP(name: string): Checkpoint {
  return { name, status: "pending", evidence: [] }
}

function tddPass(): TddComplianceCheckpoint {
  return {
    status: "pass",
    evidenceRevision: 1,
    reworkRevision: 0,
    headSha: "abc123",
    treeSha: "tree456",
    summary: "TDD compliance verified",
  }
}

function tddFail(): TddComplianceCheckpoint {
  return {
    status: "fail",
    evidenceRevision: 1,
    reworkRevision: 0,
    headSha: "abc123",
    treeSha: "tree456",
    summary: "TDD compliance failed",
  }
}

function noopCmd(): TaskCommand {
  return { command: "echo ok", cwd: ".", timeoutMs: 30000, env: {} }
}

function fullCheckpoints(overrides: Partial<PRCheckpoints> = {}): PRCheckpoints {
  const base: PRCheckpoints = {
    prNumber: 1,
    localChecks: passCP("localChecks"),
    ciChecks: passCP("ciChecks"),
    reviewerApproval: passCP("reviewerApproval"),
    goalVerification: passCP("goalVerification"),
    branchProtection: passCP("branchProtection"),
    mergeResult: pendingCP("mergeResult"),
    tddCompliance: tddPass(),
    verification: null,
    coverage: null,
    qualityContractDigest: null,
  }
  return { ...base, ...overrides }
}

function makeTask(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: "task-1",
    name: "Task 1",
    status: "reviewing",
    dependsOn: [],
    area: "backend",
    expectedFiles: ["src/a.ts"],
    testCommands: [noopCmd()],
    verifyCommands: [],
    acceptanceCriteria: [],
    parallelSafe: true,
    prNumber: 1,
    prCheckpoints: fullCheckpoints(),
    blockedReason: null,
    startedAt: "now",
    executionBinding: null,
    tddPolicy: {
      mode: "strict",
      enforcement: "advisory",
      runner: null,
      testFilePatterns: [],
      implementationFilePatterns: [],
      generatedArtifactPatterns: [],
      exception: null,
      source: { manifestPath: ".tdd.json", revisionSha: "abc" },
    },
    tddEvidence: {
      revision: 1,
      reworkRevision: 0,
      status: "pass",
      taskStart: { status: "pass", headSha: "abc", treeSha: "tree", startedAt: "now" },
      cycles: [],
      regression: { status: "pass", headSha: "abc", treeSha: "tree", reworkRevision: 0, runs: [] },
      verification: { status: "pass", headSha: "abc", treeSha: "tree", runs: [] },
      alternativeValidation: [],
      reworks: [],
      warnings: [],
      updatedAt: "now",
    },
    coveragePolicy: null,
    ...overrides,
  }
}

describe("validateCheckpoint", () => {
  it("returns pass for pass status", () => {
    expect(validateCheckpoint(passCP("x"))).toBe("pass")
  })

  it("returns fail for fail status", () => {
    expect(validateCheckpoint(failCP("x"))).toBe("fail")
  })

  it("returns pending for pending status", () => {
    expect(validateCheckpoint(pendingCP("x"))).toBe("pending")
  })
})

describe("validatePRCheckpoints", () => {
  it("allows merge when all gates pass", () => {
    const result = validatePRCheckpoints(fullCheckpoints())
    expect(result.allowed).toBe(true)
  })

  it("blocks when local checks fail", () => {
    const result = validatePRCheckpoints(fullCheckpoints({ localChecks: failCP("localChecks") }))
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("localChecks")
  })

  it("blocks when CI checks fail", () => {
    const result = validatePRCheckpoints(fullCheckpoints({ ciChecks: failCP("ciChecks") }))
    expect(result.allowed).toBe(false)
    expect(result.checkpointResults.ciChecks).toBe("fail")
  })

  it("blocks when reviewer not approved", () => {
    const result = validatePRCheckpoints(fullCheckpoints({ reviewerApproval: failCP("reviewerApproval") }))
    expect(result.allowed).toBe(false)
  })

  it("blocks when goal verification fails", () => {
    const result = validatePRCheckpoints(fullCheckpoints({ goalVerification: failCP("goalVerification") }))
    expect(result.allowed).toBe(false)
  })

  it("blocks when gates are pending", () => {
    const result = validatePRCheckpoints(fullCheckpoints({ ciChecks: pendingCP("ciChecks") }))
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("ciChecks")
  })
})

// ─────────────────────────────────────────────────
// canMergeTaskPR — Task-local merge gate（不依赖全局 canMerge）
// ─────────────────────────────────────────────────

describe("canMergeTaskPR", () => {
  // canMergeTaskPR 还未实现 → 测试待 RED phase
  // 当实现完成后这些测试会通过

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let canMergeTaskPR: any

  beforeAll(async () => {
    ;({ canMergeTaskPR } = await import("../../src/flowrun/merge.js"))
  })

  // ✅ 正常路径
  it("allows merge when all checks pass and branch protection exists", () => {
    const task = makeTask()
    const result = canMergeTaskPR(task, true)
    expect(result.allowed).toBe(true)
  })

  // ❌ 阻断：Task 不是 reviewing
  it("blocks when task is not reviewing", () => {
    const task = makeTask({ status: "running" })
    const result = canMergeTaskPR(task, true)
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("running")
  })

  // ❌ 阻断：Task 已 merged
  it("blocks when task already merged", () => {
    const task = makeTask({ status: "merged" })
    const result = canMergeTaskPR(task, true)
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("merged")
  })

  // ❌ 阻断：无 PR checkpoints
  it("blocks when no PR checkpoints", () => {
    const task = makeTask({ prCheckpoints: null })
    const result = canMergeTaskPR(task, true)
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("No PR checkpoints")
  })

  // ❌ 阻断：CI fail
  it("blocks when CI checks fail", () => {
    const task = makeTask({ prCheckpoints: fullCheckpoints({ ciChecks: failCP("ciChecks") }) })
    const result = canMergeTaskPR(task, true)
    expect(result.allowed).toBe(false)
    expect(result.checkpointResults.ciChecks).toBe("fail")
  })

  // ❌ 阻断：review 未 approve
  it("blocks when reviewer not approved", () => {
    const task = makeTask({ prCheckpoints: fullCheckpoints({ reviewerApproval: failCP("reviewerApproval") }) })
    const result = canMergeTaskPR(task, true)
    expect(result.allowed).toBe(false)
    expect(result.checkpointResults.reviewerApproval).toBe("fail")
  })

  // ❌ 阻断：TDD compliance fail
  it("blocks when TDD compliance is fail", () => {
    const task = makeTask({ prCheckpoints: fullCheckpoints({ tddCompliance: tddFail() }) })
    const result = canMergeTaskPR(task, true)
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("TDD compliance")
  })

  // ✅ TDD compliance waived → pass
  it("allows merge when TDD compliance is waived", () => {
    const task = makeTask({
      prCheckpoints: fullCheckpoints({
        tddCompliance: { ...tddPass(), status: "waived" },
      }),
    })
    const result = canMergeTaskPR(task, true)
    expect(result.allowed).toBe(true)
  })

  // ✅ TDD compliance null → pass（无 TDD 要求）
  it("allows merge when TDD compliance is null", () => {
    const task = makeTask({ prCheckpoints: fullCheckpoints({ tddCompliance: null }) })
    const result = canMergeTaskPR(task, true)
    expect(result.allowed).toBe(true)
  })

  // ❌ 阻断：Branch protection 未启用
  it("blocks when branch protection not enabled", () => {
    const task = makeTask()
    const result = canMergeTaskPR(task, false)
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("Branch protection")
  })

  // ✅ 关键：不依赖全局 review Stage
  it("allows merge even when global review stage is not pass", () => {
    const task = makeTask()
    const result = canMergeTaskPR(task, true)
    expect(result.allowed).toBe(true)
  })

  // ❌ 阻断：pending checkpoints
  it("blocks when checkpoints are pending", () => {
    const task = makeTask({ prCheckpoints: fullCheckpoints({ ciChecks: pendingCP("ciChecks") }) })
    const result = canMergeTaskPR(task, true)
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("ciChecks")
  })
})

// ─────────────────────────────────────────────────
// mergeTaskPR — 合并前 re-verify remote head + --match-head-commit
// ─────────────────────────────────────────────────

describe("mergeTaskPR", () => {
  let mergeTaskPR: typeof import("../../src/flowrun/merge.js").mergeTaskPR
  let setMergeGhExecutor: typeof import("../../src/flowrun/merge.js").setMergeGhExecutor

  beforeAll(async () => {
    const mod = await import("../../src/flowrun/merge.js")
    mergeTaskPR = mod.mergeTaskPR
    setMergeGhExecutor = mod.setMergeGhExecutor
  })

  it("requires verifiedSha and returns error if missing", async () => {
    const result = await mergeTaskPR(1, "")
    expect(result.success).toBe(false)
    expect(result.error).toContain("verifiedSha is required")
  })

  it("attempts merge with --match-head-commit flag", async () => {
    const calls: string[] = []
    setMergeGhExecutor(async (args) => {
      calls.push(args)
      return { stdout: "Merged", stderr: "" }
    })

    const result = await mergeTaskPR(42, "abc123def456")
    expect(result.success).toBe(true)
    // 验证使用了 --match-head-commit
    expect(calls.some(c => c.includes("--match-head-commit") && c.includes("abc123def456"))).toBe(true)
  })

  it("blocks merge when gh fails", async () => {
    setMergeGhExecutor(async () => {
      throw new Error("Merge conflict")
    })

    const result = await mergeTaskPR(42, "abc123")
    expect(result.success).toBe(false)
    expect(result.error).toContain("Merge conflict")
  })
})

// ─────────────────────────────────────────────────
// 全链路：两个依赖 Task
// ─────────────────────────────────────────────────

describe("two-task dependency chain", () => {
  it("Task A merges first, then Task B becomes ready and merges, without global review gate", async () => {
    const { canMergeTaskPR } = await import("../../src/flowrun/merge.js")
    const { canStartTask } = await import("../../src/flowrun/gate.js")

    const flowRun = {
      ...createInitialFlowRun("chain-flow", "o/r", 1),
      status: "running",
    } as FlowRun

    // Task A: 无依赖，已进入 reviewing
    const taskA = makeTask({
      id: "task-a",
      name: "Task A",
      status: "reviewing",
      dependsOn: [],
    })

    // Task B: 依赖 Task A，尚未 ready
    const taskB = makeTask({
      id: "task-b",
      name: "Task B",
      status: "pending",
      dependsOn: ["task-a"],
      prNumber: null,
      prCheckpoints: null,
    })

    flowRun.tasks["task-a"] = taskA
    flowRun.tasks["task-b"] = taskB

    // 1. Task A 合并 — 不要求全局 review stage pass
    const resultA = canMergeTaskPR(taskA, true)
    expect(resultA.allowed).toBe(true)

    // 2. 模拟 Task A 合并成功
    const mergedTaskA: TaskState = { ...taskA, status: "merged" }
    flowRun.tasks["task-a"] = mergedTaskA

    // 3. Task B 现在依赖满足 → 变为 ready
    const updatedTaskB: TaskState = { ...taskB, status: "ready" as const }
    flowRun.tasks["task-b"] = updatedTaskB

    // 4. Task B 启动 → running → reviewing（模拟 TDD 完成 + PR 创建）
    const reviewingTaskB = makeTask({
      id: "task-b",
      name: "Task B",
      status: "reviewing",
      dependsOn: ["task-a"],
    })

    // 5. Task B 合并 — 也不要求全局 review stage pass
    const resultB = canMergeTaskPR(reviewingTaskB, true)
    expect(resultB.allowed).toBe(true)

    // 6. 验证：全程 review stage 从未被设为 pass
    expect(flowRun.stages.review.status).not.toBe("pass")
  })

  it("Task B blocks when Task A not yet merged", async () => {
    const { canStartTask } = await import("../../src/flowrun/gate.js")

    const flowRun = {
      ...createInitialFlowRun("chain-flow-2", "o/r", 2),
      status: "running",
    } as FlowRun

    // Task A 还在 running，未合并
    const taskA = makeTask({
      id: "task-a",
      name: "Task A",
      status: "running",
      dependsOn: [],
    })

    // Task B 依赖 Task A
    const taskB = makeTask({
      id: "task-b",
      name: "Task B",
      status: "pending",
      dependsOn: ["task-a"],
      prNumber: null,
      prCheckpoints: null,
    })

    flowRun.tasks["task-a"] = taskA
    flowRun.tasks["task-b"] = taskB

    // Task B 不能开始，因为 Task A 未 merged
    const startResult = canStartTask(flowRun, "task-b")
    expect(startResult.allowed).toBe(false)
  })
})

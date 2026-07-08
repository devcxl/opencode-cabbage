import { describe, it, expect } from "vitest"
import {
  validateCheckpoint, validatePRCheckpoints, canAutoMergeTask,
} from "../../src/flowrun/merge.js"
import { createInitialFlowRun } from "../../src/flowrun/github.js"
import type { FlowRun, PRCheckpoints, TaskState, Checkpoint } from "../../src/flowrun/types.js"

function passCP(name: string): Checkpoint {
  return { name, status: "pass", evidence: [{ command: "test", exitCode: 0, summary: "ok", timestamp: "now" }] }
}

function failCP(name: string): Checkpoint {
  return { name, status: "fail", evidence: [{ command: "test", exitCode: 1, summary: "failed", timestamp: "now" }] }
}

function pendingCP(name: string): Checkpoint {
  return { name, status: "pending", evidence: [] }
}

function fullCheckpoints(overrides?: Partial<PRCheckpoints>): PRCheckpoints {
  return {
    prNumber: 1,
    localChecks: passCP("localChecks"),
    ciChecks: passCP("ciChecks"),
    reviewerApproval: passCP("reviewerApproval"),
    goalVerification: passCP("goalVerification"),
    branchProtection: passCP("branchProtection"),
    mergeResult: pendingCP("mergeResult"),
    ...overrides,
  }
}

function flowRunWithReviewPass(): FlowRun {
  const base = createInitialFlowRun("flow-o/r-1", "o/r", 1)
  return {
    ...base,
    status: "running",
    stages: {
      ...base.stages,
      review: { ...base.stages.review, status: "pass" },
      code: { ...base.stages.code, status: "pass" },
    },
  } as FlowRun
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

describe("canAutoMergeTask", () => {
  it("allows merge when all checks pass and branch protection exists", () => {
    const flowRun = flowRunWithReviewPass()
    const task: TaskState = {
      id: "task-1", name: "Task 1", status: "reviewing",
      dependsOn: [], area: "backend", expectedFiles: ["src/a.ts"],
      testCommands: ["npm test"], acceptance: "Works", parallelSafe: true,
      prNumber: 1, prCheckpoints: fullCheckpoints(),
      blockedReason: null, startedAt: "now",
    }
    const protection = { exists: true, requiredChecks: ["CI"], requiresPR: true, dismissesStale: true }

    const result = canAutoMergeTask(flowRun, task, protection)
    expect(result.allowed).toBe(true)
  })

  it("blocks when branch protection not enabled", () => {
    const flowRun = flowRunWithReviewPass()
    const task: TaskState = {
      id: "task-1", name: "Task 1", status: "reviewing",
      dependsOn: [], area: "backend", expectedFiles: ["src/a.ts"],
      testCommands: ["npm test"], acceptance: "Works", parallelSafe: true,
      prNumber: 1, prCheckpoints: fullCheckpoints(),
      blockedReason: null, startedAt: "now",
    }
    const noProtection = { exists: false, requiredChecks: [], requiresPR: false, dismissesStale: false }

    const result = canAutoMergeTask(flowRun, task, noProtection)
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("Branch protection")
  })

  it("blocks when task already merged", () => {
    const flowRun = flowRunWithReviewPass()
    const task: TaskState = {
      id: "task-1", name: "Task 1", status: "merged",
      dependsOn: [], area: "backend", expectedFiles: ["src/a.ts"],
      testCommands: ["npm test"], acceptance: "Works", parallelSafe: true,
      prNumber: 1, prCheckpoints: null,
      blockedReason: null, startedAt: "now",
    }
    const protection = { exists: true, requiredChecks: [], requiresPR: true, dismissesStale: false }

    expect(canAutoMergeTask(flowRun, task, protection).allowed).toBe(false)
  })

  it("blocks when flow review stage not pass", () => {
    const flowRun = { ...createInitialFlowRun("id", "r", 1), status: "running" } as FlowRun
    const task: TaskState = {
      id: "a", name: "A", status: "reviewing",
      dependsOn: [], area: "b", expectedFiles: [],
      testCommands: [], acceptance: "", parallelSafe: true,
      prNumber: 1, prCheckpoints: fullCheckpoints(),
      blockedReason: null, startedAt: "now",
    }
    const protection = { exists: true, requiredChecks: [], requiresPR: true, dismissesStale: false }

    expect(canAutoMergeTask(flowRun, task, protection).allowed).toBe(false)
  })
})

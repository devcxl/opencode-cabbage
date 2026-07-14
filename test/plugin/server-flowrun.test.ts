import { describe, it, expect } from "vitest"
import {
  createInitialFlowRun,
} from "../../src/flowrun/github.js"
import {
  canStartTask,
  canCompleteTask,
  getReadyTasks,
  canStartStage,
  canCompleteStage,
} from "../../src/flowrun/gate.js"
import {
  validatePRCheckpoints,
  canAutoMergeTask,
} from "../../src/flowrun/merge.js"
import type { FlowRun, TaskState, StageState, PRCheckpoints, Checkpoint } from "../../src/flowrun/types.js"

function fakeCheckpoint(overrides: Partial<Checkpoint> = {}): Checkpoint {
  return {
    name: "test",
    status: "pass",
    evidence: [],
    ...overrides,
  }
}

function fakePRCheckpoints(overrides: Partial<PRCheckpoints>): PRCheckpoints {
  return {
    prNumber: 1,
    localChecks: fakeCheckpoint({ name: "localChecks" }),
    ciChecks: fakeCheckpoint({ name: "ciChecks" }),
    reviewerApproval: fakeCheckpoint({ name: "reviewerApproval" }),
    goalVerification: fakeCheckpoint({ name: "goalVerification" }),
    branchProtection: fakeCheckpoint({ name: "branchProtection" }),
    mergeResult: fakeCheckpoint({ name: "mergeResult", status: "pending" }),
    ...overrides,
  }
}

function designStage(): StageState {
  return {
    status: "pass",
    requiredArtifacts: [],
    checks: [],
    completedAt: new Date().toISOString(),
    evidence: [],
  }
}

function tasksStage(): StageState {
  return {
    status: "pass",
    requiredArtifacts: [],
    checks: [],
    completedAt: new Date().toISOString(),
    evidence: [],
  }
}

function spikeFlowRun(overrides: Partial<FlowRun> = {}): FlowRun {
  const base = createInitialFlowRun("flow-o/r-51", "o/r", 51)
  return {
    ...base,
    status: "running",
    stages: {
      requirements: designStage(),
      design: designStage(),
      tasks: { status: "pending", requiredArtifacts: [], checks: [], completedAt: null, evidence: [] },
      code: { status: "running", requiredArtifacts: [], checks: [], completedAt: null, evidence: [] },
      test: { status: "pending", requiredArtifacts: [], checks: [], completedAt: null, evidence: [] },
      review: { status: "pending", requiredArtifacts: [], checks: [], completedAt: null, evidence: [] },
      merge: { status: "pending", requiredArtifacts: [], checks: [], completedAt: null, evidence: [] },
    },
    tasks: {
      "task-1": {
        id: "task-1",
        name: "Task 1",
        dependsOn: [],
        area: "backend",
        parallelSafe: true,
        status: "merged",
        expectedFiles: [],
        testCommands: [],
        acceptance: "All tests pass",
        prNumber: 101,
        prCheckpoints: fakePRCheckpoints({ prNumber: 101 }),
        blockedReason: null,
        startedAt: null,
      },
      "task-2": {
        id: "task-2",
        name: "Task 2",
        dependsOn: ["task-1"],
        area: "backend",
        parallelSafe: false,
        status: "pending",
        expectedFiles: [],
        testCommands: [],
        acceptance: "All tests pass",
        prNumber: null,
        prCheckpoints: null,
        blockedReason: null,
        startedAt: null,
      },
      "task-3": {
        id: "task-3",
        name: "Task 3",
        dependsOn: [],
        area: "frontend",
        parallelSafe: true,
        status: "pending",
        expectedFiles: [],
        testCommands: [],
        acceptance: "All tests pass",
        prNumber: null,
        prCheckpoints: null,
        blockedReason: null,
        startedAt: null,
      },
    },
    ...overrides,
  } as FlowRun
}

describe("FlowRun Spike: State Machine Integration", () => {
  it("creates initial FlowRun with planned status", () => {
    const fr = createInitialFlowRun("flow-o/r-1", "o/r", 1)
    expect(fr.flowRunId).toBe("flow-o/r-1")
    expect(fr.status).toBe("planned")
    expect(fr.repo).toBe("o/r")
    expect(fr.parentIssueNumber).toBe(1)
    expect(Object.keys(fr.stages).length).toBe(7)
  })

  it("Goal remains independent from FlowRun", () => {
    const fr = spikeFlowRun()
    expect(fr.status).toBe("running")
    expect(fr.stages.code.status).toBe("running")
  })
})

describe("FlowRun Spike: Gate — canStartTask", () => {
  it("allows starting task with no dependencies when dependencies met", () => {
    const fr = spikeFlowRun()
    const result = canStartTask(fr, "task-3")
    expect(result.allowed).toBe(true)
  })

  it("allows task when sole dependency is merged", () => {
    const fr = spikeFlowRun()
    const result = canStartTask(fr, "task-2")
    expect(result.allowed).toBe(true)
  })

  it("blocks task when dependency is not merged/completed", () => {
    const fr = spikeFlowRun()
    fr.tasks["task-1"] = { ...fr.tasks["task-1"], status: "running" }
    const result = canStartTask(fr, "task-2")
    expect(result.allowed).toBe(false)
    expect(result.reason).toBeTruthy()
  })

  it("blocks when FlowRun is not running", () => {
    const fr = spikeFlowRun({ status: "planned" })
    const result = canStartTask(fr, "task-1")
    expect(result.allowed).toBe(false)
  })
})

describe("FlowRun Spike: Gate — getReadyTasks", () => {
  it("returns tasks whose dependencies are all merged", () => {
    const fr = spikeFlowRun()
    const ready = getReadyTasks(fr)
    const ids = ready.map((t: TaskState) => t.id)
    expect(ids).toContain("task-2")
    expect(ids).toContain("task-3")
    expect(ids).not.toContain("task-1")
  })

  it("returns ready tasks even when FlowRun is blocked (caller gates at higher level)", () => {
    const fr = spikeFlowRun({ status: "blocked" })
    const ready = getReadyTasks(fr)
    // getReadyTasks checks task-level readiness; FlowRun status gate is separate
    expect(ready.length).toBeGreaterThan(0)
  })
})

describe("FlowRun Spike: Gate — Stage transitions", () => {
  it("allows starting tasks stage when design passed", () => {
    const fr = spikeFlowRun()
    const result = canStartStage(fr, "tasks")
    expect(result.allowed).toBe(true)
  })

  it("blocks starting code when tasks not passed", () => {
    const fr = spikeFlowRun()
    fr.stages.tasks.status = "running"
    const result = canStartStage(fr, "code")
    expect(result.allowed).toBe(false)
  })

  it("allows completing code when code is running", () => {
    const fr = spikeFlowRun()
    const result = canCompleteStage(fr, "code")
    expect(result.allowed).toBe(true)
  })
})

describe("FlowRun Spike: Merge — PR Checkpoints", () => {
  it("validates all checkpoints pass", () => {
    const cp = fakePRCheckpoints({})
    const result = validatePRCheckpoints(cp)
    expect(result.allowed).toBe(true)
  })

  it("blocks when a checkpoint fails", () => {
    const cp = fakePRCheckpoints({
      localChecks: fakeCheckpoint({ name: "localChecks", status: "fail" }),
    })
    const result = validatePRCheckpoints(cp)
    expect(result.allowed).toBe(false)
    expect(result.checkpointResults.localChecks).toBe("fail")
  })

  it("blocks when checkpoints are pending", () => {
    const cp = fakePRCheckpoints({
      ciChecks: fakeCheckpoint({ name: "ciChecks", status: "pending" }),
    })
    const result = validatePRCheckpoints(cp)
    expect(result.allowed).toBe(false)
    expect(result.checkpointResults.ciChecks).toBe("pending")
  })

  it("canAutoMergeTask returns false for non-reviewing task", () => {
    const fr = spikeFlowRun()
    const task = { ...fr.tasks["task-1"], status: "merged" as const }
    const protection = { exists: true, requiredChecks: [], requiresPR: true, dismissesStale: false }
    const result = canAutoMergeTask(fr, task, protection)
    expect(result.allowed).toBe(false)
  })
})

describe("FlowRun Spike: Existing tests compatibility", () => {
  it("createInitialFlowRun still works with standard params", () => {
    const fr = createInitialFlowRun("flow-o/r-1", "o/r", 1)
    expect(fr.schemaVersion).toBeDefined()
    expect(fr.flowRunId).toBeDefined()
    expect(fr.stages).toBeDefined()
    expect(fr.tasks).toEqual({})
  })
})

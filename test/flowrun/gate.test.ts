import { describe, it, expect } from "vitest"
import {
  canStartStage, canCompleteStage, canStartTask, canCompleteTask,
  canMerge, allTasksComplete, getReadyTasks,
} from "../../src/flowrun/gate.js"
import { createInitialFlowRun } from "../../src/flowrun/github.js"
import type { FlowRun, FlowStage } from "../../src/flowrun/types.js"

function runningRun(overrides: Partial<FlowRun> = {}): FlowRun {
  const base = createInitialFlowRun("flow-o/r-1", "o/r", 1)
  return { ...base, status: "running", ...overrides } as FlowRun
}

function withStage(run: FlowRun, stage: FlowStage, status: string): FlowRun {
  return {
    ...run,
    stages: {
      ...run.stages,
      [stage]: { ...run.stages[stage], status },
    },
  }
}

function withTask(run: FlowRun, task: Record<string, unknown>): FlowRun {
  return {
    ...run,
    tasks: { ...run.tasks, [task.id as string]: task as any },
  }
}

describe("canStartStage", () => {
  it("allows starting first stage when flow is running", () => {
    const run = runningRun()
    const result = canStartStage(run, "requirements")
    expect(result.allowed).toBe(true)
  })

  it("allows starting second stage when first is complete", () => {
    const run = withStage(runningRun(), "requirements", "pass")
    expect(canStartStage(run, "design").allowed).toBe(true)
  })

  it("blocks when previous stage is pending", () => {
    const run = runningRun()
    const result = canStartStage(run, "design")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("requirements")
  })

  it("blocks when flow is not running", () => {
    const run = { ...runningRun(), status: "planned" as const }
    const result = canStartStage(run, "requirements")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("planned")
  })

  it("blocks when stage already completed", () => {
    const run = withStage(runningRun(), "requirements", "pass")
    const result = canStartStage(run, "requirements")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("already completed")
  })

  it("blocks merge stage if review not complete", () => {
    const run = withStage(runningRun(), "requirements", "pass")
    const run2 = withStage(run, "design", "pass")
    const run3 = withStage(run2, "tasks", "pass")
    const run4 = withStage(run3, "code", "pass")
    const run5 = withStage(run4, "test", "pass")
    const run6 = withStage(run5, "review", "pending")
    const result = canStartStage(run6, "merge")
    expect(result.allowed).toBe(false)
  })
})

describe("canCompleteStage", () => {
  it("allows completing stage with no artifacts and no checks", () => {
    const run = withStage(runningRun(), "requirements", "running")
    const result = canCompleteStage(run, "requirements")
    expect(result.allowed).toBe(true)
  })

  it("blocks if checks have failures", () => {
    const run = withStage(runningRun(), "requirements", "running")
    run.stages.requirements.checks = [
      { name: "prd-exists", status: "fail", evidence: [{ command: "test", exitCode: 1, summary: "not found", timestamp: "now" }] },
    ]
    const result = canCompleteStage(run, "requirements")
    expect(result.allowed).toBe(false)
    expect(result.failedChecks).toContain("prd-exists")
  })

  it("blocks if checks are still pending", () => {
    const run = withStage(runningRun(), "requirements", "running")
    run.stages.requirements.checks = [
      { name: "prd-exists", status: "pending", evidence: [] },
    ]
    const result = canCompleteStage(run, "requirements")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("pending")
  })
})

describe("canStartTask", () => {
  it("allows starting a task with no dependencies", () => {
    const run = withStage(runningRun(), "code", "running")
    const run2 = withTask(run, {
      id: "task-1", name: "Task 1", status: "pending",
      dependsOn: [], expectedFiles: ["src/a.ts"],
    } as any)
    const result = canStartTask(run2, "task-1")
    expect(result.allowed).toBe(true)
  })

  it("allows starting a task when dependencies are merged", () => {
    const run = withStage(runningRun(), "code", "running")
    const run2 = withTask(run, {
      id: "task-1", name: "Task 1", status: "merged",
      dependsOn: [], expectedFiles: ["src/a.ts"],
    } as any)
    const run3 = withTask(run2, {
      id: "task-2", name: "Task 2", status: "pending",
      dependsOn: ["task-1"], expectedFiles: ["src/b.ts"],
    } as any)
    const result = canStartTask(run3, "task-2")
    expect(result.allowed).toBe(true)
  })

  it("blocks when dependency not merged", () => {
    const run = withStage(runningRun(), "code", "running")
    const run2 = withTask(run, {
      id: "task-1", name: "Task 1", status: "running",
      dependsOn: [], expectedFiles: ["src/a.ts"],
    } as any)
    const run3 = withTask(run2, {
      id: "task-2", name: "Task 2", status: "pending",
      dependsOn: ["task-1"], expectedFiles: ["src/b.ts"],
    } as any)
    const result = canStartTask(run3, "task-2")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("task-1")
  })

  it("blocks when flow is not running", () => {
    const run = { ...runningRun(), status: "blocked" as const }
    const run2 = withStage(run, "code", "running")
    const run3 = withTask(run2, {
      id: "task-1", name: "Task 1", status: "pending",
      dependsOn: [], expectedFiles: ["src/a.ts"],
    } as any)
    expect(canStartTask(run3, "task-1").allowed).toBe(false)
  })

  it("blocks if code stage is not active", () => {
    const run = withStage(runningRun(), "code", "pending")
    const run2 = withTask(run, {
      id: "task-1", name: "Task 1", status: "pending",
      dependsOn: [], expectedFiles: ["src/a.ts"],
    } as any)
    expect(canStartTask(run2, "task-1").allowed).toBe(false)
  })
})

describe("canCompleteTask", () => {
  it("allows completing a running task", () => {
    const run = withTask(runningRun(), {
      id: "task-1", name: "Task 1", status: "running",
      dependsOn: [], expectedFiles: ["src/a.ts"],
    } as any)
    expect(canCompleteTask(run, "task-1").allowed).toBe(true)
  })

  it("blocks completing a pending task", () => {
    const run = withTask(runningRun(), {
      id: "task-1", name: "Task 1", status: "pending",
      dependsOn: [], expectedFiles: ["src/a.ts"],
    } as any)
    expect(canCompleteTask(run, "task-1").allowed).toBe(false)
  })

  it("returns error for non-existent task", () => {
    const run = runningRun()
    const result = canCompleteTask(run, "no-such-task")
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain("not found")
  })
})

describe("canMerge", () => {
  it("allows when flow is running and all tasks are merged", () => {
    const run = withTask(runningRun(), { id: "a", status: "merged", dependsOn: [], expectedFiles: [] } as any)
    expect(canMerge(run).allowed).toBe(true)
  })

  it("allows when flow is merging and all tasks merged", () => {
    const run = withTask(runningRun(), { id: "a", status: "merged", dependsOn: [], expectedFiles: [] } as any)
    const run2 = { ...run, status: "merging" as const }
    expect(canMerge(run2).allowed).toBe(true)
  })

  it("blocks when some tasks not merged", () => {
    const run = withTask(runningRun(), { id: "a", status: "merged", dependsOn: [], expectedFiles: [] } as any)
    const run2 = withTask(run, { id: "b", status: "running", dependsOn: [], expectedFiles: [] } as any)
    expect(canMerge(run2).allowed).toBe(false)
    expect(canMerge(run2).reason).toContain("all tasks merged")
  })

  it("blocks when no tasks exist", () => {
    expect(canMerge(runningRun()).allowed).toBe(false)
  })

  it("blocks when flow is not in mergeable state", () => {
    const run = withTask(runningRun(), { id: "a", status: "merged", dependsOn: [], expectedFiles: [] } as any)
    const run2 = { ...run, status: "completed" as const }
    expect(canMerge(run2).allowed).toBe(false)
  })

  // 新语义：不再要求 review stage pass
  it("allows merge even when review stage is not pass", () => {
    const run = withTask(runningRun(), { id: "a", status: "merged", dependsOn: [], expectedFiles: [] } as any)
    const run2 = withStage(run, "review", "pending")
    // review stage pending 不应阻止 canMerge
    expect(canMerge(run2).allowed).toBe(true)
  })
})

describe("allTasksComplete", () => {
  it("returns true when all tasks are merged", () => {
    const run = withTask(runningRun(), { id: "a", status: "merged", dependsOn: [], expectedFiles: [] } as any)
    const run2 = withTask(run, { id: "b", status: "merged", dependsOn: [], expectedFiles: [] } as any)
    expect(allTasksComplete(run2)).toBe(true)
  })

  it("returns false when any task is running", () => {
    const run = withTask(runningRun(), { id: "a", status: "merged", dependsOn: [], expectedFiles: [] } as any)
    const run2 = withTask(run, { id: "b", status: "running", dependsOn: [], expectedFiles: [] } as any)
    expect(allTasksComplete(run2)).toBe(false)
  })

  it("returns false when no tasks exist", () => {
    expect(allTasksComplete(runningRun())).toBe(false)
  })
})

describe("getReadyTasks", () => {
  it("returns tasks whose dependencies are merged", () => {
    const run = withTask(runningRun(), { id: "a", status: "merged", dependsOn: [], expectedFiles: [] } as any)
    const run2 = withTask(run, { id: "b", status: "pending", dependsOn: ["a"], expectedFiles: [] } as any)
    const ready = getReadyTasks(run2)
    expect(ready).toHaveLength(1)
    expect(ready[0].id).toBe("b")
  })

  it("excludes tasks with unmerged dependencies", () => {
    const run = withTask(runningRun(), { id: "a", status: "merged", dependsOn: [], expectedFiles: [] } as any)
    const run2 = withTask(run, { id: "b", status: "pending", dependsOn: ["a"], expectedFiles: [] } as any)
    const run3 = withTask(run2, { id: "c", status: "pending", dependsOn: ["b"], expectedFiles: [] } as any)
    const ready = getReadyTasks(run3)
    expect(ready).toHaveLength(1)
    expect(ready[0].id).toBe("b")
  })

  it("excludes already running tasks", () => {
    const run = withTask(runningRun(), { id: "a", status: "running", dependsOn: [], expectedFiles: [] } as any)
    expect(getReadyTasks(run)).toHaveLength(0)
  })
})

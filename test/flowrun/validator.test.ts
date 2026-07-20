import { describe, it, expect } from "vitest"
import { validateFlowRunDag } from "../../src/flowrun/validator.js"
import type { TaskState } from "../../src/flowrun/types.js"

function makeTask(id: string, dependsOn: string[] = [], overrides: Partial<TaskState> = {}): TaskState {
  return {
    id,
    name: `Task ${id}`,
    status: "pending",
    dependsOn,
    area: "backend",
    expectedFiles: [],
    parallelSafe: false,
    prNumber: null,
    prCheckpoints: null,
    blockedReason: null,
    startedAt: null,
    // v2 fields
    acceptanceCriteria: [],
    testCommands: [],
    verifyCommands: [],
    executionBinding: null,
    tddPolicy: {
      mode: "bypass",
      enforcement: "advisory",
      runner: null,
      testFilePatterns: [],
      implementationFilePatterns: [],
      generatedArtifactPatterns: [],
      exception: {
        reason: "test",
        alternativeValidation: [],
        approval: { kind: "legacy-migration", fromSchemaVersion: 1 },
      },
      source: { manifestPath: "test", revisionSha: "test" },
    },
    tddEvidence: {
      revision: 0,
      reworkRevision: 0,
      status: "not-recorded",
      taskStart: { status: "pending", headSha: null, treeSha: null, startedAt: null },
      cycles: [],
      regression: { status: "pending", headSha: null, treeSha: null, reworkRevision: 0, runs: [] },
      verification: { status: "pending", headSha: null, treeSha: null, runs: [] },
      alternativeValidation: [],
      reworks: [],
      warnings: [],
      updatedAt: null,
    },
    coveragePolicy: null,
    ...overrides,
  }
}

describe("validateFlowRunDag", () => {
  it("accepts empty tasks", () => {
    const errors = validateFlowRunDag({})
    expect(errors).toHaveLength(0)
  })

  it("accepts single task with no dependencies", () => {
    const tasks: Record<string, TaskState> = {
      "task-1": makeTask("task-1"),
    }
    const errors = validateFlowRunDag(tasks)
    expect(errors).toHaveLength(0)
  })

  it("accepts linear dependency chain", () => {
    const tasks: Record<string, TaskState> = {
      "task-1": makeTask("task-1"),
      "task-2": makeTask("task-2", ["task-1"]),
      "task-3": makeTask("task-3", ["task-2"]),
    }
    const errors = validateFlowRunDag(tasks)
    expect(errors).toHaveLength(0)
  })

  it("accepts diamond dependency", () => {
    const tasks: Record<string, TaskState> = {
      "task-a": makeTask("task-a"),
      "task-b": makeTask("task-b", ["task-a"]),
      "task-c": makeTask("task-c", ["task-a"]),
      "task-d": makeTask("task-d", ["task-b", "task-c"]),
    }
    const errors = validateFlowRunDag(tasks)
    expect(errors).toHaveLength(0)
  })

  // ─── Record key 与 task.id 一致 ───

  it("rejects record key mismatch", () => {
    const tasks: Record<string, TaskState> = {
      "wrong-key": makeTask("task-1"),
    }
    const errors = validateFlowRunDag(tasks)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(e => e.path.startsWith("tasks.wrong-key") && e.message.includes("does not match"))).toBe(true)
  })

  // ─── 未知依赖 ───

  it("rejects unknown dependency", () => {
    const tasks: Record<string, TaskState> = {
      "task-1": makeTask("task-1", ["task-nonexistent"]),
    }
    const errors = validateFlowRunDag(tasks)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(e => e.path.includes("dependsOn") && e.message.includes("not found"))).toBe(true)
  })

  // ─── 自依赖 ───

  it("rejects self-dependency", () => {
    const tasks: Record<string, TaskState> = {
      "task-1": makeTask("task-1", ["task-1"]),
    }
    const errors = validateFlowRunDag(tasks)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(e => e.path.includes("dependsOn") && e.message.includes("depends on itself"))).toBe(true)
  })

  // ─── 环路 ───

  it("rejects simple cycle (A → B → A)", () => {
    const tasks: Record<string, TaskState> = {
      "task-a": makeTask("task-a", ["task-b"]),
      "task-b": makeTask("task-b", ["task-a"]),
    }
    const errors = validateFlowRunDag(tasks)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(e => e.message.includes("Circular dependency"))).toBe(true)
  })

  it("rejects three-node cycle (A → B → C → A)", () => {
    const tasks: Record<string, TaskState> = {
      "task-a": makeTask("task-a", ["task-c"]),
      "task-b": makeTask("task-b", ["task-a"]),
      "task-c": makeTask("task-c", ["task-b"]),
    }
    const errors = validateFlowRunDag(tasks)
    expect(errors.length).toBeGreaterThan(0)
    expect(errors.some(e => e.message.includes("Circular dependency"))).toBe(true)
  })

  // ─── 组合错误 ───

  it("reports multiple errors", () => {
    const tasks: Record<string, TaskState> = {
      "task-1": makeTask("task-1", ["task-99"]), // unknown dep
      "task-2": makeTask("task-2", ["task-2"]), // self-dep
      "wrong-key": makeTask("task-3"), // key mismatch
    }
    const errors = validateFlowRunDag(tasks)
    expect(errors.length).toBeGreaterThanOrEqual(2)
  })
})

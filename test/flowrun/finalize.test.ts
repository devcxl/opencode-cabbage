import { describe, it, expect } from "vitest"
import { flowRunFinalize } from "../../src/flowrun/transitions.js"
import { createInitialFlowRun } from "../../src/flowrun/github.js"
import type { FlowRun } from "../../src/flowrun/types.js"

/**
 * 辅助：创建 running 状态、code stage running 的基础 FlowRun
 */
function baseRun(overrides: Partial<FlowRun> = {}): FlowRun {
  const base = createInitialFlowRun("flow-o/r-1", "o/r", 1)
  return {
    ...base,
    status: "running",
    ...overrides,
  } as FlowRun
}

/**
 * 辅助：设置指定 stage 的状态
 */
function withStage(run: FlowRun, stage: string, status: string): FlowRun {
  return {
    ...run,
    stages: {
      ...run.stages,
      [stage]: { ...run.stages[stage as keyof typeof run.stages], status },
    },
  }
}

/**
 * 辅助：添加一个 merged 状态的 task
 */
function withTaskMerged(run: FlowRun, taskId: string, dependsOn: string[] = []): FlowRun {
  return {
    ...run,
    tasks: {
      ...run.tasks,
      [taskId]: {
        id: taskId,
        name: taskId,
        status: "merged",
        dependsOn,
        expectedFiles: [`src/${taskId}.ts`],
      },
    },
  }
}

// ─────────────────────────────────────────────
// flowRunFinalize 测试
// ─────────────────────────────────────────────

describe("flowRunFinalize", () => {
  it("正确推进 code→test→review→merge 四个 Stage 为 pass，并设为 completed", () => {
    // 前置：所有 task merged
    let run = baseRun()
    run = withStage(run, "requirements", "pass")
    run = withStage(run, "design", "pass")
    run = withStage(run, "tasks", "pass")
    run = withStage(run, "code", "running")
    run = withStage(run, "test", "running")
    run = withStage(run, "review", "running")
    run = withStage(run, "merge", "pending")
    run = withTaskMerged(run, "task-1")

    const result = flowRunFinalize(run)

    expect(result.ok).toBe(true)
    const finalized = result.ok ? result.value : run

    // 四个 stage 全部 pass
    expect(finalized.stages.code.status).toBe("pass")
    expect(finalized.stages.test.status).toBe("pass")
    expect(finalized.stages.review.status).toBe("pass")
    expect(finalized.stages.merge.status).toBe("pass")

    // FlowRun status → completed
    expect(finalized.status).toBe("completed")
    // completedAt 已设置
    expect(finalized.completedAt).not.toBeNull()
    expect(finalized.completedAt).toBeDefined()
  })

  it("当并非所有 Task 都 merged 时拒绝", () => {
    let run = baseRun()
    run = withStage(run, "code", "running")
    run = withTaskMerged(run, "task-1")
    // task-2 未 merged
    run = {
      ...run,
      tasks: {
        ...run.tasks,
        "task-2": {
          id: "task-2",
          name: "task-2",
          status: "running",
          dependsOn: [],
          expectedFiles: ["src/task-2.ts"],
        },
      },
    } as FlowRun

    const result = flowRunFinalize(run)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("GATE_BLOCKED")
      expect(result.error.message).toContain("all tasks merged")
    }
  })

  it("当 FlowRun 状态非 running 且非 merging 时拒绝", () => {
    let run = baseRun({ status: "blocked" })
    run = withTaskMerged(run, "task-1")

    const result = flowRunFinalize(run)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("GATE_BLOCKED")
    }
  })

  it("幂等：已经是 completed 状态则直接返回（不变更）", () => {
    let run = baseRun({ status: "completed", completedAt: "2025-01-01T00:00:00.000Z" })
    run = withStage(run, "code", "pass")
    run = withStage(run, "test", "pass")
    run = withStage(run, "review", "pass")
    run = withStage(run, "merge", "pass")
    run = withTaskMerged(run, "task-1")

    const result = flowRunFinalize(run)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // completedAt 不应变化
      expect(result.value.completedAt).toBe("2025-01-01T00:00:00.000Z")
      expect(result.value.status).toBe("completed")
    }
  })

  it("幂等：两次 finalize 结果一致", () => {
    let run = baseRun()
    run = withStage(run, "requirements", "pass")
    run = withStage(run, "design", "pass")
    run = withStage(run, "tasks", "pass")
    run = withStage(run, "code", "running")
    run = withStage(run, "test", "running")
    run = withStage(run, "review", "running")
    run = withStage(run, "merge", "pending")
    run = withTaskMerged(run, "task-1")

    const result1 = flowRunFinalize(run)
    expect(result1.ok).toBe(true)
    if (!result1.ok) return

    // 第二次 finalize
    const result2 = flowRunFinalize(result1.value)
    expect(result2.ok).toBe(true)
    if (!result2.ok) return

    // 状态一致
    expect(result2.value.status).toBe("completed")
    expect(result2.value.completedAt).toBe(result1.value.completedAt)
  })

  it("跳过已经是 pass 的 Stage（不重复标记）", () => {
    let run = baseRun()
    run = withStage(run, "requirements", "pass")
    run = withStage(run, "design", "pass")
    run = withStage(run, "tasks", "pass")
    run = withStage(run, "code", "pass")   // 已 pass
    run = withStage(run, "test", "running")
    run = withStage(run, "review", "running")
    run = withStage(run, "merge", "pending")
    run = withTaskMerged(run, "task-1")

    const result = flowRunFinalize(run)
    expect(result.ok).toBe(true)
    if (result.ok) {
      // code 保持原来的 completedAt（finalize 不会重新设置已有的）
      expect(result.value.stages.code.status).toBe("pass")
      expect(result.value.stages.test.status).toBe("pass")
      expect(result.value.stages.review.status).toBe("pass")
      expect(result.value.stages.merge.status).toBe("pass")
      expect(result.value.status).toBe("completed")
    }
  })
})

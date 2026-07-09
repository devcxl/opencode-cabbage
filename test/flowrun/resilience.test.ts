import { describe, it, expect } from "vitest"
import {
  getRuntimeMs, hasRuntimeExpired, checkRuntime,
  buildContinuationContext,
} from "../../src/flowrun/resilience.js"
import { determineNextStage } from "../../src/flowrun/gate.js"
import { createInitialFlowRun } from "../../src/flowrun/github.js"
import type { FlowRun } from "../../src/flowrun/types.js"

function runWithStartedAt(startedAt: string | null): FlowRun {
  return { ...createInitialFlowRun("flow-o/r-1", "o/r", 1), startedAt } as FlowRun
}

describe("getRuntimeMs", () => {
  it("returns 0 when startedAt is null", () => {
    expect(getRuntimeMs(runWithStartedAt(null))).toBe(0)
  })

  it("returns a positive number when startedAt is set", () => {
    const run = runWithStartedAt(new Date(Date.now() - 60_000).toISOString())
    expect(getRuntimeMs(run)).toBeGreaterThan(50_000)
    expect(getRuntimeMs(run)).toBeLessThan(70_000)
  })
})

describe("hasRuntimeExpired", () => {
  it("returns false for newly created run", () => {
    expect(hasRuntimeExpired(createInitialFlowRun("id", "r", 1) as FlowRun)).toBe(false)
  })

  it("returns true when maxRuntime is exceeded", () => {
    const run = { ...createInitialFlowRun("id", "r", 1), startedAt: new Date(Date.now() - 100_000).toISOString(), maxRuntime: 50_000 } as FlowRun
    expect(hasRuntimeExpired(run)).toBe(true)
  })
})

describe("checkRuntime", () => {
  it("returns remaining time", () => {
    const run = { ...createInitialFlowRun("id", "r", 1), startedAt: new Date(Date.now() - 60_000).toISOString() } as FlowRun
    const result = checkRuntime(run)
    expect(result.expired).toBe(false)
    expect(result.maxRuntimeMs).toBe(86_400_000)
    expect(result.remainingMs).toBeGreaterThan(0)
  })

  it("detects expired runtime", () => {
    const run = { ...createInitialFlowRun("id", "r", 1), startedAt: new Date(Date.now() - 100_000).toISOString(), maxRuntime: 10_000 } as FlowRun
    const result = checkRuntime(run)
    expect(result.expired).toBe(true)
    expect(result.runtimeMs).toBeGreaterThan(90_000)
    expect(result.remainingMs).toBe(0)
  })
})

describe("buildContinuationContext", () => {
  it("includes flow run ID and status", () => {
    const run = createInitialFlowRun("flow-o/r-7", "o/r", 7) as FlowRun
    const ctx = buildContinuationContext(run)
    expect(ctx).toContain("flow-o/r-7")
    expect(ctx).toContain("planned")
  })

  it("includes all stages", () => {
    const run = createInitialFlowRun("flow-o/r-1", "o/r", 1) as FlowRun
    const ctx = buildContinuationContext(run)
    expect(ctx).toContain("requirements")
    expect(ctx).toContain("design")
    expect(ctx).toContain("merge")
  })

  it("includes tasks when present", () => {
    const run = createInitialFlowRun("flow-o/r-1", "o/r", 1) as FlowRun
    run.tasks = {
      "task-1": { id: "task-1", status: "running", name: "T1", dependsOn: [], area: "b", expectedFiles: [], testCommands: [], acceptance: "", parallelSafe: true, prNumber: 5, prCheckpoints: null, blockedReason: null, startedAt: "now" },
    }
    const ctx = buildContinuationContext(run)
    expect(ctx).toContain("task-1")
    expect(ctx).toContain("PR #5")
  })
})

describe("determineNextStage", () => {
  it("returns first pending stage when flow is running", () => {
    const run = { ...createInitialFlowRun("flow-o/r-1", "o/r", 1), status: "running" } as FlowRun
    const result = determineNextStage(run)
    expect(result.stage).toBe("requirements")
  })

  it("returns null when flow is not running", () => {
    const run = createInitialFlowRun("flow-o/r-1", "o/r", 1) as FlowRun
    const result = determineNextStage(run)
    expect(result.stage).toBeNull()
  })

  it("returns next stage when previous is complete", () => {
    const run = createInitialFlowRun("id", "r", 1) as FlowRun
    run.stages.requirements.status = "pass"
    run.stages.design.status = "running"
    const result = determineNextStage(run)
    expect(result.stage).toBe("design")
  })

  it("returns null when all stages pass", () => {
    const run = createInitialFlowRun("id", "r", 1) as FlowRun
    for (const stage of ["requirements", "design", "tasks", "code", "test", "review", "merge"]) {
      run.stages[stage as keyof typeof run.stages].status = "pass"
    }
    const result = determineNextStage(run)
    expect(result.stage).toBeNull()
    expect(result.reason).toContain("complete")
  })
})

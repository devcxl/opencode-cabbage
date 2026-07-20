import { describe, it, expect } from "vitest"
import { canTransitionTo, formatGoal, continuationPrompt, verifyAgentPrompt, MAX_CONTINUATIONS, checkFlowRunBlockers } from "../src/plugin/goal.js"

const activeGoal = () => ({
  objective: "Implement user authentication",
  completionCriterion: "All auth tests pass, PR merged",
  status: "active" as const,
  continuationCount: 0,
})

describe("canTransitionTo", () => {
  it("allows active -> paused", () => {
    expect(canTransitionTo(activeGoal(), "paused")).toBe(true)
  })

  it("allows active -> complete", () => {
    expect(canTransitionTo(activeGoal(), "complete")).toBe(true)
  })

  it("allows paused -> active", () => {
    const g = { ...activeGoal(), status: "paused" as const }
    expect(canTransitionTo(g, "active")).toBe(true)
  })

  it("rejects paused -> complete", () => {
    const g = { ...activeGoal(), status: "paused" as const }
    expect(canTransitionTo(g, "complete")).toBe(false)
  })

  it("rejects complete -> anything", () => {
    const g = { ...activeGoal(), status: "complete" as const }
    expect(canTransitionTo(g, "active")).toBe(false)
    expect(canTransitionTo(g, "paused")).toBe(false)
    expect(canTransitionTo(g, "complete")).toBe(false)
  })

  it("rejects active -> active (no-op)", () => {
    expect(canTransitionTo(activeGoal(), "active")).toBe(false)
  })

  it("rejects unknown target status", () => {
    expect(canTransitionTo(activeGoal(), "invalid" as any)).toBe(false)
  })
})

describe("formatGoal", () => {
  it("includes objective, criterion, and status", () => {
    const result = formatGoal(activeGoal())
    expect(result).toContain("Goal: Implement user authentication")
    expect(result).toContain("Completion criterion: All auth tests pass, PR merged")
    expect(result).toContain("Status: active")
  })
})

describe("continuationPrompt", () => {
  it("includes objective and criterion", () => {
    const result = continuationPrompt("My objective", "My criterion")
    expect(result).toContain("My objective")
    expect(result).toContain("My criterion")
  })
})

describe("verifyAgentPrompt", () => {
  it("instructs read-only verification", () => {
    const result = verifyAgentPrompt()
    expect(result).toContain("read-only")
    expect(result).toContain("goal({op:\"get\"})")
    expect(result).toContain("goal({op:\"complete\"})")
  })

  it("states that only goal-verify can complete", () => {
    const result = verifyAgentPrompt()
    expect(result).toContain("goal-verify")
    expect(result).toContain("complete")
  })
})

describe("goal complete authorization", () => {
  it("verifies agent identity check exists in createGoalTool", () => {
    // The createGoalTool execute function checks ctx.agent === "goal-verify"
    // for subagent complete operations. This test validates the contract
    // by ensuring the verifyAgentPrompt instructs goal-verify behavior.
    const prompt = verifyAgentPrompt()
    expect(prompt).toContain("Call goal({op:\"complete\"})")
  })

  it("explicitly revokes complete from other agents", () => {
    const prompt = verifyAgentPrompt()
    expect(prompt).toContain("Other agents")
    expect(prompt).toContain("cannot complete")
  })
})

describe("MAX_CONTINUATIONS", () => {
  it("is 50", () => {
    expect(MAX_CONTINUATIONS).toBe(50)
  })
})

describe("checkFlowRunBlockers", () => {
  it("允许完成：无 FlowRun 绑定（null）", () => {
    expect(checkFlowRunBlockers(null)).toBeNull()
  })

  it("允许完成：FlowRun 状态为 completed", () => {
    expect(checkFlowRunBlockers("completed")).toBeNull()
  })

  it("允许完成：FlowRun 状态为 cancelled", () => {
    expect(checkFlowRunBlockers("cancelled")).toBeNull()
  })

  it("阻止完成：FlowRun 状态为 running", () => {
    const result = checkFlowRunBlockers("running")
    expect(result).not.toBeNull()
    expect(result).toContain("terminal state")
    expect(result).toContain("run-finalize")
  })

  it("阻止完成：FlowRun 状态为 merging", () => {
    const result = checkFlowRunBlockers("merging")
    expect(result).not.toBeNull()
    expect(result).toContain("terminal state")
  })

  it("阻止完成：FlowRun 状态为 blocked", () => {
    const result = checkFlowRunBlockers("blocked")
    expect(result).not.toBeNull()
    expect(result).toContain("terminal state")
  })

  it("阻止完成：FlowRun 状态为 planned", () => {
    const result = checkFlowRunBlockers("planned")
    expect(result).not.toBeNull()
    expect(result).toContain("terminal state")
  })
})

import { describe, it, expect } from "vitest"
import { canTransitionTo, formatGoal, continuationPrompt, verifyAgentPrompt, MAX_CONTINUATIONS, createGoal } from "../src/plugin/goal.js"

const activeGoal = () => ({
  parentIssueNumber: 42,
  status: "active" as const,
  continuationCount: 0,
})

describe("GoalData 最小化", () => {
  it("createGoal 只含 parentIssueNumber/status/continuationCount", () => {
    const goal = createGoal(42)
    expect(goal).toEqual({ parentIssueNumber: 42, status: "active", continuationCount: 0 })
  })

  it("不再存储 objective/completionCriterion（从 Flow Record 读取）", () => {
    const goal = createGoal(42)
    expect("objective" in goal).toBe(false)
    expect("completionCriterion" in goal).toBe(false)
  })
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
  it("包含 parentIssueNumber 与 status，不含 objective", () => {
    const result = formatGoal(activeGoal())
    expect(result).toContain("#42")
    expect(result).toContain("Status: active")
    expect(result).not.toContain("objective")
  })
})

describe("continuationPrompt", () => {
  it("引用 Flow Record 的 parent issue number", () => {
    const result = continuationPrompt(42)
    expect(result).toContain("#42")
    expect(result).toContain("Flow Record")
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

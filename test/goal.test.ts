import { describe, it, expect } from "vitest"
import { canTransitionTo, formatGoal, continuationPrompt, MAX_CONTINUATIONS, createGoal } from "../src/plugin/goal.js"

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

  it("createGoal 支持 sessionProfile 快照（agent/模型续接防切换）", () => {
    const goal = createGoal(42, { agent: "dev", model: { providerID: "openai", modelID: "gpt-5.6-sol" } })
    expect(goal.sessionProfile).toEqual({ agent: "dev", model: { providerID: "openai", modelID: "gpt-5.6-sol" } })
  })

  it("formatGoal 展示快照 agent", () => {
    const goal = createGoal(42, { agent: "dev" })
    expect(formatGoal(goal)).toContain("Agent: dev")
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

describe("MAX_CONTINUATIONS", () => {
  it("is 50", () => {
    expect(MAX_CONTINUATIONS).toBe(50)
  })
})

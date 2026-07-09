import { describe, it, expect } from "vitest"
import { validateFlowRun } from "../../src/flowrun/validator.js"
import { CURRENT_SCHEMA_VERSION } from "../../src/flowrun/types.js"

function validFlowRun(): Record<string, unknown> {
  const emptyStage = () => ({
    status: "pending",
    requiredArtifacts: [],
    checks: [],
    completedAt: null,
    evidence: [],
  })

  return {
    flowRunId: "flow-owner/repo-issue-42",
    repo: "owner/repo",
    parentIssueNumber: 42,
    status: "planned",
    schemaVersion: CURRENT_SCHEMA_VERSION,
    revision: 0,
    stages: {
      requirements: emptyStage(),
      design: emptyStage(),
      tasks: emptyStage(),
      code: emptyStage(),
      test: emptyStage(),
      review: emptyStage(),
      merge: emptyStage(),
    },
    tasks: {},
    startedAt: "2026-07-08T00:00:00.000Z",
    lastTickAt: "2026-07-08T00:00:00.000Z",
    nextTickAfter: null,
    maxRuntime: 86_400_000,
    completedAt: null,
  }
}

describe("validateFlowRun", () => {
  it("accepts a valid FlowRun", () => {
    const { data, errors } = validateFlowRun(validFlowRun())
    expect(errors).toHaveLength(0)
    expect(data).not.toBeNull()
  })

  it("rejects null", () => {
    const { data, errors } = validateFlowRun(null)
    expect(data).toBeNull()
    expect(errors.length).toBeGreaterThan(0)
  })

  it("rejects non-object", () => {
    const { data, errors } = validateFlowRun("string")
    expect(data).toBeNull()
    expect(errors.length).toBeGreaterThan(0)
  })

  it("rejects missing flowRunId", () => {
    const obj = { ...validFlowRun(), flowRunId: "" }
    const { errors } = validateFlowRun(obj)
    expect(errors.some(e => e.path === "flowRunId")).toBe(true)
  })

  it("rejects invalid status", () => {
    const obj = { ...validFlowRun(), status: "invalid" }
    const { errors } = validateFlowRun(obj)
    expect(errors.some(e => e.path === "status")).toBe(true)
  })

  it("rejects missing repo", () => {
    const obj = { ...validFlowRun(), repo: "" }
    const { errors } = validateFlowRun(obj)
    expect(errors.some(e => e.path === "repo")).toBe(true)
  })

  it("rejects non-positive parentIssueNumber", () => {
    const obj = { ...validFlowRun(), parentIssueNumber: 0 }
    const { errors } = validateFlowRun(obj)
    expect(errors.some(e => e.path === "parentIssueNumber")).toBe(true)
  })

  it("rejects negative revision", () => {
    const obj = { ...validFlowRun(), revision: -1 }
    const { errors } = validateFlowRun(obj)
    expect(errors.some(e => e.path === "revision")).toBe(true)
  })

  it("rejects invalid stage status", () => {
    const obj = validFlowRun() as any
    obj.stages.requirements.status = "invalid"
    const { errors } = validateFlowRun(obj)
    expect(errors.some(e => e.path.startsWith("stages."))).toBe(true)
  })

  it("rejects missing tasks field", () => {
    const obj = { ...validFlowRun(), tasks: "not-an-object" }
    const { errors } = validateFlowRun(obj)
    expect(errors.some(e => e.path === "tasks")).toBe(true)
  })

  it("validates task status", () => {
    const obj = validFlowRun() as any
    obj.tasks = {
      "task-1": {
        id: "task-1",
        status: "invalid",
        dependsOn: [],
        expectedFiles: ["src/x.ts"],
      },
    }
    const { errors } = validateFlowRun(obj)
    expect(errors.some(e => e.path.includes("status"))).toBe(true)
  })
})

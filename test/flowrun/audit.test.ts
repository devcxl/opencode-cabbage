import { describe, it, expect } from "vitest"
import { buildStageAudit, buildMergeAudit } from "../../src/flowrun/audit.js"
import { createInitialFlowRun } from "../../src/flowrun/github.js"
import type { FlowRun, TaskState } from "../../src/flowrun/types.js"

describe("buildStageAudit", () => {
  it("includes stage info", () => {
    const run = createInitialFlowRun("flow-o/r-1", "o/r", 1) as FlowRun
    const audit = buildStageAudit(run, "requirements")
    expect(audit).toContain("requirements")
    expect(audit).toContain("pending")
  })

  it("includes check details", () => {
    const run = createInitialFlowRun("id", "r", 1) as FlowRun
    run.stages.requirements.checks = [
      { name: "prd-exists", status: "pass", evidence: [{ command: "ls docs/prd", exitCode: 0, summary: "found", timestamp: "now" }] },
    ]
    const audit = buildStageAudit(run, "requirements")
    expect(audit).toContain("prd-exists")
    expect(audit).toContain("ls docs/prd")
  })

  it("handles unknown stage", () => {
    const run = createInitialFlowRun("id", "r", 1) as FlowRun
    const audit = buildStageAudit(run, "nonexistent")
    expect(audit).toContain("not found")
  })
})

describe("buildMergeAudit", () => {
  it("includes task info and checkpoints", () => {
    const task: TaskState = {
      id: "task-1", name: "Task 1", status: "merged",
      dependsOn: [], area: "backend", expectedFiles: ["src/a.ts"],
      testCommands: ["npm test"], acceptance: "Works", parallelSafe: true,
      prNumber: 42, prCheckpoints: {
        prNumber: 42,
        localChecks: { name: "localChecks", status: "pass", evidence: [] },
        ciChecks: { name: "ciChecks", status: "pass", evidence: [] },
        reviewerApproval: { name: "reviewerApproval", status: "pass", evidence: [] },
        goalVerification: { name: "goalVerification", status: "pass", evidence: [] },
        branchProtection: { name: "branchProtection", status: "pass", evidence: [] },
        mergeResult: { name: "mergeResult", status: "pass", evidence: [] },
      },
      blockedReason: null, startedAt: "now",
    }
    const audit = buildMergeAudit(task)
    expect(audit).toContain("task-1")
    expect(audit).toContain("PR: #42")
    expect(audit).toContain("localChecks")
    expect(audit).toContain("goalVerification")
  })
})

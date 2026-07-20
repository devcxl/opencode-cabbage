import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import {
  extractFlowRunFromBody,
  replaceFlowRunInBody,
  createInitialFlowRun,
} from "../../src/flowrun/github.js"
import { CABINET_START_MARKER, CABINET_END_MARKER, CURRENT_SCHEMA_VERSION } from "../../src/flowrun/types.js"
import { validateFlowRun } from "../../src/flowrun/validator.js"

describe("extractFlowRunFromBody", () => {
  it("extracts a valid FlowRun JSON from body", () => {
    const flowRun = createInitialFlowRun("flow-owner/repo-issue-1", "owner/repo", 1)
    const block = buildBlock(flowRun)
    const body = `# Issue title\n\nSome description\n\n${block}`
    const result = extractFlowRunFromBody(body)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.flowRunId).toBe("flow-owner/repo-issue-1")
      expect(result.data.status).toBe("planned")
      // v2: 新创建的 FlowRun 不会触发迁移（已经是 v2）
      expect(result.migrated).toBe(false)
      expect(result.data.repositoryQualityPolicy.mode).toBe("off")
    }
  })

  it("returns NOT_FOUND when markers not found", () => {
    const body = "# Just a normal issue\nNo flow run here"
    const result = extractFlowRunFromBody(body)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("NOT_FOUND")
    }
  })

  it("returns INVALID_JSON when JSON is invalid", () => {
    const body = `# Issue\n\n${CABINET_START_MARKER}\n\`\`\`json\n{invalid}\n\`\`\`\n${CABINET_END_MARKER}`
    const result = extractFlowRunFromBody(body)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("INVALID_JSON")
    }
  })

  it("returns VALIDATION_FAILED when JSON fails schema validation", () => {
    const body = `# Issue\n\n${CABINET_START_MARKER}\n\`\`\`json\n{"status": "invalid"}\n\`\`\`\n${CABINET_END_MARKER}`
    const result = extractFlowRunFromBody(body)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION_FAILED")
    }
  })

  it("extracts block with surrounding content", () => {
    const flowRun = createInitialFlowRun("flow-a-b-2", "a/b", 2)
    const block = buildBlock(flowRun)
    const body = `# PRD\n\nSome content here\n\n${block}\n\n## Appendix`
    const result = extractFlowRunFromBody(body)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.data.parentIssueNumber).toBe(2)
      expect(result.data.repo).toBe("a/b")
    }
  })
})

describe("replaceFlowRunInBody", () => {
  it("replaces existing block in body", () => {
    const old = createInitialFlowRun("flow-x-y-1", "x/y", 1)
    const body = `# Issue\n\n${buildBlock(old)}\n\nFooter`
    const updated = { ...old, revision: 1, status: "running" as const }
    const newBody = replaceFlowRunInBody(body, updated)

    expect(newBody).toContain(CABINET_START_MARKER)
    expect(newBody).toContain(CABINET_END_MARKER)
    expect(newBody).toContain('"running"')
    expect(newBody).toContain("Footer")
    expect(newBody).not.toContain('"planned"')
  })

  it("appends block when no markers present", () => {
    const flowRun = createInitialFlowRun("flow-a-b-3", "a/b", 3)
    const body = "# Issue title"
    const newBody = replaceFlowRunInBody(body, flowRun)
    expect(newBody).toContain(CABINET_START_MARKER)
    expect(newBody).toContain(CABINET_END_MARKER)
    expect(newBody).toContain(flowRun.flowRunId)
  })

  it("replaces only one block when multiple markers exist", () => {
    const flowRun = createInitialFlowRun("flow-x-y-5", "x/y", 5)
    const body = `${CABINET_START_MARKER}\`\`\`json\n{"a":1}\n\`\`\`${CABINET_END_MARKER}\ndup\n${CABINET_START_MARKER}\`\`\`json\n{"b":2}\n\`\`\`${CABINET_END_MARKER}`
    const newBody = replaceFlowRunInBody(body, flowRun)
    expect(newBody).toContain(flowRun.flowRunId)
    expect(newBody).not.toContain('{"a":1}')
    expect(newBody).toContain("dup")
  })
})

describe("createInitialFlowRun", () => {
  it("creates a FlowRun with planned status", () => {
    const fr = createInitialFlowRun("flow-o/r-7", "o/r", 7)
    expect(fr.flowRunId).toBe("flow-o/r-7")
    expect(fr.repo).toBe("o/r")
    expect(fr.parentIssueNumber).toBe(7)
    expect(fr.status).toBe("planned")
    expect(fr.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(fr.revision).toBe(0)
    expect(fr.startedAt).not.toBeNull()
    expect(fr.maxRuntime).toBe(86_400_000)
    // v2
    expect(fr.repositoryQualityPolicy.mode).toBe("off")
    expect(fr.repositoryQualityPolicy.requiredChecks).toEqual([])
  })

  it("initializes all 7 stages as pending", () => {
    const fr = createInitialFlowRun("id", "r", 1)
    const stages = ["requirements", "design", "tasks", "code", "test", "review", "merge"] as const
    for (const s of stages) {
      expect(fr.stages[s].status).toBe("pending")
      expect(fr.stages[s].requiredArtifacts).toEqual([])
      expect(fr.stages[s].completedAt).toBeNull()
    }
  })

  it("initializes empty tasks", () => {
    const fr = createInitialFlowRun("id", "r", 1)
    expect(fr.tasks).toEqual({})
  })

  it("passes validation", () => {
    const fr = createInitialFlowRun("flow-o/r-10", "o/r", 10)
    const { data, errors } = validateFlowRun(fr)
    expect(errors).toHaveLength(0)
    expect(data).not.toBeNull()
  })
})

function buildBlock(flowRun: unknown): string {
  const json = JSON.stringify(flowRun, null, 2)
  return `${CABINET_START_MARKER}\n\`\`\`json\n${json}\n\`\`\`\n${CABINET_END_MARKER}`
}

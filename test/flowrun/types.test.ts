import { describe, it, expect } from "vitest"
import {
  FLOW_RUN_STAGES, FLOW_RUN_STATUSES, TASK_STATUSES, STAGE_STATUSES, CHECKPOINT_STATUSES,
  CABINET_START_MARKER, CABINET_END_MARKER, LABEL_PREFIX, FLOW_RUN_LABELS,
  CURRENT_SCHEMA_VERSION, DEFAULT_MAX_RUNTIME_MS,
} from "../../src/flowrun/types.js"

describe("constants", () => {
  it("FLOW_RUN_STAGES has 7 stages without release", () => {
    expect(FLOW_RUN_STAGES).toEqual([
      "requirements", "design", "tasks", "code", "test", "review", "merge",
    ])
  })

  it("FLOW_RUN_STATUSES defined", () => {
    expect(FLOW_RUN_STATUSES).toContain("planned")
    expect(FLOW_RUN_STATUSES).toContain("running")
    expect(FLOW_RUN_STATUSES).toContain("blocked")
    expect(FLOW_RUN_STATUSES).toContain("merging")
    expect(FLOW_RUN_STATUSES).toContain("completed")
    expect(FLOW_RUN_STATUSES).toContain("cancelled")
  })

  it("TASK_STATUSES includes merged", () => {
    expect(TASK_STATUSES).toContain("merged")
    expect(TASK_STATUSES).not.toContain("done")
  })

  it("STAGE_STATUSES defined", () => {
    expect(STAGE_STATUSES).toContain("pending")
    expect(STAGE_STATUSES).toContain("pass")
    expect(STAGE_STATUSES).toContain("failed")
    expect(STAGE_STATUSES).toContain("blocked")
  })

  it("CHECKPOINT_STATUSES defined", () => {
    expect(CHECKPOINT_STATUSES).toEqual(["pending", "pass", "fail"])
  })

  it("CURRENT_SCHEMA_VERSION is 2", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(2)
  })

  it("DEFAULT_MAX_RUNTIME_MS is 24 hours", () => {
    expect(DEFAULT_MAX_RUNTIME_MS).toBe(86_400_000)
  })

  it("markers defined", () => {
    expect(CABINET_START_MARKER).toContain("cabbage-flow-run:start")
    expect(CABINET_END_MARKER).toContain("cabbage-flow-run:end")
  })

  it("labels use cabbage: prefix", () => {
    for (const [_, label] of Object.entries(FLOW_RUN_LABELS)) {
      expect(label).toMatch(/^cabbage:/)
    }
  })

  it("LABEL_PREFIX is cabbage:", () => {
    expect(LABEL_PREFIX).toBe("cabbage:")
  })

  it("has resume label for explicit resume", () => {
    expect(FLOW_RUN_LABELS.resume).toBe("cabbage:resume")
  })
})

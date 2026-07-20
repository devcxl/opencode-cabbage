import { describe, it, expect } from "vitest"
import { migrateV1ToV2 } from "../../src/flowrun/migration.js"
import { CURRENT_SCHEMA_VERSION } from "../../src/flowrun/types.js"
import { validateFlowRun } from "../../src/flowrun/validator.js"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

function loadFixture(name: string): unknown {
  const raw = readFileSync(resolve(__dirname, "fixtures", name), "utf-8")
  return JSON.parse(raw)
}

describe("migrateV1ToV2", () => {
  // ─── 基础验证 ───

  it("rejects null / non-object", () => {
    const result = migrateV1ToV2(null)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("INVALID_JSON")
    }
  })

  it("rejects missing schemaVersion", () => {
    const result = migrateV1ToV2({ flowRunId: "test" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION_FAILED")
      expect(result.errors.some(e => e.path === "schemaVersion")).toBe(true)
    }
  })

  it("rejects non-integer schemaVersion", () => {
    const result = migrateV1ToV2({ schemaVersion: 1.5 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION_FAILED")
    }
  })

  it("rejects schemaVersion < 1", () => {
    const result = migrateV1ToV2({ schemaVersion: 0 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION_FAILED")
    }
  })

  it("rejects future schema (version > CURRENT)", () => {
    const result = migrateV1ToV2({ schemaVersion: 99 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("UNSUPPORTED_SCHEMA")
    }
  })

  it("passes through v2 unchanged", () => {
    const v2 = {
      flowRunId: "test",
      repo: "o/r",
      parentIssueNumber: 1,
      status: "planned",
      schemaVersion: CURRENT_SCHEMA_VERSION,
      revision: 0,
      stages: {
        requirements: { status: "pending", requiredArtifacts: [], checks: [], completedAt: null, evidence: [] },
        design: { status: "pending", requiredArtifacts: [], checks: [], completedAt: null, evidence: [] },
        tasks: { status: "pending", requiredArtifacts: [], checks: [], completedAt: null, evidence: [] },
        code: { status: "pending", requiredArtifacts: [], checks: [], completedAt: null, evidence: [] },
        test: { status: "pending", requiredArtifacts: [], checks: [], completedAt: null, evidence: [] },
        review: { status: "pending", requiredArtifacts: [], checks: [], completedAt: null, evidence: [] },
        merge: { status: "pending", requiredArtifacts: [], checks: [], completedAt: null, evidence: [] },
      },
      tasks: {},
      startedAt: null,
      lastTickAt: null,
      nextTickAfter: null,
      maxRuntime: 86400000,
      completedAt: null,
      repositoryQualityPolicy: { mode: "off", requiredChecks: [] },
    }
    const result = migrateV1ToV2(v2)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.migrated).toBe(false)
      expect(result.data.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    }
  })

  // ─── v1 → v2 迁移：pending Task（无 testCommands） ───

  it("migrates v1 pending task (no testCommands) to bypass + advisory", () => {
    const fixture = loadFixture("v1-task-pending.json")
    const result = migrateV1ToV2(fixture)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.migrated).toBe(true)
    const fr = result.data
    expect(fr.schemaVersion).toBe(CURRENT_SCHEMA_VERSION)
    expect(fr.repositoryQualityPolicy.mode).toBe("off")

    const task = fr.tasks["task-pending"]
    expect(task).toBeDefined()
    expect(task.acceptanceCriteria).toHaveLength(1)
    expect(task.acceptanceCriteria[0].id).toBe("legacy-1")
    expect(task.acceptanceCriteria[0].verification).toBe("manual")
    expect(task.testCommands).toHaveLength(0)
    expect(task.verifyCommands).toHaveLength(0)
    expect(task.executionBinding).toBeNull()
    expect(task.coveragePolicy).toBeNull()

    // policy
    expect(task.tddPolicy.mode).toBe("bypass")
    expect(task.tddPolicy.enforcement).toBe("advisory")
    expect(task.tddPolicy.runner).toBeNull()
    expect(task.tddPolicy.exception).not.toBeNull()
    expect(task.tddPolicy.exception!.approval.kind).toBe("legacy-migration")
    if (task.tddPolicy.exception!.approval.kind === "legacy-migration") {
      expect(task.tddPolicy.exception!.approval.fromSchemaVersion).toBe(1)
    }
    expect(task.tddPolicy.source.manifestPath).toBe("legacy:v1")
    expect(task.tddPolicy.source.revisionSha).toBe("migration:v1")

    // evidence
    expect(task.tddEvidence.status).toBe("not-recorded")
    expect(task.tddEvidence.warnings).toContain("legacy schema v1 migration: evidence not recorded")
    expect(task.tddEvidence.cycles).toHaveLength(0)
    expect(task.tddEvidence.taskStart.status).toBe("pending")

    // validation
    const { errors } = validateFlowRun(fr)
    expect(errors).toHaveLength(0)
  })

  // ─── v1 → v2 迁移：running Task（有 testCommands） ───

  it("migrates v1 running task (with testCommands) to relaxed + advisory", () => {
    const fixture = loadFixture("v1-task-running.json")
    const result = migrateV1ToV2(fixture)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.migrated).toBe(true)
    const task = result.data.tasks["task-running"]
    expect(task).toBeDefined()
    expect(task.acceptanceCriteria[0].verification).toBe("regression")
    expect(task.testCommands).toHaveLength(1)
    expect(task.testCommands[0].command).toBe("npm test -- test/module.test.ts")
    expect(task.testCommands[0].cwd).toBe(".")
    expect(task.testCommands[0].timeoutMs).toBe(120_000)
    expect(task.testCommands[0].env).toEqual({})

    expect(task.tddPolicy.mode).toBe("relaxed")
    expect(task.tddPolicy.enforcement).toBe("advisory")

    // exception: should have command-based alternative validation
    expect(task.tddPolicy.exception).not.toBeNull()
    expect(task.tddPolicy.exception!.alternativeValidation).toHaveLength(1)
    expect(task.tddPolicy.exception!.alternativeValidation[0].kind).toBe("command")

    const { errors } = validateFlowRun(result.data)
    expect(errors).toHaveLength(0)
  })

  // ─── v1 → v2 迁移：reviewing Task（有 PR checkpoints） ───

  it("migrates v1 reviewing task preserving PR checkpoints", () => {
    const fixture = loadFixture("v1-task-reviewing.json")
    const result = migrateV1ToV2(fixture)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const task = result.data.tasks["task-reviewing"]
    expect(task.status).toBe("reviewing")
    expect(task.prNumber).toBe(55)
    expect(task.prCheckpoints).not.toBeNull()

    const cp = task.prCheckpoints!
    expect(cp.prNumber).toBe(55)
    expect(cp.localChecks.status).toBe("pass")
    expect(cp.ciChecks.status).toBe("pending")
    expect(cp.tddCompliance).toBeNull()
    expect(cp.verification).toBeNull()
    expect(cp.coverage).toBeNull()
    expect(cp.qualityContractDigest).toBeNull()

    // 有多个 testCommands，验证全部被迁移
    expect(task.testCommands).toHaveLength(2)
    expect(task.testCommands[0].command).toContain("ui.test.tsx")
    expect(task.testCommands[1].command).toContain("typecheck")

    const { errors } = validateFlowRun(result.data)
    expect(errors).toHaveLength(0)
  })

  // ─── v1 → v2 迁移：merged Task ───

  it("migrates v1 merged task without retroactive enforcement", () => {
    const fixture = loadFixture("v1-task-merged.json")
    const result = migrateV1ToV2(fixture)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const task = result.data.tasks["task-merged"]
    expect(task.status).toBe("merged")
    expect(task.tddPolicy.mode).toBe("relaxed")
    expect(task.tddEvidence.status).toBe("not-recorded")

    const cp = task.prCheckpoints!
    expect(cp.mergeResult.status).toBe("pass")

    const { errors } = validateFlowRun(result.data)
    expect(errors).toHaveLength(0)
  })

  // ─── v1 → v2 迁移：complete flowrun（含 blocked + cancelled） ───

  it("migrates v1 flowrun with blocked and cancelled tasks", () => {
    const fixture = loadFixture("v1-flowrun-complete.json")
    const result = migrateV1ToV2(fixture)
    expect(result.ok).toBe(true)
    if (!result.ok) return

    const fr = result.data
    expect(Object.keys(fr.tasks)).toHaveLength(3)

    const task1 = fr.tasks["task-1"]
    expect(task1.status).toBe("running")
    expect(task1.tddPolicy.mode).toBe("relaxed")

    const task2 = fr.tasks["task-2"]
    expect(task2.status).toBe("blocked")
    expect(task2.blockedReason).toBe("Waiting for design review")
    expect(task2.tddPolicy.mode).toBe("bypass")

    const task3 = fr.tasks["task-3"]
    expect(task3.status).toBe("cancelled")
    expect(task3.tddPolicy.mode).toBe("relaxed")

    const { errors } = validateFlowRun(fr)
    expect(errors).toHaveLength(0)
  })

  // ─── 幂等性 ───

  it("is idempotent: double migration yields same result", () => {
    const fixture = loadFixture("v1-task-running.json")
    const result1 = migrateV1ToV2(fixture)
    expect(result1.ok).toBe(true)
    if (!result1.ok) return

    const result2 = migrateV1ToV2(result1.data)
    expect(result2.ok).toBe(true)
    if (!result2.ok) return

    expect(result2.migrated).toBe(false)
    expect(result2.data).toEqual(result1.data)
  })

  it("is idempotent: triple migration yields same result", () => {
    const fixture = loadFixture("v1-task-merged.json")
    const result1 = migrateV1ToV2(fixture)
    expect(result1.ok).toBe(true)
    if (!result1.ok) return

    const result2 = migrateV1ToV2(result1.data)
    expect(result2.ok).toBe(true)
    if (!result2.ok) return

    const result3 = migrateV1ToV2(result2.data)
    expect(result3.ok).toBe(true)
    if (!result3.ok) return

    expect(result3.migrated).toBe(false)
    expect(result3.data).toEqual(result1.data)
  })

  // ─── Malformed schema ───

  it("rejects malformed schema with string schemaVersion", () => {
    const result = migrateV1ToV2({ schemaVersion: "1" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION_FAILED")
    }
  })

  it("rejects negative schemaVersion", () => {
    const result = migrateV1ToV2({ schemaVersion: -1 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("VALIDATION_FAILED")
    }
  })
})

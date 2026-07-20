import { describe, it, expect } from "vitest"
import type {
  TddPolicy,
  TddEvidence,
  TddCycleEvidence,
  TddRegressionEvidence,
  FinalVerificationEvidence,
  AlternativeValidationEvidence,
  AcceptanceCriterion,
  VersionedDigest,
} from "../../src/flowrun/types.js"
import { evaluateTddCompliance } from "../../src/flowrun/evaluator.js"

// ─── 辅助工厂函数 ───

function emptyDigest(): VersionedDigest {
  return { algorithm: "sha256-content-v1", value: "abc123" }
}

function makePolicy(overrides: Partial<TddPolicy>): TddPolicy {
  return {
    mode: "strict",
    enforcement: "advisory",
    runner: null,
    testFilePatterns: [],
    implementationFilePatterns: [],
    generatedArtifactPatterns: [],
    exception: null,
    source: { manifestPath: "test/manifest.yml", revisionSha: "sha1" },
    ...overrides,
  }
}

function makeEvidence(overrides: Partial<TddEvidence> = {}): TddEvidence {
  return {
    revision: 1,
    reworkRevision: 0,
    status: "in-progress",
    taskStart: { status: "pass", headSha: "head1", treeSha: "tree1", startedAt: "2026-01-01T00:00:00Z" },
    cycles: [],
    regression: { status: "pending", headSha: null, treeSha: null, reworkRevision: 0, runs: [] },
    verification: { status: "pending", headSha: null, treeSha: null, runs: [] },
    alternativeValidation: [],
    reworks: [],
    warnings: [],
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  }
}

function makeCycle(criterionId: string, status: TddCycleEvidence["status"] = "pass"): TddCycleEvidence {
  return {
    cycleId: `cycle-${criterionId}`,
    criterionId,
    reworkRevision: 0,
    status,
    startWorkspaceDigest: emptyDigest(),
    testFiles: [],
    redTestDigest: emptyDigest(),
    redAttempts: [],
    greenAttempts: [],
  }
}

function makeRegression(status: TddRegressionEvidence["status"] = "pass"): TddRegressionEvidence {
  return {
    status,
    headSha: "head1",
    treeSha: "tree1",
    reworkRevision: 0,
    runs: [],
  }
}

function makeVerification(status: FinalVerificationEvidence["status"] = "pass"): FinalVerificationEvidence {
  return { status, headSha: "head1", treeSha: "tree1", runs: [] }
}

function makeAltEvidence(validationId: string, status: "pass" | "fail" = "pass"): AlternativeValidationEvidence {
  return {
    validationId,
    kind: "command",
    status,
    headSha: "head1",
    treeSha: "tree1",
    reworkRevision: 0,
    evidence: {
      command: "test",
      testSelector: null,
      exitCode: 0,
      failureKind: null,
      testsCollected: 1,
      testsFailed: 0,
      startedAt: "2026-01-01T00:00:00Z",
      finishedAt: "2026-01-01T00:00:01Z",
      durationMs: 1000,
      changedFiles: [],
      outputDigest: emptyDigest(),
      workspaceDigest: emptyDigest(),
      executionInputDigest: emptyDigest(),
      summary: "ok",
    },
  }
}

const tddCriterion: AcceptanceCriterion = { id: "AC-1", description: "tdd test", verification: "tdd" }
const regressionCriterion: AcceptanceCriterion = { id: "AC-2", description: "regression test", verification: "regression" }
const manualCriterion: AcceptanceCriterion = { id: "AC-3", description: "manual test", verification: "manual" }

// ─── 测试 ───

describe("evaluateTddCompliance", () => {
  // ── 基础类型安全 ──

  it("returns a well-structured result", () => {
    const policy = makePolicy({ mode: "strict", enforcement: "advisory" })
    const evidence = makeEvidence({
      cycles: [makeCycle("AC-1")],
      regression: makeRegression(),
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [tddCriterion])
    expect(result).toHaveProperty("status")
    expect(result).toHaveProperty("warnings")
    expect(["pass", "fail", "waived"]).toContain(result.status)
    expect(Array.isArray(result.warnings)).toBe(true)
  })

  // ── strict + advisory ──

  it("strict + advisory + all cycles pass → pass with no warnings", () => {
    const policy = makePolicy({ mode: "strict", enforcement: "advisory" })
    const evidence = makeEvidence({
      cycles: [makeCycle("AC-1")],
      regression: makeRegression(),
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [tddCriterion, regressionCriterion])
    expect(result.status).toBe("pass")
    expect(result.warnings).toEqual([])
  })

  it("strict + advisory + missing cycle → pass with warnings", () => {
    const policy = makePolicy({ mode: "strict", enforcement: "advisory" })
    const evidence = makeEvidence({
      cycles: [],
      regression: makeRegression(),
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [tddCriterion])
    expect(result.status).toBe("pass")
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings.some((w: string) => w.includes("AC-1"))).toBe(true)
  })

  it("strict + advisory + regression fail → pass with warnings", () => {
    const policy = makePolicy({ mode: "strict", enforcement: "advisory" })
    const evidence = makeEvidence({
      cycles: [makeCycle("AC-1")],
      regression: makeRegression("fail"),
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [tddCriterion, regressionCriterion])
    expect(result.status).toBe("pass")
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it("strict + advisory + verification fail → pass with warnings", () => {
    const policy = makePolicy({ mode: "strict", enforcement: "advisory" })
    const evidence = makeEvidence({
      cycles: [makeCycle("AC-1")],
      regression: makeRegression(),
      verification: makeVerification("fail"),
    })
    const result = evaluateTddCompliance(policy, evidence, [tddCriterion])
    expect(result.status).toBe("pass")
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  // ── strict + runtime ──

  it("strict + runtime + all criteria covered → pass", () => {
    const policy = makePolicy({ mode: "strict", enforcement: "runtime" })
    const evidence = makeEvidence({
      cycles: [makeCycle("AC-1")],
      regression: makeRegression(),
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [tddCriterion, regressionCriterion])
    expect(result.status).toBe("pass")
    expect(result.warnings).toEqual([])
  })

  it("strict + runtime + missing cycle for TDD criterion → fail", () => {
    const policy = makePolicy({ mode: "strict", enforcement: "runtime" })
    const evidence = makeEvidence({
      cycles: [],
      regression: makeRegression(),
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [tddCriterion])
    expect(result.status).toBe("fail")
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it("strict + runtime + failed cycle → fail", () => {
    const policy = makePolicy({ mode: "strict", enforcement: "runtime" })
    const evidence = makeEvidence({
      cycles: [makeCycle("AC-1", "failed")],
      regression: makeRegression(),
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [tddCriterion])
    expect(result.status).toBe("fail")
  })

  it("strict + runtime + abandoned cycle → fail", () => {
    const policy = makePolicy({ mode: "strict", enforcement: "runtime" })
    const evidence = makeEvidence({
      cycles: [makeCycle("AC-1", "abandoned")],
      regression: makeRegression(),
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [tddCriterion])
    expect(result.status).toBe("fail")
  })

  it("strict + runtime + regression fail → fail", () => {
    const policy = makePolicy({ mode: "strict", enforcement: "runtime" })
    const evidence = makeEvidence({
      cycles: [makeCycle("AC-1")],
      regression: makeRegression("fail"),
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [tddCriterion, regressionCriterion])
    expect(result.status).toBe("fail")
  })

  it("strict + runtime + verification fail → fail", () => {
    const policy = makePolicy({ mode: "strict", enforcement: "runtime" })
    const evidence = makeEvidence({
      cycles: [makeCycle("AC-1")],
      regression: makeRegression(),
      verification: makeVerification("fail"),
    })
    const result = evaluateTddCompliance(policy, evidence, [tddCriterion])
    expect(result.status).toBe("fail")
  })

  it("strict + runtime + multiple TDD criteria, one uncovered → fail", () => {
    const policy = makePolicy({ mode: "strict", enforcement: "runtime" })
    const criterion2: AcceptanceCriterion = { id: "AC-2", description: "second tdd", verification: "tdd" }
    const evidence = makeEvidence({
      cycles: [makeCycle("AC-1")],
      regression: makeRegression(),
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [tddCriterion, criterion2])
    expect(result.status).toBe("fail")
  })

  it("strict + runtime + multiple TDD criteria, all covered → pass", () => {
    const policy = makePolicy({ mode: "strict", enforcement: "runtime" })
    const criterion2: AcceptanceCriterion = { id: "AC-2", description: "second tdd", verification: "tdd" }
    const evidence = makeEvidence({
      cycles: [makeCycle("AC-1"), makeCycle("AC-2")],
      regression: makeRegression(),
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [tddCriterion, criterion2])
    expect(result.status).toBe("pass")
  })

  // ── strict: no TDD criteria → fail ──

  it("strict + runtime + no TDD criteria → fail", () => {
    const policy = makePolicy({ mode: "strict", enforcement: "runtime" })
    const evidence = makeEvidence({
      cycles: [],
      regression: makeRegression(),
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [regressionCriterion])
    expect(result.status).toBe("fail")
  })

  // ── strict: manual criterion not allowed ──

  it("strict + runtime + has manual criterion → fail", () => {
    const policy = makePolicy({ mode: "strict", enforcement: "runtime" })
    const evidence = makeEvidence({
      cycles: [makeCycle("AC-1")],
      regression: makeRegression(),
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [tddCriterion, manualCriterion])
    expect(result.status).toBe("fail")
  })

  // ── relaxed + advisory ──

  it("relaxed + advisory + regression pass → pass (no cycles needed)", () => {
    const policy = makePolicy({ mode: "relaxed", enforcement: "advisory" })
    const evidence = makeEvidence({
      cycles: [],
      regression: makeRegression(),
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [tddCriterion, regressionCriterion])
    expect(result.status).toBe("pass")
    expect(result.warnings).toEqual([])
  })

  it("relaxed + advisory + regression fail → pass with warnings", () => {
    const policy = makePolicy({ mode: "relaxed", enforcement: "advisory" })
    const evidence = makeEvidence({
      cycles: [],
      regression: makeRegression("fail"),
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [regressionCriterion])
    expect(result.status).toBe("pass")
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it("relaxed + advisory + pending regression → pass with warnings", () => {
    const policy = makePolicy({ mode: "relaxed", enforcement: "advisory" })
    const evidence = makeEvidence({
      cycles: [],
      regression: { status: "pending", headSha: null, treeSha: null, reworkRevision: 0, runs: [] },
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [regressionCriterion])
    expect(result.status).toBe("pass")
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  // ── relaxed + runtime ──

  it("relaxed + runtime + regression pass → pass", () => {
    const policy = makePolicy({ mode: "relaxed", enforcement: "runtime" })
    const evidence = makeEvidence({
      cycles: [],
      regression: makeRegression(),
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [regressionCriterion])
    expect(result.status).toBe("pass")
  })

  it("relaxed + runtime + regression fail → fail", () => {
    const policy = makePolicy({ mode: "relaxed", enforcement: "runtime" })
    const evidence = makeEvidence({
      cycles: [],
      regression: makeRegression("fail"),
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [regressionCriterion])
    expect(result.status).toBe("fail")
  })

  it("relaxed + runtime + pending regression → fail", () => {
    const policy = makePolicy({ mode: "relaxed", enforcement: "runtime" })
    const evidence = makeEvidence({
      cycles: [],
      regression: { status: "pending", headSha: null, treeSha: null, reworkRevision: 0, runs: [] },
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [regressionCriterion])
    expect(result.status).toBe("fail")
  })

  it("relaxed + runtime + verification fail → fail", () => {
    const policy = makePolicy({ mode: "relaxed", enforcement: "runtime" })
    const evidence = makeEvidence({
      cycles: [],
      regression: makeRegression(),
      verification: makeVerification("fail"),
    })
    const result = evaluateTddCompliance(policy, evidence, [regressionCriterion])
    expect(result.status).toBe("fail")
  })

  // ── bypass + advisory ──

  it("bypass + advisory + all alt validations done → waived", () => {
    const policy = makePolicy({
      mode: "bypass",
      enforcement: "advisory",
      exception: {
        reason: "visual only",
        alternativeValidation: [{ validationId: "ALT-1", kind: "command", command: { command: "lint", cwd: ".", timeoutMs: 10000, env: {} } }],
        approval: { kind: "legacy-migration", fromSchemaVersion: 1 },
      },
    })
    const evidence = makeEvidence({
      cycles: [],
      regression: { status: "skipped", headSha: null, treeSha: null, reworkRevision: 0, runs: [] },
      verification: makeVerification(),
      alternativeValidation: [makeAltEvidence("ALT-1")],
    })
    const result = evaluateTddCompliance(policy, evidence, [manualCriterion])
    expect(result.status).toBe("waived")
  })

  it("bypass + advisory + missing alt validation → waived with warnings", () => {
    const policy = makePolicy({
      mode: "bypass",
      enforcement: "advisory",
      exception: {
        reason: "visual only",
        alternativeValidation: [{ validationId: "ALT-1", kind: "command", command: { command: "lint", cwd: ".", timeoutMs: 10000, env: {} } }],
        approval: { kind: "legacy-migration", fromSchemaVersion: 1 },
      },
    })
    const evidence = makeEvidence({
      cycles: [],
      regression: { status: "skipped", headSha: null, treeSha: null, reworkRevision: 0, runs: [] },
      verification: makeVerification(),
      alternativeValidation: [],
    })
    const result = evaluateTddCompliance(policy, evidence, [manualCriterion])
    expect(result.status).toBe("waived")
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  // ── bypass + runtime ──

  it("bypass + runtime + all alt validations done → waived", () => {
    const policy = makePolicy({
      mode: "bypass",
      enforcement: "runtime",
      exception: {
        reason: "visual only",
        alternativeValidation: [{ validationId: "ALT-1", kind: "command", command: { command: "lint", cwd: ".", timeoutMs: 10000, env: {} } }],
        approval: { kind: "legacy-migration", fromSchemaVersion: 1 },
      },
    })
    const evidence = makeEvidence({
      cycles: [],
      regression: { status: "skipped", headSha: null, treeSha: null, reworkRevision: 0, runs: [] },
      verification: makeVerification(),
      alternativeValidation: [makeAltEvidence("ALT-1")],
    })
    const result = evaluateTddCompliance(policy, evidence, [manualCriterion])
    expect(result.status).toBe("waived")
  })

  it("bypass + runtime + missing alt validation → fail", () => {
    const policy = makePolicy({
      mode: "bypass",
      enforcement: "runtime",
      exception: {
        reason: "visual only",
        alternativeValidation: [{ validationId: "ALT-1", kind: "command", command: { command: "lint", cwd: ".", timeoutMs: 10000, env: {} } }],
        approval: { kind: "legacy-migration", fromSchemaVersion: 1 },
      },
    })
    const evidence = makeEvidence({
      cycles: [],
      regression: { status: "skipped", headSha: null, treeSha: null, reworkRevision: 0, runs: [] },
      verification: makeVerification(),
      alternativeValidation: [],
    })
    const result = evaluateTddCompliance(policy, evidence, [manualCriterion])
    expect(result.status).toBe("fail")
  })

  it("bypass + runtime + failed alt validation → fail", () => {
    const policy = makePolicy({
      mode: "bypass",
      enforcement: "runtime",
      exception: {
        reason: "visual only",
        alternativeValidation: [{ validationId: "ALT-1", kind: "command", command: { command: "lint", cwd: ".", timeoutMs: 10000, env: {} } }],
        approval: { kind: "legacy-migration", fromSchemaVersion: 1 },
      },
    })
    const evidence = makeEvidence({
      cycles: [],
      regression: { status: "skipped", headSha: null, treeSha: null, reworkRevision: 0, runs: [] },
      verification: makeVerification(),
      alternativeValidation: [makeAltEvidence("ALT-1", "fail")],
    })
    const result = evaluateTddCompliance(policy, evidence, [manualCriterion])
    expect(result.status).toBe("fail")
  })

  it("bypass + runtime + no exception → fail", () => {
    const policy = makePolicy({ mode: "bypass", enforcement: "runtime" })
    const evidence = makeEvidence({
      cycles: [],
      regression: { status: "skipped", headSha: null, treeSha: null, reworkRevision: 0, runs: [] },
      verification: makeVerification(),
      alternativeValidation: [],
    })
    const result = evaluateTddCompliance(policy, evidence, [manualCriterion])
    expect(result.status).toBe("fail")
  })

  // ── bypass: verification must still pass ──

  it("bypass + runtime + verification fail → fail", () => {
    const policy = makePolicy({
      mode: "bypass",
      enforcement: "runtime",
      exception: {
        reason: "visual only",
        alternativeValidation: [{ validationId: "ALT-1", kind: "command", command: { command: "lint", cwd: ".", timeoutMs: 10000, env: {} } }],
        approval: { kind: "legacy-migration", fromSchemaVersion: 1 },
      },
    })
    const evidence = makeEvidence({
      cycles: [],
      regression: { status: "skipped", headSha: null, treeSha: null, reworkRevision: 0, runs: [] },
      verification: makeVerification("fail"),
      alternativeValidation: [makeAltEvidence("ALT-1")],
    })
    const result = evaluateTddCompliance(policy, evidence, [manualCriterion])
    expect(result.status).toBe("fail")
  })

  // ── empty criteria array ──

  it("strict + runtime + empty criteria → fail", () => {
    const policy = makePolicy({ mode: "strict", enforcement: "runtime" })
    const evidence = makeEvidence({
      cycles: [],
      regression: makeRegression(),
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [])
    expect(result.status).toBe("fail")
  })

  // ── relaxed mode: no regression criteria needed, just checks regression evidence ──

  it("relaxed + runtime + regression pass + no criteria → pass", () => {
    const policy = makePolicy({ mode: "relaxed", enforcement: "runtime" })
    const evidence = makeEvidence({
      cycles: [],
      regression: makeRegression(),
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [])
    expect(result.status).toBe("pass")
  })

  // ── strict + advisory + all pass → no warnings ──

  it("strict + advisory + perfect evidence → pass with no warnings", () => {
    const policy = makePolicy({ mode: "strict", enforcement: "advisory" })
    const evidence = makeEvidence({
      cycles: [makeCycle("AC-1")],
      regression: makeRegression(),
      verification: makeVerification(),
    })
    const result = evaluateTddCompliance(policy, evidence, [tddCriterion])
    expect(result.status).toBe("pass")
    expect(result.warnings).toEqual([])
  })

  // ── relaxed + advisory + verification fail → warnings ──

  it("relaxed + advisory + verification fail → pass with warnings", () => {
    const policy = makePolicy({ mode: "relaxed", enforcement: "advisory" })
    const evidence = makeEvidence({
      cycles: [],
      regression: makeRegression(),
      verification: makeVerification("fail"),
    })
    const result = evaluateTddCompliance(policy, evidence, [regressionCriterion])
    expect(result.status).toBe("pass")
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  // ── bypass: no criteria needed ──

  it("bypass + runtime + all alt validations done + no criteria → waived", () => {
    const policy = makePolicy({
      mode: "bypass",
      enforcement: "runtime",
      exception: {
        reason: "visual only",
        alternativeValidation: [{ validationId: "ALT-1", kind: "command", command: { command: "lint", cwd: ".", timeoutMs: 10000, env: {} } }],
        approval: { kind: "legacy-migration", fromSchemaVersion: 1 },
      },
    })
    const evidence = makeEvidence({
      cycles: [],
      regression: { status: "skipped", headSha: null, treeSha: null, reworkRevision: 0, runs: [] },
      verification: makeVerification(),
      alternativeValidation: [makeAltEvidence("ALT-1")],
    })
    const result = evaluateTddCompliance(policy, evidence, [])
    expect(result.status).toBe("waived")
  })
})

import { describe, it, expect } from "vitest"
import type {
  TddEvidence,
  TddCycleEvidence,
  TddCommandEvidence,
  AcceptanceCriterion,
  VersionedDigest,
} from "../../src/flowrun/types.js"
import {
  createTaskEvidence,
  startCycle,
  recordRed,
  recordGreen,
  recordFinalRegression,
  recordFinalVerification,
  abandonCycle,
} from "../../src/flowrun/state.js"

// ─── 辅助工厂 ───

function emptyDigest(algorithm?: VersionedDigest["algorithm"]): VersionedDigest {
  return { algorithm: algorithm ?? "sha256-content-v1", value: "a".repeat(64) }
}

function makeCycleEvidence(overrides: Partial<TddCycleEvidence> = {}): TddCycleEvidence {
  return {
    cycleId: "cycle-1",
    criterionId: "AC-1",
    reworkRevision: 0,
    status: "started",
    startWorkspaceDigest: emptyDigest(),
    testFiles: ["test/foo.test.ts"],
    redTestDigest: null,
    redAttempts: [],
    greenAttempts: [],
    ...overrides,
  }
}

function makeCommandEvidence(overrides: Partial<TddCommandEvidence> = {}): TddCommandEvidence {
  return {
    command: "npx vitest run test/foo.test.ts",
    testSelector: "test/foo.test.ts",
    exitCode: 1,
    failureKind: "assertion",
    testsCollected: 3,
    testsFailed: 1,
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:01Z",
    durationMs: 1000,
    changedFiles: ["test/foo.test.ts"],
    outputDigest: emptyDigest("sha256-output-v1"),
    workspaceDigest: emptyDigest(),
    executionInputDigest: emptyDigest(),
    summary: "1/3 tests failed",
    ...overrides,
  }
}

function passingEvidence(): TddCommandEvidence {
  return makeCommandEvidence({
    exitCode: 0,
    failureKind: null,
    testsFailed: 0,
    summary: "3/3 tests passed",
  })
}

const tddCriterion: AcceptanceCriterion = { id: "AC-1", description: "TDD test", verification: "tdd" }
const regressionCriterion: AcceptanceCriterion = { id: "AC-2", description: "regression", verification: "regression" }

const testFilePatterns = ["test/**/*.test.ts"]

// ─── createTaskEvidence ───

describe("createTaskEvidence", () => {
  it("returns initialized TddEvidence with revision=0 and status=not-recorded", () => {
    const evidence = createTaskEvidence()
    expect(evidence.revision).toBe(0)
    expect(evidence.status).toBe("not-recorded")
    expect(evidence.cycles).toEqual([])
    expect(evidence.taskStart.status).toBe("pending")
    expect(evidence.regression.status).toBe("pending")
    expect(evidence.verification.status).toBe("pending")
    expect(evidence.warnings).toEqual([])
    expect(evidence.updatedAt).toBeNull()
  })
})

// ─── startCycle ───

describe("startCycle", () => {
  it("creates a new cycle and adds it to evidence", () => {
    const evidence = createTaskEvidence()
    const result = startCycle(
      evidence,
      "cycle-1",
      "AC-1",
      ["test/foo.test.ts"],
      "test/foo.test.ts",
      emptyDigest(),
      [tddCriterion],
      testFilePatterns,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")

    const { evidence: newEvidence, cycle } = result.value
    expect(cycle.cycleId).toBe("cycle-1")
    expect(cycle.criterionId).toBe("AC-1")
    expect(cycle.status).toBe("started")
    expect(cycle.testFiles).toEqual(["test/foo.test.ts"])
    expect(cycle.redTestDigest).toBeNull()
    expect(cycle.redAttempts).toEqual([])
    expect(cycle.greenAttempts).toEqual([])

    expect(newEvidence.cycles).toHaveLength(1)
    expect(newEvidence.cycles[0].cycleId).toBe("cycle-1")
    expect(newEvidence.revision).toBe(evidence.revision + 1)
  })

  it("sets evidence status to in-progress on first cycle", () => {
    const evidence = createTaskEvidence()
    const result = startCycle(
      evidence,
      "cycle-1",
      "AC-1",
      ["test/foo.test.ts"],
      "test/foo.test.ts",
      emptyDigest(),
      [tddCriterion],
      testFilePatterns,
    )

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.value.evidence.status).toBe("in-progress")
  })

  it("fails when criterion does not exist", () => {
    const evidence = createTaskEvidence()
    const result = startCycle(
      evidence,
      "cycle-1",
      "NONEXISTENT",
      ["test/foo.test.ts"],
      "test/foo.test.ts",
      emptyDigest(),
      [tddCriterion],
      testFilePatterns,
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error.code).toBe("CRITERION_NOT_FOUND")
  })

  it("fails when criterion is not verification=tdd", () => {
    const evidence = createTaskEvidence()
    const result = startCycle(
      evidence,
      "cycle-1",
      "AC-2",
      ["test/foo.test.ts"],
      "test/foo.test.ts",
      emptyDigest(),
      [regressionCriterion],
      testFilePatterns,
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error.code).toBe("CRITERION_NOT_FOUND")
  })

  it("fails when testPaths do not match testFilePatterns", () => {
    const evidence = createTaskEvidence()
    const result = startCycle(
      evidence,
      "cycle-1",
      "AC-1",
      ["src/foo.ts"], // implementation file, not test pattern
      "test/foo.test.ts",
      emptyDigest(),
      [tddCriterion],
      testFilePatterns,
    )

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error.code).toBe("POLICY_INVALID")
  })

  it("is idempotent — same cycleId and workspace digest returns existing cycle", () => {
    const evidence = createTaskEvidence()
    const wsDigest = emptyDigest()

    const r1 = startCycle(
      evidence,
      "cycle-1",
      "AC-1",
      ["test/foo.test.ts"],
      "test/foo.test.ts",
      wsDigest,
      [tddCriterion],
      testFilePatterns,
    )
    expect(r1.ok).toBe(true)
    if (!r1.ok) throw new Error("expected ok")

    // Same call again with same workspace digest
    const r2 = startCycle(
      r1.value.evidence,
      "cycle-1",
      "AC-1",
      ["test/foo.test.ts"],
      "test/foo.test.ts",
      wsDigest,
      [tddCriterion],
      testFilePatterns,
    )

    expect(r2.ok).toBe(true)
    if (!r2.ok) throw new Error("expected ok")
    // Should return the SAME evidence object (no revision change)
    expect(r2.value.evidence).toBe(r1.value.evidence)
    expect(r2.value.evidence.revision).toBe(r1.value.evidence.revision)
  })

  it("fails with CYCLE_CONFLICT when same cycleId but different params", () => {
    const evidence = createTaskEvidence()
    const wsDigest1 = emptyDigest()

    const r1 = startCycle(
      evidence,
      "cycle-1",
      "AC-1",
      ["test/foo.test.ts"],
      "test/foo.test.ts",
      wsDigest1,
      [tddCriterion],
      testFilePatterns,
    )
    expect(r1.ok).toBe(true)
    if (!r1.ok) throw new Error("expected ok")

    const wsDigest2 = { algorithm: "sha256-content-v1" as const, value: "b".repeat(64) }
    const r2 = startCycle(
      r1.value.evidence,
      "cycle-1",
      "AC-1",
      ["test/foo.test.ts"],
      "test/foo.test.ts",
      wsDigest2, // different workspace digest
      [tddCriterion],
      testFilePatterns,
    )

    expect(r2.ok).toBe(false)
    if (r2.ok) throw new Error("expected error")
    expect(r2.error.code).toBe("CYCLE_CONFLICT")
  })
})

// ─── recordRed ───

describe("recordRed", () => {
  it("records a RED attempt and advances cycle status to red", () => {
    const evidence = createTaskEvidence()
    const startResult = startCycle(
      evidence,
      "cycle-1",
      "AC-1",
      ["test/foo.test.ts"],
      "test/foo.test.ts",
      emptyDigest(),
      [tddCriterion],
      testFilePatterns,
    )
    if (!startResult.ok) throw new Error("expected ok")

    const redEvidence = makeCommandEvidence({
      failureKind: "assertion",
      exitCode: 1,
      changedFiles: ["test/foo.test.ts"],
    })
    const result = recordRed(startResult.value.evidence, "cycle-1", redEvidence)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")

    const { evidence: newEvidence, cycle } = result.value
    expect(cycle.status).toBe("red")
    expect(cycle.redAttempts).toHaveLength(1)
    expect(cycle.redAttempts[0].failureKind).toBe("assertion")
    expect(cycle.redTestDigest).toBe(redEvidence.executionInputDigest)
    expect(newEvidence.revision).toBeGreaterThan(startResult.value.evidence.revision)
  })

  it("rejects when RED passes (exitCode 0)", () => {
    const evidence = createTaskEvidence()
    const startResult = startCycle(
      evidence, "cycle-1", "AC-1",
      ["test/foo.test.ts"], "test/foo.test.ts", emptyDigest(),
      [tddCriterion], testFilePatterns,
    )
    if (!startResult.ok) throw new Error("expected ok")

    const redEvidence = makeCommandEvidence({ exitCode: 0, failureKind: null, testsFailed: 0 })
    const result = recordRed(startResult.value.evidence, "cycle-1", redEvidence)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error.code).toBe("RED_EXPECTED_FAILURE")
  })

  it("rejects infrastructure failures as RED", () => {
    const evidence = createTaskEvidence()
    const startResult = startCycle(
      evidence, "cycle-1", "AC-1",
      ["test/foo.test.ts"], "test/foo.test.ts", emptyDigest(),
      [tddCriterion], testFilePatterns,
    )
    if (!startResult.ok) throw new Error("expected ok")

    const redEvidence = makeCommandEvidence({ failureKind: "infrastructure", exitCode: 1 })
    const result = recordRed(startResult.value.evidence, "cycle-1", redEvidence)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error.code).toBe("RED_INFRASTRUCTURE_FAILURE")
  })

  it("rejects timeout as RED", () => {
    const evidence = createTaskEvidence()
    const startResult = startCycle(
      evidence, "cycle-1", "AC-1",
      ["test/foo.test.ts"], "test/foo.test.ts", emptyDigest(),
      [tddCriterion], testFilePatterns,
    )
    if (!startResult.ok) throw new Error("expected ok")

    const redEvidence = makeCommandEvidence({ failureKind: "timeout", exitCode: null })
    const result = recordRed(startResult.value.evidence, "cycle-1", redEvidence)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error.code).toBe("COMMAND_TIMEOUT")
  })

  it("rejects unknown failure as RED", () => {
    const evidence = createTaskEvidence()
    const startResult = startCycle(
      evidence, "cycle-1", "AC-1",
      ["test/foo.test.ts"], "test/foo.test.ts", emptyDigest(),
      [tddCriterion], testFilePatterns,
    )
    if (!startResult.ok) throw new Error("expected ok")

    const redEvidence = makeCommandEvidence({ failureKind: "unknown", exitCode: 1 })
    const result = recordRed(startResult.value.evidence, "cycle-1", redEvidence)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error.code).toBe("RED_INFRASTRUCTURE_FAILURE")
  })

  it("accepts missing-behavior as valid RED", () => {
    const evidence = createTaskEvidence()
    const startResult = startCycle(
      evidence, "cycle-1", "AC-1",
      ["test/foo.test.ts"], "test/foo.test.ts", emptyDigest(),
      [tddCriterion], testFilePatterns,
    )
    if (!startResult.ok) throw new Error("expected ok")

    const redEvidence = makeCommandEvidence({ failureKind: "missing-behavior", exitCode: 1, testsCollected: 0 })
    const result = recordRed(startResult.value.evidence, "cycle-1", redEvidence)

    expect(result.ok).toBe(true)
  })

  it("allows multiple RED attempts (retry on flaky test config)", () => {
    const evidence = createTaskEvidence()
    const startResult = startCycle(
      evidence, "cycle-1", "AC-1",
      ["test/foo.test.ts"], "test/foo.test.ts", emptyDigest(),
      [tddCriterion], testFilePatterns,
    )
    if (!startResult.ok) throw new Error("expected ok")

    const red1 = makeCommandEvidence({ failureKind: "infrastructure", exitCode: 1 })
    // infrastructure is rejected, not stored in redAttempts
    const r1 = recordRed(startResult.value.evidence, "cycle-1", red1)
    expect(r1.ok).toBe(false)

    const red2 = makeCommandEvidence({ failureKind: "assertion", exitCode: 1 })
    const r2 = recordRed(startResult.value.evidence, "cycle-1", red2)
    expect(r2.ok).toBe(true)
    if (!r2.ok) throw new Error("expected ok")

    // Another assertion attempt (e.g., test adjusted)
    const red3 = makeCommandEvidence({
      failureKind: "assertion",
      exitCode: 1,
      outputDigest: emptyDigest("sha256-output-v1"),
    })
    // Override to have different output
    red3.outputDigest = { algorithm: "sha256-output-v1", value: "b".repeat(64) }
    const r3 = recordRed(r2.value.evidence, "cycle-1", red3)
    expect(r3.ok).toBe(true)
    if (!r3.ok) throw new Error("expected ok")
    expect(r3.value.cycle.redAttempts).toHaveLength(2)
    // redTestDigest should update to the latest valid RED
  })

  it("is idempotent for same RED evidence", () => {
    const evidence = createTaskEvidence()
    const startResult = startCycle(
      evidence, "cycle-1", "AC-1",
      ["test/foo.test.ts"], "test/foo.test.ts", emptyDigest(),
      [tddCriterion], testFilePatterns,
    )
    if (!startResult.ok) throw new Error("expected ok")

    const redEvidence = makeCommandEvidence()
    const r1 = recordRed(startResult.value.evidence, "cycle-1", redEvidence)
    expect(r1.ok).toBe(true)
    if (!r1.ok) throw new Error("expected ok")

    const r2 = recordRed(r1.value.evidence, "cycle-1", redEvidence)
    expect(r2.ok).toBe(true)
    if (!r2.ok) throw new Error("expected ok")
    // Same evidence, should be same state (same revision)
    expect(r2.value.evidence).toBe(r1.value.evidence)
    expect(r2.value.cycle).toBe(r1.value.cycle)
  })

  it("fails when cycle does not exist", () => {
    const evidence = createTaskEvidence()
    const result = recordRed(evidence, "nonexistent", makeCommandEvidence())

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error.code).toBe("CYCLE_CONFLICT")
  })
})

// ─── recordGreen ───

describe("recordGreen", () => {
  function setupWithRed(): { evidence: TddEvidence } {
    const evidence = createTaskEvidence()
    const startResult = startCycle(
      evidence, "cycle-1", "AC-1",
      ["test/foo.test.ts"], "test/foo.test.ts", emptyDigest(),
      [tddCriterion], testFilePatterns,
    )
    if (!startResult.ok) throw new Error("expected ok")

    const redEvidence = makeCommandEvidence()
    const redResult = recordRed(startResult.value.evidence, "cycle-1", redEvidence)
    if (!redResult.ok) throw new Error("expected ok")

    return { evidence: redResult.value.evidence }
  }

  it("records GREEN and marks cycle as pass", () => {
    const { evidence } = setupWithRed()
    const greenEvidence = passingEvidence()
    greenEvidence.changedFiles = ["src/foo.ts"] // implementation change

    const result = recordGreen(evidence, "cycle-1", greenEvidence, true)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")

    const { evidence: newEvidence, cycle } = result.value
    expect(cycle.status).toBe("pass")
    expect(cycle.greenAttempts).toHaveLength(1)
    expect(cycle.greenAttempts[0].exitCode).toBe(0)
    expect(newEvidence.revision).toBeGreaterThan(evidence.revision)
  })

  it("rejects GREEN when no RED has been recorded", () => {
    const evidence = createTaskEvidence()
    const startResult = startCycle(
      evidence, "cycle-1", "AC-1",
      ["test/foo.test.ts"], "test/foo.test.ts", emptyDigest(),
      [tddCriterion], testFilePatterns,
    )
    if (!startResult.ok) throw new Error("expected ok")

    const greenEvidence = passingEvidence()
    const result = recordGreen(startResult.value.evidence, "cycle-1", greenEvidence, true)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error.code).toBe("INVALID_TRANSITION")
  })

  it("rejects GREEN when GREEN test still fails", () => {
    const { evidence } = setupWithRed()
    const greenEvidence = makeCommandEvidence({ exitCode: 1, failureKind: "assertion" })
    greenEvidence.changedFiles = ["src/foo.ts"]

    const result = recordGreen(evidence, "cycle-1", greenEvidence, true)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error.code).toBe("GREEN_EXPECTED_PASS")
  })

  it("rejects GREEN when no implementation files changed", () => {
    const { evidence } = setupWithRed()
    const greenEvidence = passingEvidence()

    const result = recordGreen(evidence, "cycle-1", greenEvidence, false)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error.code).toBe("IMPLEMENTATION_CHANGE_REQUIRED")
  })

  it("is idempotent for same GREEN evidence", () => {
    const { evidence } = setupWithRed()
    const greenEvidence = passingEvidence()
    greenEvidence.changedFiles = ["src/foo.ts"]

    const r1 = recordGreen(evidence, "cycle-1", greenEvidence, true)
    expect(r1.ok).toBe(true)
    if (!r1.ok) throw new Error("expected ok")

    const r2 = recordGreen(r1.value.evidence, "cycle-1", greenEvidence, true)
    expect(r2.ok).toBe(true)
    if (!r2.ok) throw new Error("expected ok")
    expect(r2.value.evidence).toBe(r1.value.evidence)
  })

  it("allows GREEN retries after failed GREEN attempt", () => {
    const { evidence } = setupWithRed()
    const failedGreen = makeCommandEvidence({ exitCode: 1, failureKind: "assertion" })
    failedGreen.changedFiles = ["src/foo.ts"]

    const r1 = recordGreen(evidence, "cycle-1", failedGreen, true)
    expect(r1.ok).toBe(false) // GREEN failed

    const passGreen = passingEvidence()
    passGreen.changedFiles = ["src/foo.ts"]
    const r2 = recordGreen(evidence, "cycle-1", passGreen, true)
    expect(r2.ok).toBe(true)
    if (!r2.ok) throw new Error("expected ok")
    expect(r2.value.cycle.greenAttempts).toHaveLength(1)
    expect(r2.value.cycle.status).toBe("pass")
  })

  it("fails when cycle does not exist", () => {
    const evidence = createTaskEvidence()
    const result = recordGreen(evidence, "nonexistent", passingEvidence(), true)

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error.code).toBe("CYCLE_CONFLICT")
  })
})

// ─── recordFinalRegression ───

describe("recordFinalRegression", () => {
  it("records regression as pass when all runs succeed", () => {
    const evidence = createTaskEvidence()
    const runs = [
      makeCommandEvidence({ exitCode: 0, failureKind: null, testsFailed: 0 }),
    ]

    const result = recordFinalRegression(evidence, "headSha1", "treeSha1", runs)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")

    const newEvidence = result.value
    expect(newEvidence.regression.status).toBe("pass")
    expect(newEvidence.regression.headSha).toBe("headSha1")
    expect(newEvidence.regression.treeSha).toBe("treeSha1")
    expect(newEvidence.regression.runs).toEqual(runs)
  })

  it("records regression as fail when a run has non-zero exit code", () => {
    const evidence = createTaskEvidence()
    const runs = [
      makeCommandEvidence({ exitCode: 0, failureKind: null, testsFailed: 0 }),
      makeCommandEvidence({ exitCode: 1, failureKind: "assertion", testsFailed: 1 }),
    ]

    const result = recordFinalRegression(evidence, "headSha1", "treeSha1", runs)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.value.regression.status).toBe("fail")
  })

  it("records regression as fail when a run times out", () => {
    const evidence = createTaskEvidence()
    const runs = [
      makeCommandEvidence({ failureKind: "timeout", exitCode: null }),
    ]

    const result = recordFinalRegression(evidence, "headSha1", "treeSha1", runs)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.value.regression.status).toBe("fail")
  })

  it("rejects empty runs", () => {
    const evidence = createTaskEvidence()
    const result = recordFinalRegression(evidence, "headSha1", "treeSha1", [])

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error.code).toBe("REGRESSION_FAILED")
  })
})

// ─── recordFinalVerification ───

describe("recordFinalVerification", () => {
  it("records verification as pass when all runs succeed", () => {
    const evidence = createTaskEvidence()
    const runs = [
      makeCommandEvidence({ exitCode: 0, failureKind: null, testsFailed: 0 }),
    ]

    const result = recordFinalVerification(evidence, "headSha1", "treeSha1", runs)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")

    const newEvidence = result.value
    expect(newEvidence.verification.status).toBe("pass")
    expect(newEvidence.verification.headSha).toBe("headSha1")
    expect(newEvidence.verification.treeSha).toBe("treeSha1")
    expect(newEvidence.verification.runs).toEqual(runs)
  })

  it("records verification as fail when a run fails", () => {
    const evidence = createTaskEvidence()
    const runs = [
      makeCommandEvidence({ exitCode: 1, failureKind: "unknown", testsFailed: null }),
    ]

    const result = recordFinalVerification(evidence, "headSha1", "treeSha1", runs)

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.value.verification.status).toBe("fail")
  })

  it("allows empty runs (no verifyCommands configured)", () => {
    const evidence = createTaskEvidence()
    const result = recordFinalVerification(evidence, "headSha1", "treeSha1", [])

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.value.verification.status).toBe("pass")
  })
})

// ─── abandonCycle ───

describe("abandonCycle", () => {
  it("abandons a cycle that was started", () => {
    const evidence = createTaskEvidence()
    const startResult = startCycle(
      evidence, "cycle-1", "AC-1",
      ["test/foo.test.ts"], "test/foo.test.ts", emptyDigest(),
      [tddCriterion], testFilePatterns,
    )
    if (!startResult.ok) throw new Error("expected ok")

    const result = abandonCycle(startResult.value.evidence, "cycle-1", "test design wrong")

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")

    const newEvidence = result.value
    const cycle = newEvidence.cycles.find((c: TddCycleEvidence) => c.cycleId === "cycle-1")
    expect(cycle).toBeDefined()
    expect(cycle!.status).toBe("abandoned")
    // warn 中应包含 reason
    expect(newEvidence.warnings).toContain("test design wrong")
  })

  it("abandons a cycle that was in RED state", () => {
    const evidence = createTaskEvidence()
    const startResult = startCycle(
      evidence, "cycle-1", "AC-1",
      ["test/foo.test.ts"], "test/foo.test.ts", emptyDigest(),
      [tddCriterion], testFilePatterns,
    )
    if (!startResult.ok) throw new Error("expected ok")

    const redEvidence = makeCommandEvidence()
    const redResult = recordRed(startResult.value.evidence, "cycle-1", redEvidence)
    if (!redResult.ok) throw new Error("expected ok")

    const result = abandonCycle(redResult.value.evidence, "cycle-1", "found design flaw")

    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error("expected ok")
    expect(result.value.cycles[0].status).toBe("abandoned")
  })

  it("rejects abandoning a cycle that has already passed", () => {
    const evidence = createTaskEvidence()
    const startResult = startCycle(
      evidence, "cycle-1", "AC-1",
      ["test/foo.test.ts"], "test/foo.test.ts", emptyDigest(),
      [tddCriterion], testFilePatterns,
    )
    if (!startResult.ok) throw new Error("expected ok")

    const redEvidence = makeCommandEvidence()
    const redResult = recordRed(startResult.value.evidence, "cycle-1", redEvidence)
    if (!redResult.ok) throw new Error("expected ok")

    const greenEvidence = passingEvidence()
    greenEvidence.changedFiles = ["src/foo.ts"]
    const greenResult = recordGreen(redResult.value.evidence, "cycle-1", greenEvidence, true)
    if (!greenResult.ok) throw new Error("expected ok")

    // Now abandon a passed cycle
    const result = abandonCycle(greenResult.value.evidence, "cycle-1", "oops")
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error.code).toBe("INVALID_TRANSITION")
  })

  it("fails when cycle does not exist", () => {
    const evidence = createTaskEvidence()
    const result = abandonCycle(evidence, "nonexistent", "reason")

    expect(result.ok).toBe(false)
    if (result.ok) throw new Error("expected error")
    expect(result.error.code).toBe("CYCLE_CONFLICT")
  })

  it("after abandon, a new cycle with different id can be started", () => {
    const evidence = createTaskEvidence()
    const startResult = startCycle(
      evidence, "cycle-1", "AC-1",
      ["test/foo.test.ts"], "test/foo.test.ts", emptyDigest(),
      [tddCriterion], testFilePatterns,
    )
    if (!startResult.ok) throw new Error("expected ok")

    const abandonResult = abandonCycle(startResult.value.evidence, "cycle-1", "restart")
    if (!abandonResult.ok) throw new Error("expected ok")

    // Start a new cycle with different id
    const restartResult = startCycle(
      abandonResult.value,
      "cycle-2", "AC-1",
      ["test/foo-v2.test.ts"], "test/foo-v2.test.ts", emptyDigest(),
      [tddCriterion], testFilePatterns,
    )
    expect(restartResult.ok).toBe(true)
    if (!restartResult.ok) throw new Error("expected ok")

    // Old cycle still abandoned
    const oldCycle = restartResult.value.evidence.cycles.find((c: TddCycleEvidence) => c.cycleId === "cycle-1")
    expect(oldCycle!.status).toBe("abandoned")
    // New cycle started
    const newCycle = restartResult.value.evidence.cycles.find((c: TddCycleEvidence) => c.cycleId === "cycle-2")
    expect(newCycle!.status).toBe("started")
  })
})

// ─── 全生命周期 ───

describe("full lifecycle", () => {
  it("startCycle → recordRed → recordGreen → complete", () => {
    let evidence = createTaskEvidence()
    expect(evidence.status).toBe("not-recorded")

    // 1. startCycle
    const startResult = startCycle(
      evidence, "cycle-1", "AC-1",
      ["test/foo.test.ts"], "test/foo.test.ts", emptyDigest(),
      [tddCriterion], testFilePatterns,
    )
    expect(startResult.ok).toBe(true)
    if (!startResult.ok) throw new Error("expected ok")
    evidence = startResult.value.evidence
    expect(evidence.status).toBe("in-progress")
    expect(evidence.cycles[0].status).toBe("started")

    // 2. recordRed
    const redEvidence = makeCommandEvidence()
    const redResult = recordRed(evidence, "cycle-1", redEvidence)
    expect(redResult.ok).toBe(true)
    if (!redResult.ok) throw new Error("expected ok")
    evidence = redResult.value.evidence
    expect(evidence.cycles[0].status).toBe("red")
    expect(evidence.cycles[0].redAttempts).toHaveLength(1)

    // 3. recordGreen
    const greenEvidence = passingEvidence()
    greenEvidence.changedFiles = ["src/foo.ts"]
    const greenResult = recordGreen(evidence, "cycle-1", greenEvidence, true)
    expect(greenResult.ok).toBe(true)
    if (!greenResult.ok) throw new Error("expected ok")
    evidence = greenResult.value.evidence
    expect(evidence.cycles[0].status).toBe("pass")
    expect(evidence.cycles[0].greenAttempts).toHaveLength(1)

    // Evidence revision should have increased through the lifecycle
    expect(evidence.revision).toBeGreaterThan(0)
  })

  it("revision increments on each state change", () => {
    let evidence = createTaskEvidence()
    
    const s = startCycle(
      evidence, "cycle-1", "AC-1",
      ["test/foo.test.ts"], "test/foo.test.ts", emptyDigest(),
      [tddCriterion], testFilePatterns,
    )
    if (!s.ok) throw new Error("expected ok")
    const revAfterStart = s.value.evidence.revision

    const r = recordRed(s.value.evidence, "cycle-1", makeCommandEvidence())
    if (!r.ok) throw new Error("expected ok")
    const revAfterRed = r.value.evidence.revision
    expect(revAfterRed).toBeGreaterThan(revAfterStart)

    const g = recordGreen(r.value.evidence, "cycle-1", { ...passingEvidence(), changedFiles: ["src/foo.ts"] }, true)
    if (!g.ok) throw new Error("expected ok")
    const revAfterGreen = g.value.evidence.revision
    expect(revAfterGreen).toBeGreaterThan(revAfterRed)
  })
})

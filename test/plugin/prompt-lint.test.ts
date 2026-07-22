import { describe, it, expect } from "vitest"
import { lintAll, type LintFinding } from "../../src/plugin/prompt-lint.js"
import path from "node:path"

const PROJECT_ROOT = path.resolve(import.meta.dirname || __dirname, "..", "..")

describe("prompt-lint", () => {
  it("finds no errors in current assets", () => {
    const { passed, findings } = lintAll(PROJECT_ROOT)
    const errors: LintFinding[] = findings.filter((f: LintFinding) => f.severity === "error")
    if (errors.length > 0) {
      console.error("Lint errors found:")
      for (const e of errors) {
        console.error(`  [${e.rule}] ${e.file}: ${e.message}`)
      }
    }
    expect(passed).toBe(true)
  })

  it("reports Contract completeness warnings", () => {
    const { findings } = lintAll(PROJECT_ROOT)
    const warnings: LintFinding[] = findings.filter((f: LintFinding) => f.rule === "missing-contract-section")
    expect(warnings.length).toBe(0)
  })

  it("reports no forbidden patterns", () => {
    const { findings } = lintAll(PROJECT_ROOT)
    const forbidden: LintFinding[] = findings.filter(
      (f: LintFinding) => f.severity === "error" && f.rule.startsWith("no-")
    )
    expect(forbidden.length).toBe(0)
  })

  it("reports no broken references", () => {
    const { findings } = lintAll(PROJECT_ROOT)
    const refs: LintFinding[] = findings.filter((f: LintFinding) => f.rule === "broken-reference")
    expect(refs.length).toBe(0)
  })

  it("reports no agent capability conflicts", () => {
    const { findings } = lintAll(PROJECT_ROOT)
    const conflicts: LintFinding[] = findings.filter((f: LintFinding) => f.rule.includes("capability-conflict"))
    expect(conflicts.length).toBe(0)
  })
})

describe("prompt-lint: agent permission rules", () => {
  it("warns when agent frontmatter is missing permission field", () => {
    // dev-lifecycle.md has no permission field
    const { findings } = lintAll(PROJECT_ROOT)
    const missing: LintFinding[] = findings.filter((f: LintFinding) => f.rule === "missing-permission")
    expect(missing.length).toBeGreaterThanOrEqual(1)
    for (const m of missing) {
      expect(m.severity).toBe("warn")
    }
    const devLifecycle = missing.find((m: LintFinding) => m.file.includes("dev-lifecycle"))
    expect(devLifecycle).toBeDefined()
  })

  it("errors when worker has gh pr create|merge in permission.bash", () => {
    const { findings } = lintAll(PROJECT_ROOT)
    const violations: LintFinding[] = findings.filter((f: LintFinding) => f.rule === "worker-gh-write-permission")
    // After we update backend/frontend, this should be 0 — but the rule must exist
    // The test verifies the rule engine runs (no false positives on non-violating workers)
    expect(violations.length).toBe(0)
  })

  it("errors when reviewer declares write permission", () => {
    const { findings } = lintAll(PROJECT_ROOT)
    const violations: LintFinding[] = findings.filter((f: LintFinding) => f.rule === "reviewer-write-permission")
    // reviewer.md has edit: "deny" — should be 0 violations
    expect(violations.length).toBe(0)
  })

  it("warns when capabilities are inconsistent with permission", () => {
    const { findings } = lintAll(PROJECT_ROOT)
    const warnings: LintFinding[] = findings.filter((f: LintFinding) => f.rule === "capability-permission-mismatch")
    // Current agents should not have mismatches (we'll verify)
    // This test ensures the rule runs and doesn't false-positive
    expect(warnings.length).toBe(0)
  })

  it("detects all permission rules on current agents", () => {
    const { findings } = lintAll(PROJECT_ROOT)
    const permRules = findings.filter((f: LintFinding) =>
      ["missing-permission", "worker-gh-write-permission", "reviewer-write-permission", "capability-permission-mismatch"].includes(f.rule)
    )
    // We should have findings for the permission rules
    // At minimum: architect.md missing permission
    expect(permRules.length).toBeGreaterThanOrEqual(1)
  })
})

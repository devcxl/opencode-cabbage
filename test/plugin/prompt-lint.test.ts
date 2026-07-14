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

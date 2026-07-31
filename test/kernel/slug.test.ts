import { describe, it, expect } from "vitest"
import { validateTitle, deriveSlug, branchFor, worktreeFor } from "../../src/kernel/slug.js"

describe("validateTitle", () => {
  it("accepts a valid functional slug", () => {
    expect(validateTitle("validate-execution-binding")).toEqual({
      ok: true,
      slug: "validate-execution-binding",
    })
  })

  it("accepts multi-word functional slugs with domain words", () => {
    expect(validateTitle("onboarding-checklist").ok).toBe(true)
    expect(validateTitle("v2-migration").ok).toBe(true)
  })

  it.each([
    "task-001",
    "feature-1",
    "implement-task",
    "fix-bug",
    "add-docs",
    "task",
    "123",
  ])("rejects generic title %s", (title) => {
    const result = validateTitle(title)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("GENERIC_TITLE")
    }
  })

  it("rejects empty or whitespace-only title", () => {
    expect(validateTitle("").ok).toBe(false)
    expect(validateTitle("   ").ok).toBe(false)
  })

  it.each([
    "Task 001",
    "Validate-execution-binding",
    "validate_Execution",
    "validate--execution",
    "-validate",
    "validate-",
    "validate binding",
    "validate.execution",
  ])("rejects invalid format %s", (title) => {
    expect(validateTitle(title).ok).toBe(false)
  })

  it("rejects slug longer than 60 characters", () => {
    expect(validateTitle("a".repeat(61)).ok).toBe(false)
  })

  it("accepts slug of exactly 60 characters", () => {
    expect(validateTitle("a".repeat(60)).ok).toBe(true)
  })
})

describe("deriveSlug", () => {
  it("derives kebab slug from a natural title", () => {
    expect(deriveSlug("Validate Execution Binding")).toBe("validate-execution-binding")
  })

  it("collapses separators and strips leading/trailing dashes", () => {
    expect(deriveSlug("  Fix -- Message__Ordering  ")).toBe("fix-message-ordering")
  })

  it("returns empty string for meaningless input instead of a fallback", () => {
    expect(deriveSlug("!!!")).toBe("")
    expect(deriveSlug("")).toBe("")
  })

  it("truncates over-long slugs to at most 60 characters", () => {
    expect(deriveSlug("a".repeat(80)).length).toBeLessThanOrEqual(60)
  })
})

describe("branchFor / worktreeFor", () => {
  it("builds branch names with the type prefix", () => {
    expect(branchFor("validate-execution-binding", "feat")).toBe("feat/validate-execution-binding")
    expect(branchFor("validate-execution-binding", "fix")).toBe("fix/validate-execution-binding")
    expect(branchFor("validate-execution-binding", "chore")).toBe("chore/validate-execution-binding")
    expect(branchFor("validate-execution-binding", "docs")).toBe("docs/validate-execution-binding")
  })

  it("builds the worktree path", () => {
    expect(worktreeFor("validate-execution-binding")).toBe(".worktree/validate-execution-binding")
  })
})

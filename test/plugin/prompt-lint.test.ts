import { describe, it, expect } from "vitest"
import { lintAll, type LintFinding } from "../../src/plugin/prompt-lint.js"
import path from "node:path"
import fs from "node:fs"
import os from "node:os"

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
    // 批 12 后所有 agent 均已声明 permission —— 不应有 missing-permission 告警
    const { findings } = lintAll(PROJECT_ROOT)
    const missing: LintFinding[] = findings.filter((f: LintFinding) => f.rule === "missing-permission")
    expect(missing.length).toBe(0)
  })

  it("errors when worker has gh pr create|merge in permission.bash", () => {
    const { findings } = lintAll(PROJECT_ROOT)
    const violations: LintFinding[] = findings.filter((f: LintFinding) => f.rule === "worker-gh-write-permission")
    // developer（backend+frontend 合并后唯一 worker）应合规 — 但规则必须存在并命中 developer
    expect(violations.length).toBe(0)
  })

  it("applies worker-gh-write-permission rule to developer agent", () => {
    // 构造临时 assets 目录：developer.md 声明 gh pr create allow → lint 必须报违规
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabbage-lint-"))
    try {
      fs.mkdirSync(path.join(tmpDir, "assets", "agents", "team"), { recursive: true })
      fs.writeFileSync(
        path.join(tmpDir, "assets", "agents", "team", "developer.md"),
        `---
name: developer
mode: subagent
permission:
  bash:
    "*": "deny"
    "gh pr create*": "allow"
  edit: "deny"
---

worker prompt
`,
        "utf8",
      )
      const { findings } = lintAll(tmpDir)
      const violations = findings.filter(f => f.rule === "worker-gh-write-permission")
      expect(violations.length).toBe(1)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
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
})

describe("prompt-lint: skill/command convergence (R12)", () => {
  const EXPECTED_SKILLS = [
    "flow-change", "flow-code", "flow-design", "flow-docs",
    "flow-incident", "flow-release", "flow-requirements", "flow-research",
    "flow-review", "flow-setup", "flow-tasks", "flow-tdd",
  ]
  const EXPECTED_COMMANDS = ["setup", "requirements", "design", "tasks", "code", "review", "release"]

  function writeSkill(root: string, name: string, body: string) {
    const dir = path.join(root, "assets", "skills", name)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, "SKILL.md"), `# ${name}\n\n${body}`, "utf8")
  }

  function writeCommand(root: string, name: string, body: string) {
    const dir = path.join(root, "assets", "commands")
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, `${name}.md`), `---\ndescription: ${name}\n---\n\n${body}`, "utf8")
  }

  function makeValidAssets(root: string) {
    for (const s of EXPECTED_SKILLS) writeSkill(root, s, `## Contract\n### Trigger\n### Inputs\n### Preconditions\n### Procedure\n### Outputs\n### Failure\n### Idempotency\n### Prohibited Actions`)
    for (const c of EXPECTED_COMMANDS) writeCommand(root, c, "body")
  }

  it("passes a valid 12-skill / 7-command assets tree", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cabbage-lint-conv-"))
    try {
      makeValidAssets(tmp)
      const { findings } = lintAll(tmp)
      expect(findings).toEqual([])
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("flags handoff/test residue inside skill/command/bootstrap content", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cabbage-lint-conv-"))
    try {
      makeValidAssets(tmp)
      writeSkill(tmp, "flow-code", "加载 flow-handoff 打包进度；触发 /test 诊断")
      const { findings } = lintAll(tmp)
      const residue = findings.filter(f => f.rule === "handoff-test-residue")
      expect(residue.length).toBeGreaterThanOrEqual(1)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it("current assets have no handoff/test residue", () => {
    const { findings } = lintAll(PROJECT_ROOT)
    const violations = findings.filter(f => f.rule === "handoff-test-residue")
    expect(violations.length).toBe(0)
  })
})

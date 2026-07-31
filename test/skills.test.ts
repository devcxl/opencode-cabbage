import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { setupSkillsDir } from "../src/plugin/skills.js"

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabbage-skill-test-"))
  process.env.CABBAGE_SKILLS_DIR = path.join(tmpDir, "skills")
})

afterEach(() => {
  delete process.env.CABBAGE_SKILLS_DIR
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function createSkill(dir: string, name: string, content: string): string {
  const skillDir = path.join(dir, `flow-${name}`)
  fs.mkdirSync(skillDir, { recursive: true })
  const filePath = path.join(skillDir, "SKILL.md")
  fs.writeFileSync(filePath, content, "utf8")
  return filePath
}

const PROJECT_ROOT = path.resolve(import.meta.dirname || __dirname, "..")
const ASSETS_SKILLS_DIR = path.join(PROJECT_ROOT, "assets", "skills")

describe("setupSkillsDir", () => {
  it("copies skills to the cabbage skills directory", async () => {
    const srcDir = path.join(tmpDir, "skills-src")
    fs.mkdirSync(srcDir, { recursive: true })
    createSkill(srcDir, "test", "# flow-test\n\nTest skill content.")

    const result = await setupSkillsDir(srcDir)

    expect(result).toContain("cabbage")
    expect(fs.existsSync(path.join(result, "flow-test", "SKILL.md"))).toBe(true)
    const content = fs.readFileSync(path.join(result, "flow-test", "SKILL.md"), "utf8")
    expect(content).toContain("# flow-test")
  })

  it("copies context directory when provided", async () => {
    const srcDir = path.join(tmpDir, "skills-src")
    fs.mkdirSync(srcDir, { recursive: true })
    createSkill(srcDir, "x", "# x")

    const contextDir = path.join(tmpDir, "context")
    fs.mkdirSync(contextDir, { recursive: true })
    fs.writeFileSync(path.join(contextDir, "CONTEXT.md"), "# Context", "utf8")

    const result = await setupSkillsDir(srcDir, contextDir)

    expect(fs.existsSync(path.join(result, "_context", "CONTEXT.md"))).toBe(true)
  })

  it("replaces .opencode/skills/ references in SKILL.md", async () => {
    const srcDir = path.join(tmpDir, "skills-src")
    fs.mkdirSync(srcDir, { recursive: true })
    createSkill(srcDir, "test", "Load from .opencode/skills/flow-other")

    const result = await setupSkillsDir(srcDir)

    const content = fs.readFileSync(path.join(result, "flow-test", "SKILL.md"), "utf8")
    expect(content).toContain(`Load from ${result}/flow-other`)
    expect(content).not.toContain(".opencode/skills/")
  })

  it("handles non-existent context dir gracefully", async () => {
    const srcDir = path.join(tmpDir, "skills-src")
    fs.mkdirSync(srcDir, { recursive: true })
    createSkill(srcDir, "a", "# a")

    const result = await setupSkillsDir(srcDir, "/non/existent/path")
    expect(fs.existsSync(path.join(result, "flow-a", "SKILL.md"))).toBe(true)
  })

  it("handles empty skills directory", async () => {
    const srcDir = path.join(tmpDir, "empty-skills")
    fs.mkdirSync(srcDir, { recursive: true })

    const result = await setupSkillsDir(srcDir)
    const entries = fs.readdirSync(result)
    expect(entries.length).toBe(0)
  })
})

describe("flow-tdd Advisory Skill", () => {
  const CONTRACT_SECTIONS = [
    "Trigger", "Inputs", "Preconditions", "Procedure",
    "Outputs", "Failure", "Idempotency", "Prohibited Actions",
  ]

  const TDD_PROTOCOL_KEYWORDS = [
    "cycle-start",
    "red",
    "green",
    "abandon-cycle",
    "final-regression",
    "final-verification",
  ]

  function readFlowTddSkill(): string | null {
    const skillPath = path.join(ASSETS_SKILLS_DIR, "flow-tdd", "SKILL.md")
    if (!fs.existsSync(skillPath)) return null
    return fs.readFileSync(skillPath, "utf8")
  }

  it("flow-tdd SKILL.md exists in assets", () => {
    const skillPath = path.join(ASSETS_SKILLS_DIR, "flow-tdd", "SKILL.md")
    expect(fs.existsSync(skillPath)).toBe(true)
  })

  it("flow-tdd SKILL.md has complete 8-section Contract", () => {
    const content = readFlowTddSkill()
    expect(content).not.toBeNull()
    for (const section of CONTRACT_SECTIONS) {
      const headingRegex = new RegExp(`^### ${section}$`, "m")
      expect(headingRegex.test(content!)).toBe(true)
    }
  })

  it("flow-tdd SKILL.md contains TDD Advisory Protocol keywords", () => {
    const content = readFlowTddSkill()
    expect(content).not.toBeNull()
    for (const keyword of TDD_PROTOCOL_KEYWORDS) {
      expect(content!).toContain(keyword)
    }
  })

  it("flow-tdd SKILL.md contains Advisory Procedure section", () => {
    const content = readFlowTddSkill()
    expect(content).not.toBeNull()
    expect(content!).toMatch(/Advisory Procedure/i)
  })

  it("flow-tdd SKILL.md contains Runtime Procedure bound to tdd_checkpoint ops", () => {
    const content = readFlowTddSkill()
    expect(content).not.toBeNull()
    expect(content!).toMatch(/Runtime Procedure/i)
    // 批 14：Runtime Procedure 从 Phase C 占位改为实际协议 — 每个 stage 对应 tdd_checkpoint op
    expect(content!).toContain("tdd_checkpoint")
    expect(content!).toContain("cycle-start")
  })

  it("flow-tdd is loaded by setupSkillsDir", async () => {
    const srcDir = path.join(tmpDir, "skills-src")
    fs.mkdirSync(srcDir, { recursive: true })
    // Copy the real flow-tdd skill to temp dir for setupSkillsDir
    const realSkillDir = path.join(ASSETS_SKILLS_DIR, "flow-tdd")
    const destDir = path.join(srcDir, "flow-tdd")
    fs.cpSync(realSkillDir, destDir, { recursive: true })

    const result = await setupSkillsDir(srcDir)

    expect(fs.existsSync(path.join(result, "flow-tdd", "SKILL.md"))).toBe(true)
    const loaded = fs.readFileSync(path.join(result, "flow-tdd", "SKILL.md"), "utf8")
    expect(loaded).toContain("# flow-tdd")
    expect(loaded).toContain("cycle-start")
  })
})

describe("skills convergence (R12, §6.2)", () => {
  const EXPECTED_SKILLS = [
    "flow-setup", "flow-requirements", "flow-design", "flow-tasks",
    "flow-code", "flow-tdd", "flow-review", "flow-release",
  ]

  // 每个 skill 指向的内核工具（§6.2 引用关系）
  const SKILL_TOOL_REFS: Record<string, string[]> = {
    "flow-setup": ["setup_control"],
    "flow-requirements": ["flow_control"],
    "flow-design": ["flow_control"],
    "flow-tasks": ["task_control"],
    "flow-code": ["task_control", "tdd_checkpoint"],
    "flow-tdd": ["tdd_checkpoint"],
    "flow-review": ["task_control"],
    "flow-release": ["release_control"],
  }

  function listSkillDirs(): string[] {
    if (!fs.existsSync(ASSETS_SKILLS_DIR)) return []
    return fs.readdirSync(ASSETS_SKILLS_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name)
  }

  it("exactly 8 skills exist, no flow-handoff / flow-test", () => {
    const dirs = listSkillDirs()
    expect(dirs.sort()).toEqual([...EXPECTED_SKILLS].sort())
  })

  it("each skill references its kernel tool, does not copy tool implementation", () => {
    for (const skill of EXPECTED_SKILLS) {
      const skillPath = path.join(ASSETS_SKILLS_DIR, skill, "SKILL.md")
      const content = fs.readFileSync(skillPath, "utf8")
      for (const tool of SKILL_TOOL_REFS[skill]) {
        expect(content).toContain(tool)
      }
      // 不复制内核工具实现：不出现 shell 层 gh/git 写命令
      expect(content).not.toMatch(/gh pr create/)
      expect(content).not.toMatch(/gh issue create/)
      expect(content).not.toMatch(/git push/)
      expect(content).not.toMatch(/git worktree add/)
    }
  })

  it("flow-code references flow-tdd as the single TDD source", () => {
    const content = fs.readFileSync(path.join(ASSETS_SKILLS_DIR, "flow-code", "SKILL.md"), "utf8")
    expect(content).toContain("flow-tdd")
  })
})

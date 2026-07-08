import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { setupSkillsDir } from "../src/plugin/skills.js"

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabbage-skill-test-"))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function createSkill(dir: string, name: string, content: string): string {
  const skillDir = path.join(dir, `flow-${name}`)
  fs.mkdirSync(skillDir, { recursive: true })
  const filePath = path.join(skillDir, "SKILL.md")
  fs.writeFileSync(filePath, content, "utf8")
  return filePath
}

describe("setupSkillsDir", () => {
  it("copies skills to a temp directory", async () => {
    const srcDir = path.join(tmpDir, "skills-src")
    fs.mkdirSync(srcDir, { recursive: true })
    createSkill(srcDir, "test", "# flow-test\n\nTest skill content.")

    const result = await setupSkillsDir(srcDir)

    expect(result).toMatch(/opencode-cabbage-skills/)
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

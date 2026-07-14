import { describe, it, expect } from "vitest"
import path from "node:path"
import { setupSkillsDir } from "../src/plugin/skills.js"
import { readdir, access, readFile } from "node:fs/promises"

function assetPath(name: string): string {
  return path.resolve(import.meta.dirname || __dirname, "..", "assets", name)
}

describe("setupSkillsDir with prompts", () => {
  it("copies _prompts into skills temp dir", async () => {
    const sourceSkills = assetPath("skills")
    const contextDir = assetPath("context")
    const promptsDir = assetPath("prompts")

    const destDir = await setupSkillsDir(sourceSkills, contextDir, promptsDir)

    const promptsPath = path.join(destDir, "_prompts")
    await expect(access(promptsPath)).resolves.toBeUndefined()

    const files = await readdir(promptsPath)
    expect(files).toContain("PRD-FORMAT.md")
    expect(files).toContain("ADR-FORMAT.md")
    expect(files).toContain("bootstrap.md")
  })

  it("copies _context into skills temp dir", async () => {
    const sourceSkills = assetPath("skills")
    const contextDir = assetPath("context")

    const destDir = await setupSkillsDir(sourceSkills, contextDir)

    const contextPath = path.join(destDir, "_context")
    await expect(access(contextPath)).resolves.toBeUndefined()

    const files = await readdir(contextPath)
    expect(files).toContain("CONTEXT.md")
  })

  it("flow-design SKILL.md references _context/CONTEXT.md", async () => {
    const sourceSkills = assetPath("skills")
    const contextDir = assetPath("context")
    const promptsDir = assetPath("prompts")

    const destDir = await setupSkillsDir(sourceSkills, contextDir, promptsDir)

    const skillPath = path.join(destDir, "flow-design", "SKILL.md")
    const content = await readFile(skillPath, "utf8")
    expect(content).toContain("_context/CONTEXT.md")
  })

  it("flow-requirements SKILL.md references _prompts/prd-format", async () => {
    const sourceSkills = assetPath("skills")
    const promptsDir = assetPath("prompts")

    const destDir = await setupSkillsDir(sourceSkills, undefined, promptsDir)

    const skillPath = path.join(destDir, "flow-requirements", "SKILL.md")
    const content = await readFile(skillPath, "utf8")
    expect(content).toContain("_prompts/prd-format")
  })

  it("gracefully handles missing promptsDir", async () => {
    const sourceSkills = assetPath("skills")
    const destDir = await setupSkillsDir(sourceSkills, undefined, "/nonexistent/prompts")
    // Should not throw; _prompts dir simply won't exist
    expect(destDir).toBeTruthy()
  })
})

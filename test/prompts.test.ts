import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { setupSkillsDir } from "../src/plugin/skills.js"
import { readdir, access, readFile } from "node:fs/promises"

function assetPath(name: string): string {
  return path.resolve(import.meta.dirname || __dirname, "..", "assets", name)
}

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabbage-prompt-test-"))
  process.env.CABBAGE_SKILLS_DIR = path.join(tmpDir, "skills")
})

afterEach(() => {
  delete process.env.CABBAGE_SKILLS_DIR
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe("setupSkillsDir with prompts", () => {
  it("copies _prompts into skills temp dir", async () => {
    const sourceSkills = assetPath("skills")
    const promptsDir = assetPath("prompts")

    const destDir = await setupSkillsDir(sourceSkills, promptsDir)

    const promptsPath = path.join(destDir, "_prompts")
    await expect(access(promptsPath)).resolves.toBeUndefined()

    const files = await readdir(promptsPath)
    // 仅保留仍被加载的 bootstrap（PRD/ADR 格式模板已随生命周期内核删除，格式内嵌于 skill）
    expect(files).toContain("bootstrap.md")
    expect(files).not.toContain("PRD-FORMAT.md")
    expect(files).not.toContain("ADR-FORMAT.md")
  })

  it("flow-design SKILL.md references project root CONTEXT.md（内置 _context 已删除）", async () => {
    const sourceSkills = assetPath("skills")
    const promptsDir = assetPath("prompts")

    const destDir = await setupSkillsDir(sourceSkills, promptsDir)

    const skillPath = path.join(destDir, "flow-design", "SKILL.md")
    const content = await readFile(skillPath, "utf8")
    // 批 15：内置 context 注入删除，flow-design 应引用仓库根 CONTEXT.md
    expect(content).not.toContain("_context/CONTEXT.md")
    expect(content).toContain("CONTEXT.md")
  })

  it("flow-requirements SKILL.md embeds decision-map and grilling concepts", async () => {
    const sourceSkills = assetPath("skills")
    const destDir = await setupSkillsDir(sourceSkills)

    const skillPath = path.join(destDir, "flow-requirements", "SKILL.md")
    const content = await readFile(skillPath, "utf8")
    // 不再引用外部 _prompts/prd-format，而是内嵌 Decision Map 和 Grilling 方法论
    expect(content).toContain("Decision Map")
    expect(content).toContain("一次只问一个问题")
    expect(content).toContain("Phase A")
  })

  it("gracefully handles missing promptsDir", async () => {
    const sourceSkills = assetPath("skills")
    const destDir = await setupSkillsDir(sourceSkills, "/nonexistent/prompts")
    // Should not throw; _prompts dir simply won't exist
    expect(destDir).toBeTruthy()
  })
})

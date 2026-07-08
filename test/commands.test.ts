import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { loadCommands } from "../src/plugin/commands.js"

let tmpDir: string
let skillsDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabbage-cmd-test-"))
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabbage-skills-"))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
  fs.rmSync(skillsDir, { recursive: true, force: true })
})

function writeCommand(name: string, body: string, extraFrontmatter = ""): string {
  const content = `---
description: command ${name}
${extraFrontmatter}
---

${body}
`
  const filePath = path.join(tmpDir, `${name}.md`)
  fs.writeFileSync(filePath, content, "utf8")
  return filePath
}

describe("loadCommands", () => {
  it("returns empty array for non-existent dir", () => {
    const result = loadCommands("/non/existent", skillsDir)
    expect(result).toEqual([])
  })

  it("loads a single command", () => {
    writeCommand("testcmd", "echo hello")
    const result = loadCommands(tmpDir, skillsDir)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("testcmd")
    expect(result[0].description).toBe("command testcmd")
    expect(result[0].template).toBe("echo hello")
  })

  it("loads multiple commands", () => {
    writeCommand("cmd1", "step1")
    writeCommand("cmd2", "step2")
    const result = loadCommands(tmpDir, skillsDir)
    expect(result).toHaveLength(2)
    expect(result.map(c => c.name)).toEqual(expect.arrayContaining(["cmd1", "cmd2"]))
  })

  it("skips non-md files", () => {
    writeCommand("valid", "content")
    fs.writeFileSync(path.join(tmpDir, "notes.txt"), "not a command", "utf8")
    const result = loadCommands(tmpDir, skillsDir)
    expect(result).toHaveLength(1)
  })

  it("replaces .opencode/skills/ with skillsDir path", () => {
    writeCommand("withskills", "load .opencode/skills/flow-test")
    const result = loadCommands(tmpDir, skillsDir)
    expect(result[0].template).toBe(`load ${skillsDir}/flow-test`)
  })

  it("parses frontmatter metadata fields", () => {
    writeCommand("meta", "content", "agent: architect\nmodel: gpt-4\nsubtask: true")
    const result = loadCommands(tmpDir, skillsDir)
    expect(result[0].agent).toBe("architect")
    expect(result[0].model).toBe("gpt-4")
    expect(result[0].subtask).toBe(true)
  })

  it("parses subtask as false correctly", () => {
    writeCommand("not-sub", "content", "subtask: false")
    const result = loadCommands(tmpDir, skillsDir)
    expect(result[0].subtask).toBe(false)
  })

  it("handles file without frontmatter gracefully", () => {
    const filePath = path.join(tmpDir, "nofm.md")
    fs.writeFileSync(filePath, "just body", "utf8")
    const result = loadCommands(tmpDir, skillsDir)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("nofm")
    expect(result[0].description).toBeUndefined()
    expect(result[0].template).toBe("just body")
  })

  it("caches results on repeated calls", () => {
    writeCommand("cached", "data")
    const r1 = loadCommands(tmpDir, skillsDir)
    const r2 = loadCommands(tmpDir, skillsDir)
    expect(r1).toEqual(r2)
  })

  it("invalidates cache when skillsDir changes", () => {
    writeCommand("a", "hello")
    const otherSkillsDir = fs.mkdtempSync(path.join(os.tmpdir(), "other-skills-"))
    try {
      const r1 = loadCommands(tmpDir, skillsDir)
      const r2 = loadCommands(tmpDir, otherSkillsDir)
      expect(r1[0].template).toBe("hello")
      expect(r2[0].template).toBe("hello")
      expect(r1).toEqual(r2)
    } finally {
      fs.rmSync(otherSkillsDir, { recursive: true, force: true })
    }
  })
})

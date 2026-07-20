import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { loadAgents } from "../src/plugin/agents.js"

let tmpDir: string

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cabbage-test-"))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

function writeAgent(name: string, mode: string, extraFrontmatter = ""): string {
  const content = `---
name: ${name}
description: Test agent ${name}
mode: ${mode}
${extraFrontmatter}
---

You are a test agent. Do test things.
`
  const filePath = path.join(tmpDir, `${name}.md`)
  fs.writeFileSync(filePath, content, "utf8")
  return filePath
}

function writeTeamAgent(name: string): string {
  const teamDir = path.join(tmpDir, "team")
  fs.mkdirSync(teamDir, { recursive: true })
  const content = `---
name: ${name}
description: Team agent ${name}
mode: subagent
---

You are a team agent.
`
  const filePath = path.join(teamDir, `${name}.md`)
  fs.writeFileSync(filePath, content, "utf8")
  return filePath
}

describe("loadAgents", () => {
  it("returns empty array for non-existent dir", () => {
    const result = loadAgents("/non/existent/path")
    expect(result).toEqual([])
  })

  it("loads a single agent from root", () => {
    writeAgent("test-agent", "primary")
    const result = loadAgents(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].key).toBe("test-agent")
    expect(result[0].mode).toBe("primary")
    expect(result[0].prompt).toContain("You are a test agent")
  })

  it("extracts tools from frontmatter", () => {
    writeAgent("readonly", "subagent", "tools:\n  read: true\n  bash: false\n  write: false\n  edit: false")
    const result = loadAgents(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].tools).toEqual({
      read: true,
      bash: false,
      write: false,
      edit: false,
    })
  })

  it("defaults tools to undefined when not specified", () => {
    writeAgent("no-tools", "primary")
    const result = loadAgents(tmpDir)
    expect(result[0].tools).toBeUndefined()
  })

  it("handles partial tools specification", () => {
    writeAgent("partial", "subagent", "tools:\n  read: true")
    const result = loadAgents(tmpDir)
    expect(result[0].tools).toBeDefined()
    expect(result[0].tools!.read).toBe(true)
    expect(result[0].tools!.bash).toBe(false)
    expect(result[0].tools!.write).toBe(false)
    expect(result[0].tools!.edit).toBe(false)
  })

  it("loads agents from both root and team dir", () => {
    writeAgent("root-agent", "primary")
    writeTeamAgent("team-agent")
    const result = loadAgents(tmpDir)
    expect(result).toHaveLength(2)
    const keys = result.map(a => a.key)
    expect(keys).toContain("root-agent")
    expect(keys).toContain("team-agent")
  })

  it("skips non-md files", () => {
    writeAgent("valid-agent", "primary")
    fs.writeFileSync(path.join(tmpDir, "readme.txt"), "not an agent", "utf8")
    const result = loadAgents(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].key).toBe("valid-agent")
  })

  it("parses frontmatter fields like color", () => {
    writeAgent("color-agent", "primary", "color: '#abc'")
    const result = loadAgents(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].color).toBe("#abc")
  })

  it("skips files without frontmatter", () => {
    const filePath = path.join(tmpDir, "no-frontmatter.md")
    fs.writeFileSync(filePath, "Just some text without frontmatter", "utf8")
    const result = loadAgents(tmpDir)
    expect(result).toHaveLength(0)
  })

  it("skips files without name in frontmatter", () => {
    const filePath = path.join(tmpDir, "noname.md")
    fs.writeFileSync(filePath, "---\ndescription: no name here\n---\nbody", "utf8")
    const result = loadAgents(tmpDir)
    expect(result).toHaveLength(0)
  })
})

describe("dev-lifecycle prompt", () => {
  it("delegates completion verification without intentionally triggering BLOCKED", () => {
    const agentsDir = path.resolve(import.meta.dirname || __dirname, "..", "assets", "agents")
    const agent = loadAgents(agentsDir).find(entry => entry.key === "dev-lifecycle")

    expect(agent?.prompt).toContain("直接使用 Task 工具派发 `@goal-verify`")
    expect(agent?.prompt).not.toContain("如果被 BLOCKED")
    expect(agent?.prompt).not.toContain("最终全部完成后调用 `goal({op:\"complete\"})`")
  })
})

describe("Agent permission parsing", () => {
  it("parses permission with string values", () => {
    writeAgent("perm-agent", "subagent", `tools:
  read: true
  bash: true
  write: true
  edit: true
permission:
  bash: "npm test|git push|npm run build"
  write: ".worktree/"
  edit: "src/,test/,assets/"`)
    const result = loadAgents(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].permission).toBeDefined()
    expect(result[0].permission!.bash).toBe("npm test|git push|npm run build")
    expect(result[0].permission!.write).toBe(".worktree/")
    expect(result[0].permission!.edit).toBe("src/,test/,assets/")
  })

  it("parses permission with deny values", () => {
    writeAgent("deny-agent", "subagent", `tools:
  read: true
  bash: true
  write: false
  edit: false
permission:
  bash: "gh pr view|diff|checks"
  write: deny
  edit: deny`)
    const result = loadAgents(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].permission!.bash).toBe("gh pr view|diff|checks")
    expect(result[0].permission!.write).toBe("deny")
    expect(result[0].permission!.edit).toBe("deny")
  })

  it("defaults permission to undefined when not specified", () => {
    writeAgent("no-perm", "primary")
    const result = loadAgents(tmpDir)
    expect(result[0].permission).toBeUndefined()
  })

  it("handles partial permission specification", () => {
    writeAgent("partial-perm", "subagent", "permission:\n  bash: \"npm test\"")
    const result = loadAgents(tmpDir)
    expect(result[0].permission).toBeDefined()
    expect(result[0].permission!.bash).toBe("npm test")
    expect(result[0].permission!.write).toBeUndefined()
    expect(result[0].permission!.edit).toBeUndefined()
  })

  it("keeps capabilities field for lint usage", () => {
    writeAgent("cap-agent", "subagent", `capabilities:
  create_pr: false
  merge_pr: false
  modify_files: true
  run_tests: true
  push_branch: true
  approve_review: false
  complete_goal: false
permission:
  bash: "npm test|git push"
  write: ".worktree/"
  edit: "src/,test/"`)
    const result = loadAgents(tmpDir)
    expect(result[0].capabilities).toBeDefined()
    expect(result[0].capabilities!.modify_files).toBe(true)
    expect(result[0].capabilities!.run_tests).toBe(true)
    expect(result[0].capabilities!.create_pr).toBe(false)
    expect(result[0].permission).toBeDefined()
  })
})

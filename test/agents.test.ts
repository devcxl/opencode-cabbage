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

  it("ignores deprecated tools frontmatter（tools 布尔已废弃）", () => {
    writeAgent("tools-agent", "primary", "tools:\n  read: true\n  bash: true\n  write: true\n  edit: true")
    const result = loadAgents(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].tools).toBeUndefined()
  })

  it("ignores deprecated capabilities frontmatter（capabilities 已废弃）", () => {
    writeAgent("cap-agent", "primary", "capabilities:\n  create_pr: false\n  merge_pr: false\n  modify_files: true")
    const result = loadAgents(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].capabilities).toBeUndefined()
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

describe("developer agent（backend+frontend 合并，§6.1）", () => {
  const agentsDir = path.resolve(import.meta.dirname || __dirname, "..", "assets", "agents")

  it("loads developer from team dir with bash whitelist + deny tail + edit whitelist", () => {
    const agents = loadAgents(agentsDir)
    const dev = agents.find(a => a.key === "developer")

    expect(dev).toBeDefined()
    expect(dev?.mode).toBe("subagent")

    const bash = dev?.permission?.bash as Record<string, string> | undefined
    expect(bash?.["*"]).toBe("deny")                          // 兜底 deny
    expect(bash?.["<profile-test-command>*"]).toBe("allow")   // 测试命令由 Profile 生成，不硬编码 npm
    expect(bash?.["git status*"]).toBe("allow")               // 只读 git 白名单
    expect(bash?.["git add*"]).toBe("allow")                  // 本地写
    expect(bash?.["git commit*"]).toBe("allow")
    // 写操作 deny 置尾（最后匹配优先）
    expect(bash?.["git push*"]).toBe("deny")
    expect(bash?.["git worktree*"]).toBe("deny")
    expect(bash?.["gh pr create*"]).toBe("deny")
    expect(bash?.["gh pr merge*"]).toBe("deny")
    expect(bash?.["gh issue create*"]).toBe("deny")

    const edit = dev?.permission?.edit as Record<string, string> | undefined
    expect(edit?.["*"]).toBe("deny")
    expect(edit?.[".worktree/**"]).toBe("allow")
    expect(edit?.["src/**"]).toBe("allow")
    expect(edit?.["test/**"]).toBe("allow")
    expect(edit?.["assets/**"]).toBe("allow")
  })

  it("body 技术栈无关：加载 flow-tdd、不内嵌三份工程原则拷贝、无 backend/frontend 残留", () => {
    const agents = loadAgents(agentsDir)
    const dev = agents.find(a => a.key === "developer")
    const prompt = dev?.prompt ?? ""

    expect(prompt).toContain("flow-tdd")
    expect(prompt).not.toContain("### KISS（Keep It Simple, Stupid）") // 工程原则单份引用
    expect(prompt).not.toContain("@backend")
    expect(prompt).not.toContain("@frontend")
    expect(prompt).not.toContain("npm test")
    expect(prompt).not.toContain("git push")
  })

  it("backend/frontend 已删除，不再加载", () => {
    const agents = loadAgents(agentsDir)
    const keys = agents.map(a => a.key)
    expect(keys).not.toContain("backend")
    expect(keys).not.toContain("frontend")
    expect(keys).toContain("developer")
  })
})

describe("Agent permission parsing", () => {
  it("parses permission with string values", () => {
    writeAgent("perm-agent", "subagent", `permission:
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
    writeAgent("deny-agent", "subagent", `permission:
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

  it("parses nested permission rule objects（OpenCode 语义：pattern → action）", () => {
    writeAgent("nested-perm", "subagent", `permission:
  bash:
    "*": "deny"
    "npm *": "allow"
    "git status*": "allow"
    "git push*": "deny"
  edit:
    "*": "deny"
    ".worktree/**": "allow"`)
    const result = loadAgents(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].permission!.bash).toEqual({
      "*": "deny",
      "npm *": "allow",
      "git status*": "allow",
      "git push*": "deny",
    })
    expect(result[0].permission!.edit).toEqual({
      "*": "deny",
      ".worktree/**": "allow",
    })
  })
})

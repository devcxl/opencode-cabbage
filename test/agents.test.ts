import { describe, it, expect, beforeEach, afterEach } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import { buildAgentPayloads, loadAgents, type AgentRule } from "../src/plugin/agents.js"
import { matchPermissionRules } from "../src/kernel/permission.js"

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

  it("ignores deprecated V1 permission/tools frontmatter（权限已迁移至原生 permissions）", () => {
    writeAgent("v1-agent", "subagent", "tools:\n  read: true\n  write: false\npermission:\n  bash:\n    \"*\": \"deny\"\n    \"git status*\": \"allow\"")
    const result = loadAgents(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].permissions).toBeUndefined()
  })

  it("ignores deprecated capabilities frontmatter（capabilities 已废弃）", () => {
    writeAgent("cap-agent", "primary", "capabilities:\n  create_pr: false\n  merge_pr: false\n  modify_files: true")
    const result = loadAgents(tmpDir)
    expect(result).toHaveLength(1)
    expect((result[0] as unknown as Record<string, unknown>).capabilities).toBeUndefined()
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

  it("loads developer from team dir with native bash whitelist + deny tail + edit whitelist", () => {
    const agents = loadAgents(agentsDir)
    const dev = agents.find(a => a.key === "developer")

    expect(dev).toBeDefined()
    expect(dev?.mode).toBe("subagent")

    const rules = dev?.permissions ?? []
    const bash = rules.filter(r => r.action === "bash")
    // 兜底 deny 置首，白名单随后
    expect(bash[0]).toEqual({ action: "bash", resource: "*", effect: "deny" })
    expect(bash).toContainEqual({ action: "bash", resource: "<profile-test-command>*", effect: "allow" }) // 测试命令由 Profile 渲染，不硬编码 npm
    expect(bash).toContainEqual({ action: "bash", resource: "git status*", effect: "allow" })              // 只读 git 白名单
    expect(bash).toContainEqual({ action: "bash", resource: "git add*", effect: "allow" })                 // 本地写
    expect(bash).toContainEqual({ action: "bash", resource: "git commit*", effect: "allow" })
    // 写操作 deny 置尾（最后匹配优先）
    const indexOf = (resource: string) => bash.findIndex(r => r.resource === resource)
    expect(indexOf("git push*")).toBeGreaterThan(indexOf("git add*"))
    expect(bash.at(-1)?.effect).toBe("deny")
    expect(bash).toContainEqual({ action: "bash", resource: "git push*", effect: "deny" })
    expect(bash).toContainEqual({ action: "bash", resource: "git worktree*", effect: "deny" })
    expect(bash).toContainEqual({ action: "bash", resource: "gh pr create*", effect: "deny" })
    expect(bash).toContainEqual({ action: "bash", resource: "gh pr merge*", effect: "deny" })
    expect(bash).toContainEqual({ action: "bash", resource: "gh issue create*", effect: "deny" })

    // 单一基准：仅 worktree 内可编辑（避免仓库根双基准）
    expect(rules.filter(r => r.action === "edit")).toEqual([
      { action: "edit", resource: "*", effect: "deny" },
      { action: "edit", resource: ".worktree/**", effect: "allow" },
    ])
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

describe("Agent permissions parsing（V2 原生 permissions 数组）", () => {
  it("parses native permissions array preserving declaration order", () => {
    writeAgent("perm-agent", "subagent", `permissions:
  - action: bash
    resource: "*"
    effect: deny
  - action: bash
    resource: "git status*"
    effect: allow
  - action: edit
    resource: ".worktree/**"
    effect: allow`)
    const result = loadAgents(tmpDir)
    expect(result).toHaveLength(1)
    expect(result[0].permissions).toEqual([
      { action: "bash", resource: "*", effect: "deny" },
      { action: "bash", resource: "git status*", effect: "allow" },
      { action: "edit", resource: ".worktree/**", effect: "allow" },
    ])
  })

  it("defaults permissions to undefined when not specified", () => {
    writeAgent("no-perm", "primary")
    const result = loadAgents(tmpDir)
    expect(result[0].permissions).toBeUndefined()
  })

  it("skips malformed permission rules（缺 action/resource 或非法 effect）", () => {
    writeAgent("malformed-perm", "subagent", `permissions:
  - action: bash
    resource: "*"
    effect: deny
  - action: bash
    effect: allow
  - action: bash
    resource: "git push*"
    effect: maybe
  - just-a-string
  - action: edit
    resource: ".worktree/**"
    effect: allow`)
    const result = loadAgents(tmpDir)
    expect(result[0].permissions).toEqual([
      { action: "bash", resource: "*", effect: "deny" },
      { action: "edit", resource: ".worktree/**", effect: "allow" },
    ])
  })
})

describe("Profile 测试命令安全收敛（#137：杜绝首 token 权限放大）", () => {
  const agentsDir = path.resolve(import.meta.dirname || __dirname, "..", "assets", "agents")

  const bashRulesOf = (testCommand: string, key: string): AgentRule[] => {
    const payload = buildAgentPayloads(agentsDir, testCommand).find(p => p.key === key)
    return ((payload?.fields.permissions ?? []) as AgentRule[]).filter(r => r.action === "bash")
  }

  it("含 {testPaths} 的命令渲染为固定前缀 + `*`（\"npm test -- {testPaths}\" → \"npm test -- *\"）", () => {
    for (const key of ["developer", "goal-verify"]) {
      const bash = bashRulesOf("npm test -- {testPaths}", key)
      expect(bash, key).toContainEqual({ action: "bash", resource: "npm test -- *", effect: "allow" })
      // 严禁首 token 宽通配（npm* / npm * 均会放大到任意 npm 子命令）
      expect(bash.some(r => r.resource === "npm*" || r.resource === "npm *"), key).toBe(false)
    }
  })

  it("developer：放行 Profile 测试命令，拦截提权命令", () => {
    const bash = bashRulesOf("npm test -- {testPaths}", "developer")
    expect(matchPermissionRules(bash, "npm test -- test/foo.test.ts", "bash")).toBe("allow")
    for (const cmd of ["npm install", "npm run build", "npm publish", "npm exec -- rm -rf /", "npm ci", "bash -c 'rm -rf /'"]) {
      expect(matchPermissionRules(bash, cmd, "bash"), `${cmd} 应被拒绝`).toBe("deny")
    }
  })

  it("goal-verify：同样只放行固定前缀测试命令，publish 被拦截", () => {
    const bash = bashRulesOf("npm test -- {testPaths}", "goal-verify")
    expect(matchPermissionRules(bash, "npm test -- test/foo.test.ts", "bash")).toBe("allow")
    expect(matchPermissionRules(bash, "npm publish", "bash")).toBe("deny")
    expect(matchPermissionRules(bash, "npm install", "bash")).toBe("deny")
  })

  it("不含占位符的命令原样渲染（\"pytest\" → \"pytest*\"），其他命令仍被拦截", () => {
    const bash = bashRulesOf("pytest", "developer")
    expect(bash).toContainEqual({ action: "bash", resource: "pytest*", effect: "allow" })
    expect(matchPermissionRules(bash, "pytest test/foo.py", "bash")).toBe("allow")
    expect(matchPermissionRules(bash, "npm publish", "bash")).toBe("deny")
  })

  it("Profile 未配置测试命令时丢弃占位规则（不退化为 `*` 放行）", () => {
    for (const key of ["developer", "goal-verify"]) {
      const bash = bashRulesOf("", key)
      expect(bash.some(r => r.resource.includes("<profile-test-command>")), key).toBe(false)
      expect(bash.some(r => r.effect === "allow" && r.resource === "*"), key).toBe(false)
      expect(matchPermissionRules(bash, "npm test -- test/foo.test.ts", "bash"), key).toBe("deny")
    }
  })

  it("`{testPaths}` 前无固定前缀时丢弃占位规则（不生成空前缀宽放行）", () => {
    const bash = bashRulesOf("{testPaths}", "developer")
    expect(bash.some(r => r.resource.includes("<profile-test-command>"))).toBe(false)
    expect(matchPermissionRules(bash, "npm test -- test/foo.test.ts", "bash")).toBe("deny")
  })

  it("注册载荷中不存在未替换的占位符", () => {
    for (const payload of buildAgentPayloads(agentsDir, "npm test -- {testPaths}")) {
      const rules = (payload.fields.permissions ?? []) as AgentRule[]
      for (const rule of rules) {
        expect(rule.resource, payload.key).not.toContain("<profile-test-command>")
      }
    }
  })
})

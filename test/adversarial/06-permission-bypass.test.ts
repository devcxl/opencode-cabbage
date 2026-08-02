/**
 * 对抗测试 #6 — permission 语义：
 * 纯 Prompt 架构下 dev-lifecycle 作为 primary 编排器直接执行 git/gh 命令（"*": "allow"）；
 * 安全边界由用户审查与模型能力承担。本测试验证 permission 匹配原语本身正确：
 * 最后匹配优先、auto 模式仅 allow 放行、architect 只读代码只写 docs。
 */
import { describe, it, expect } from "vitest"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadAgents, type AgentEntry } from "../../src/plugin/agents.js"
import { matchPermission, isAllowedInAutoMode } from "../../src/kernel/permission.js"

const AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets/agents")

describe("adversarial #6 — permission 匹配语义", () => {
  it("最后匹配优先：deny 置尾覆盖前序 allow，规避模型注入规则顺序", () => {
    const rules = { "*": "allow", "git push*": "deny" }
    expect(matchPermission(rules, "git push origin main")).toBe("deny")
    const rules2 = { "*": "deny", "git status*": "allow" }
    expect(matchPermission(rules2, "gh pr merge 1")).toBe("deny")
  })

  it("auto 模式下仅 allow 放行；deny/ask 均拒绝", () => {
    const rules = { "*": "ask", "git status*": "allow" }
    expect(isAllowedInAutoMode(rules, "git status")).toBe(true)
    expect(isAllowedInAutoMode(rules, "git push origin main")).toBe(false)
  })

  it("dev-lifecycle 作为 primary 编排器拥有全部 bash 权限（纯 Prompt 架构）", () => {
    const agents = loadAgents(AGENTS_DIR)
    const dev = agents.find((a: AgentEntry) => a.key === "dev-lifecycle")
    expect(dev, "dev-lifecycle agent must exist").toBeDefined()
    const bash = dev!.permission?.bash as Record<string, string> | undefined
    expect(bash, "dev-lifecycle must declare bash permission rules").toBeDefined()
    // primary 编排器直接执行 push/PR/merge 等命令，全部 allow
    for (const cmd of [
      "git push origin feat/x",
      "gh pr create --title x",
      "gh pr merge 42",
      "git worktree add .worktree/x",
      "git checkout -b feat/x",
    ]) {
      expect(matchPermission(bash!, cmd), `${cmd} 应为 allow`).toBe("allow")
    }
  })

  it("architect 只读代码、只写 docs/assets 交付物", () => {
    const agents = loadAgents(AGENTS_DIR)
    const arch = agents.find((a: AgentEntry) => a.key === "architect")
    expect(arch, "architect agent must exist").toBeDefined()
    const edit = arch!.permission?.edit as Record<string, string> | undefined
    expect(edit, "architect must declare edit permission rules").toBeDefined()

    // 主工作区交付物
    expect(matchPermission(edit!, "docs/prd/x.md")).toBe("allow")
    expect(matchPermission(edit!, "docs/dev/specs/x.md")).toBe("allow")
    // 非 docs 仍拒绝
    expect(matchPermission(edit!, "src/index.ts")).toBe("deny")
  })

  it("goal-verify 只读：bash 只放行查询命令", () => {
    const agents = loadAgents(AGENTS_DIR)
    const gv = agents.find((a: AgentEntry) => a.key === "goal-verify")
    expect(gv, "goal-verify agent must exist").toBeDefined()
    const bash = gv!.permission?.bash as Record<string, string> | undefined
    expect(bash, "goal-verify must declare bash permission rules").toBeDefined()
    for (const cmd of ["git status", "git diff", "git log --oneline -5"]) {
      expect(matchPermission(bash!, cmd), `${cmd} 应为 allow`).toBe("allow")
    }
    for (const cmd of ["git push origin main", "gh pr merge 1", "npm publish"]) {
      expect(matchPermission(bash!, cmd), `${cmd} 不应 allow`).not.toBe("allow")
    }
  })
})

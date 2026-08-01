/**
 * 对抗测试 #6 — 模型绕过工具直接 gh pr create/merge / git push / git worktree remove：
 * OpenCode permission 模型（bash 规则 + 最后匹配优先 + auto 模式 deny 生效）必须拒绝，
 * 高风险写命令不得出现在 dev-lifecycle（primary）的 allow 集合。
 */
import { describe, it, expect } from "vitest"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { loadAgents, type AgentEntry } from "../../src/plugin/agents.js"
import { matchPermission, isAllowedInAutoMode } from "../../src/kernel/permission.js"

const AGENTS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../assets/agents")

/** 直接绕过生命周期工具的高风险写命令（spec §12 #6 / PRD 验收 3） */
const BYPASS_WRITE_COMMANDS = [
  "gh pr create --title x",
  "gh pr merge 42",
  "git push origin feat/x",
  "git worktree remove .worktree/x",
  "git worktree add .worktree/x",
  "git checkout -b feat/x",
  "git tag v1.0.0",
  "gh issue close 42",
  "gh issue create --title x",
  "gh release create v1.0.0",
  "npm publish",
]

function devLifecycleBashRules(): Record<string, string> {
  const agents = loadAgents(AGENTS_DIR)
  const dev = agents.find((a: AgentEntry) => a.key === "dev-lifecycle")
  expect(dev, "dev-lifecycle agent must exist").toBeDefined()
  const bash = dev!.permission?.bash as Record<string, string> | undefined
  expect(bash, "dev-lifecycle must declare bash permission rules").toBeDefined()
  return bash!
}

describe("adversarial #6 — 直接 gh/git 写命令绕过必须被拒", () => {
  it("dev-lifecycle 的 bash 规则对全部写命令解析为非 allow（deny/ask）", () => {
    const rules = devLifecycleBashRules()
    for (const cmd of BYPASS_WRITE_COMMANDS) {
      expect(matchPermission(rules, cmd), `${cmd} 不应 allow`).not.toBe("allow")
    }
  })

  it("auto 模式下写命令一律拒绝（仅 allow 放行）", () => {
    const rules = devLifecycleBashRules()
    for (const cmd of BYPASS_WRITE_COMMANDS) {
      expect(isAllowedInAutoMode(rules, cmd), `${cmd} 在 auto 模式必须被拒`).toBe(false)
    }
  })

  it("只读查询命令仍在 allow 集合（工作流不被锁死）", () => {
    const rules = devLifecycleBashRules()
    for (const cmd of ["git status", "git log --oneline -5", "gh pr view 42", "gh issue view 5"]) {
      expect(matchPermission(rules, cmd), `${cmd} 应为 allow`).toBe("allow")
    }
  })

  it("architect 的 edit 规则放行主工作区与 planning worktree 的 docs/assets 交付物", () => {
    const agents = loadAgents(AGENTS_DIR)
    const arch = agents.find((a: AgentEntry) => a.key === "architect")
    expect(arch, "architect agent must exist").toBeDefined()
    const edit = arch!.permission?.edit as Record<string, string> | undefined
    expect(edit, "architect must declare edit permission rules").toBeDefined()

    // 主工作区交付物
    expect(matchPermission(edit!, "docs/prd/x.md")).toBe("allow")
    expect(matchPermission(edit!, "docs/dev/specs/x.md")).toBe("allow")
    // planning worktree 内交付物（相对主工作区路径，§7.4 缺陷回归）
    expect(matchPermission(edit!, ".worktree/planning-user-auth/docs/prd/x.md")).toBe("allow")
    expect(matchPermission(edit!, ".worktree/planning-user-auth/docs/dev/specs/x.md")).toBe("allow")
    // worktree 内非交付物仍拒绝
    expect(matchPermission(edit!, ".worktree/planning-user-auth/src/index.ts")).toBe("deny")
    // 主工作区非 docs 仍拒绝
    expect(matchPermission(edit!, "src/index.ts")).toBe("deny")
  })

  it("最后匹配优先：deny 置尾覆盖前序 allow，规避模型注入规则顺序", () => {
    const rules = { "*": "allow", "git push*": "deny" }
    expect(matchPermission(rules, "git push origin main")).toBe("deny")
    const rules2 = { "*": "deny", "git status*": "allow" }
    expect(matchPermission(rules2, "gh pr merge 1")).toBe("deny")
  })
})

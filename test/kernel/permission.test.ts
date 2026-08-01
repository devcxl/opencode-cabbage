import { describe, it, expect } from "vitest"
import { matchPermission, isAllowedInAutoMode, permissionPatternMatches } from "../../src/kernel/permission.js"

/**
 * OpenCode permission 语义（spec §7.2 / PRD 假设 2）：
 * bash 模式规则 + 最后匹配优先 + auto 模式 deny 生效。
 */

describe("matchPermission — 最后匹配优先", () => {
  it("无匹配返回 ask（默认询问）", () => {
    expect(matchPermission({ "npm *": "allow" }, "rm -rf /")).toBe("ask")
  })

  it("白名单前缀匹配：git status* 命中 git status 与带参数", () => {
    const rules = { "*": "deny", "git status*": "allow" }
    expect(matchPermission(rules, "git status")).toBe("allow")
    expect(matchPermission(rules, "git status --short")).toBe("allow")
  })

  it("deny 置尾覆盖同前缀 allow：git push 被拒", () => {
    const rules = {
      "*": "deny",
      "git push*": "deny",
      "git status*": "allow",
      "git log*": "allow",
    }
    expect(matchPermission(rules, "git push origin main")).toBe("deny")
    expect(matchPermission(rules, "git status")).toBe("allow")
  })

  it("最后匹配优先：后面的规则覆盖前面的同前缀规则", () => {
    // allow 在 deny 之后 → allow 生效
    const rules = { "git *": "deny", "git status*": "allow" }
    expect(matchPermission(rules, "git status")).toBe("allow")
    // deny 在 allow 之后 → deny 生效
    const rules2 = { "git *": "allow", "git push*": "deny" }
    expect(matchPermission(rules2, "git push origin")).toBe("deny")
  })

  it("兜底 * 规则拦截所有未显式 allow 的命令", () => {
    const rules = {
      "*": "deny",
      "npm *": "allow",
      "git status*": "allow",
    }
    expect(matchPermission(rules, "npm test")).toBe("allow")
    expect(matchPermission(rules, "git push origin")).toBe("deny")
    expect(matchPermission(rules, "gh pr create")).toBe("deny")
  })

  it("高风险写命令全部 deny（黑名单完整性）", () => {
    const rules = {
      "*": "deny",
      "git push*": "deny",
      "git worktree *": "deny",
      "git checkout -b*": "deny",
      "gh pr create*": "deny",
      "gh pr merge*": "deny",
      "gh pr review*": "deny",
      "gh issue create*": "deny",
      "gh issue edit*": "deny",
      "gh issue close*": "deny",
      "gh issue comment*": "deny",
      "gh label*": "deny",
      "gh release*": "deny",
    }
    for (const cmd of [
      "git push origin main",
      "git worktree add",
      "git worktree remove --force",
      "git checkout -b feat/x",
      "gh pr create",
      "gh pr merge 12",
      "gh pr review 12 --approve",
      "gh issue create",
      "gh issue edit 5",
      "gh issue close 5",
      "gh issue comment 5 --body hi",
      "gh label create",
      "gh release create v1",
    ]) {
      expect(matchPermission(rules, cmd)).toBe("deny")
    }
  })

  it("只读 gh 白名单 allow", () => {
    const rules = {
      "*": "deny",
      "gh pr view*": "allow",
      "gh pr diff*": "allow",
      "gh pr checks*": "allow",
      "gh issue view*": "allow",
    }
    expect(matchPermission(rules, "gh pr view 12")).toBe("allow")
    expect(matchPermission(rules, "gh pr diff 12")).toBe("allow")
    expect(matchPermission(rules, "gh pr checks 12")).toBe("allow")
    expect(matchPermission(rules, "gh issue view 5")).toBe("allow")
  })
})

describe("matchPermission — glob（`**`）路径规则（对齐引擎 edit/read 语义）", () => {
  it("docs/** 匹配任意层级子路径", () => {
    const rules = { "*": "deny", "docs/**": "allow" }
    expect(matchPermission(rules, "docs/prd/x.md")).toBe("allow")
    expect(matchPermission(rules, "docs/dev/specs/x.md")).toBe("allow")
    expect(matchPermission(rules, "src/index.ts")).toBe("deny")
  })

  it(".worktree/<slug>/docs/** 放行 planning worktree 内交付物", () => {
    const rules = { "*": "deny", "docs/**": "allow", ".worktree/**/docs/**": "allow" }
    expect(matchPermission(rules, ".worktree/planning-user-auth/docs/prd/x.md")).toBe("allow")
    expect(matchPermission(rules, ".worktree/planning-user-auth/docs/dev/specs/x.md")).toBe("allow")
    // worktree 内非 docs 仍拒绝
    expect(matchPermission(rules, ".worktree/planning-user-auth/src/index.ts")).toBe("deny")
  })

  it("`*` 单段不跨目录、`**` 跨目录", () => {
    expect(permissionPatternMatches("docs/*.md", "docs/a.md")).toBe(true)
    expect(permissionPatternMatches("docs/*.md", "docs/sub/a.md")).toBe(false)
    expect(permissionPatternMatches("docs/**/*.md", "docs/sub/a.md")).toBe(true)
    expect(permissionPatternMatches("**/agent-out/**", "a/b/agent-out/x.txt")).toBe(true)
  })
})

describe("isAllowedInAutoMode — auto 模式 deny 生效", () => {
  it("仅 allow 放行，deny 与 ask 均拒绝", () => {
    const rules = { "*": "deny", "npm *": "allow" }
    expect(isAllowedInAutoMode(rules, "npm test")).toBe(true)
    expect(isAllowedInAutoMode(rules, "git push")).toBe(false)
    expect(isAllowedInAutoMode(rules, "unknown-cmd")).toBe(false)
  })

  it("无兜底规则时未匹配命令（ask）在 auto 模式被拒绝", () => {
    const rules = { "npm *": "allow" }
    expect(isAllowedInAutoMode(rules, "npm test")).toBe(true)
    expect(isAllowedInAutoMode(rules, "git status")).toBe(false)
  })
})

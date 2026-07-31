/**
 * 对抗测试 #12 — 未分类变更版本提议：
 * 低质量模型给出含未分类 commit 的变更集 → proposeVersion 必须拒绝
 * （UNCLASSIFIED_CHANGES），版本提议前必须完成分类。
 */
import { describe, it, expect } from "vitest"
import { proposeVersion, classifyChanges, type ReleaseChange } from "../../src/kernel/release.js"

const change = (title: string, category: ReleaseChange["category"] = "fix", breaking = false): ReleaseChange => ({
  sha: "abc",
  title,
  category,
  breaking,
})

describe("adversarial #12 — 未分类变更版本提议必须被拒", () => {
  it("含 unclassified 变更 → UNCLASSIFIED_CHANGES，列出未分类项", () => {
    const result = proposeVersion("1.4.2", [
      change("fix(core): bug", "fix"),
      change("random commit", "unclassified"),
    ])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("UNCLASSIFIED_CHANGES")
      if (result.code === "UNCLASSIFIED_CHANGES") {
        expect(result.unclassified).toEqual([{ sha: "abc", title: "random commit" }])
      }
    }
  })

  it("全部变更已分类 → 正常提议（不被误伤）", () => {
    const result = proposeVersion("1.4.2", [
      change("feat(core): new api", "feature"),
      change("fix(core): bug", "fix"),
    ])
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.proposed).toBe("1.5.0")
  })

  it("非 conventional 标题被 classifyChanges 标记为 unclassified（防漏网）", () => {
    const classified = classifyChanges([{ sha: "s1", title: "wip stuff" }, { sha: "s2", title: "feat: x" }])
    expect(classified[0].category).toBe("unclassified")
    expect(classified[1].category).toBe("feature")
  })

  it("非法当前版本 → INVALID_VERSION", () => {
    const result = proposeVersion("banana", [change("fix: x", "fix")])
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("INVALID_VERSION")
  })
})

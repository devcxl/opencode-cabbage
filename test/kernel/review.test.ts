import { describe, it, expect, beforeAll } from "vitest"
import {
  mergeTaskPR,
  checkBranchProtection,
  setMergeGhExecutor,
  type GhFn,
} from "../../src/kernel/review.js"

// ─── checkBranchProtection ───

describe("checkBranchProtection", () => {
  it("reports protection enabled when the API returns a protection config", async () => {
    const calls: string[] = []
    setMergeGhExecutor((async (args: string) => {
      calls.push(args)
      return {
        stdout: JSON.stringify({
          required_pull_request_reviews: { dismiss_stale_reviews: true },
          required_status_checks: { checks: [{ context: "CI" }, { context: "lint" }] },
        }),
        stderr: "",
      }
    }) as GhFn)

    const result = await checkBranchProtection("owner", "repo")
    expect(result.exists).toBe(true)
    expect(result.requiredChecks).toEqual(["CI", "lint"])
    expect(result.requiresPR).toBe(true)
    expect(result.dismissesStale).toBe(true)
    expect(calls.some(c => c.includes("branches/main/protection"))).toBe(true)
  })

  it("reports protection disabled when the API call fails", async () => {
    setMergeGhExecutor((async () => {
      throw new Error("404")
    }) as GhFn)
    const result = await checkBranchProtection("owner", "repo")
    expect(result.exists).toBe(false)
    expect(result.requiredChecks).toEqual([])
  })
})

// ─── mergeTaskPR ───

describe("mergeTaskPR", () => {
  it("requires verifiedSha and returns error if missing", async () => {
    const result = await mergeTaskPR(1, "")
    expect(result.success).toBe(false)
    expect(result.error).toContain("verifiedSha is required")
  })

  it("attempts merge with --match-head-commit flag", async () => {
    const calls: string[] = []
    setMergeGhExecutor((async (args: string) => {
      calls.push(args)
      return { stdout: "Merged", stderr: "" }
    }) as GhFn)

    const result = await mergeTaskPR(42, "abc123def456")
    expect(result.success).toBe(true)
    // 验证使用了 --match-head-commit
    expect(calls.some(c => c.includes("--match-head-commit") && c.includes("abc123def456"))).toBe(true)
  })

  it("blocks merge when gh fails", async () => {
    setMergeGhExecutor((async () => {
      throw new Error("Merge conflict")
    }) as GhFn)

    const result = await mergeTaskPR(42, "abc123")
    expect(result.success).toBe(false)
    expect(result.error).toContain("Merge conflict")
  })
})

beforeAll(() => {
  // 默认 executor 恒抛错，避免真实调用宿主 gh
  setMergeGhExecutor((async () => {
    throw new Error("unexpected gh call")
  }) as GhFn)
})

/**
 * 对抗测试 #2 — 非法 branch/worktree 路径：
 * 分支已存在未合并 / 已合并残留 / 目录检出错误分支 → worktree-start 必须拒绝，
 * 且任何 git 调用不得出现 --force（不做暴力覆盖）。
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { worktreeStart } from "../../src/kernel/worktree.js"
import type { setWorktreeGitExecutor as SetGitExecutorType } from "../../src/kernel/worktree.js"

type GitFn = (args: string) => Promise<{ stdout: string; stderr: string }>

let setGit: typeof SetGitExecutorType
let projectDir: string

beforeAll(async () => {
  const mod = await import("../../src/kernel/worktree.js")
  setGit = mod.setWorktreeGitExecutor
})

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(os.tmpdir(), "cabbage-adv-worktree-"))
  setGit(() => {
    throw new Error("unexpected git call")
  })
})

afterEach(async () => {
  setGit(null)
  await rm(projectDir, { recursive: true, force: true })
})

describe("adversarial #2 — 非法 branch/worktree 路径必须被拒绝", () => {
  it("分支已存在未合并 → BRANCH_EXISTS_UNMERGED，不执行 worktree add，无 --force", async () => {
    const calls: string[] = []
    setGit(async (args) => {
      calls.push(args)
      if (args.includes("rev-parse --verify refs/heads/")) return { stdout: "abc123", stderr: "" }
      if (args.includes("merge-base --is-ancestor")) throw new Error("not an ancestor")
      throw new Error(`unexpected git call: ${args}`)
    })

    const result = await worktreeStart({ projectDir, slug: "user-auth-login", base: "main" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("BRANCH_EXISTS_UNMERGED")
    expect(calls.some(c => c.startsWith("worktree add"))).toBe(false)
    for (const c of calls) expect(c).not.toContain("--force")
  })

  it("分支已存在且已合并（残留）→ BRANCH_EXISTS，要求人工清理而非强制复用", async () => {
    const calls: string[] = []
    setGit(async (args) => {
      calls.push(args)
      if (args.includes("rev-parse --verify refs/heads/")) return { stdout: "abc123", stderr: "" }
      if (args.includes("merge-base --is-ancestor")) return { stdout: "", stderr: "" }
      throw new Error(`unexpected git call: ${args}`)
    })

    const result = await worktreeStart({ projectDir, slug: "user-auth-login", base: "main" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("BRANCH_EXISTS")
      expect(result.message).toMatch(/manually/i)
    }
    expect(calls.some(c => c.startsWith("worktree add"))).toBe(false)
  })

  it("目录已存在但检出错误分支 → BRANCH_MISMATCH，拒绝复用", async () => {
    await mkdir(path.join(projectDir, ".worktree/user-auth-login"), { recursive: true })
    const calls: string[] = []
    setGit(async (args) => {
      calls.push(args)
      if (args.includes("rev-parse --abbrev-ref HEAD")) return { stdout: "main", stderr: "" }
      throw new Error(`unexpected git call: ${args}`)
    })

    const result = await worktreeStart({ projectDir, slug: "user-auth-login", base: "main" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("BRANCH_MISMATCH")
    expect(calls.some(c => c.startsWith("worktree add"))).toBe(false)
  })

  it("模型无法通过路径逃逸绕过：目录/分支不一致一律拒绝，不落任何写命令", async () => {
    // 恶意提交 "./.worktree/../../other-dir" 式的路径由 slug 约束（[a-z0-9-]）阻断，
    // 这里验证 worktreeStart 对已存在目录的严格校验本身不产生 --force
    await mkdir(path.join(projectDir, ".worktree/user-auth-login"), { recursive: true })
    const calls: string[] = []
    setGit(async (args) => {
      calls.push(args)
      if (args.includes("rev-parse --abbrev-ref HEAD")) return { stdout: "feat/other", stderr: "" }
      throw new Error(`unexpected git call: ${args}`)
    })

    const result = await worktreeStart({ projectDir, slug: "user-auth-login", base: "main" })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("BRANCH_MISMATCH")
    for (const c of calls) expect(c).not.toContain("--force")
    expect(calls.some(c => c.startsWith("worktree add"))).toBe(false)
  })
})

import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { worktreeStart, destroyWorktree } from "../../src/kernel/worktree.js"
import type { setWorktreeGitExecutor as SetGitExecutorType } from "../../src/kernel/worktree.js"

type GitFn = (args: string) => Promise<{ stdout: string; stderr: string }>

let setGit: typeof SetGitExecutorType
let projectDir: string

beforeAll(async () => {
  const mod = await import("../../src/kernel/worktree.js")
  setGit = mod.setWorktreeGitExecutor
})

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(os.tmpdir(), "worktree-test-"))
  setGit(() => {
    throw new Error("unexpected git call")
  })
})

afterEach(async () => {
  setGit(null)
  await rm(projectDir, { recursive: true, force: true })
})

describe("worktreeStart", () => {
  it("创建：目录不存在时按 slug 派生分支并 git worktree add", async () => {
    const calls: string[] = []
    setGit(async (args) => {
      calls.push(args)
      if (args.startsWith("worktree add")) return { stdout: "", stderr: "" }
      throw new Error(`unexpected git call: ${args}`)
    })

    const result = await worktreeStart({ projectDir, slug: "user-auth-login", base: "main" })
    expect(result).toEqual({
      ok: true,
      branch: "feat/user-auth-login",
      path: path.join(projectDir, ".worktree/user-auth-login"),
      reused: false,
    })
    // 先查分支是否已存在，再 add
    expect(calls.some(c => c.includes("rev-parse --verify refs/heads/feat/user-auth-login"))).toBe(true)
    const addCall = calls.find(c => c.startsWith("worktree add"))
    expect(addCall).toBeDefined()
    if (addCall) {
      expect(addCall).toContain("worktree add -b feat/user-auth-login")
      expect(addCall).toContain(".worktree/user-auth-login")
      expect(addCall).toContain("main")
      expect(addCall).not.toContain("--force")
    }
  })

  it("创建：支持非 feat 分支类型", async () => {
    setGit(async (args) => {
      if (args.startsWith("worktree add")) return { stdout: "", stderr: "" }
      throw new Error(`unexpected git call: ${args}`)
    })

    const result = await worktreeStart({ projectDir, slug: "fix-auth-timeout", base: "main", branchType: "fix" })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.branch).toBe("fix/fix-auth-timeout")
    }
  })

  it("创建：分支已存在且未合并 → 拒绝，不执行 add", async () => {
    const calls: string[] = []
    setGit(async (args) => {
      calls.push(args)
      if (args.includes("rev-parse --verify refs/heads/")) return { stdout: "abc123", stderr: "" }
      if (args.includes("merge-base --is-ancestor")) throw new Error("not an ancestor")
      throw new Error(`unexpected git call: ${args}`)
    })

    const result = await worktreeStart({ projectDir, slug: "user-auth-login", base: "main" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("BRANCH_EXISTS_UNMERGED")
    }
    expect(calls.some(c => c.startsWith("worktree add"))).toBe(false)
  })

  it("创建：分支已存在且已合并 → 拒绝残留，不执行 add", async () => {
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
    }
    expect(calls.some(c => c.startsWith("worktree add"))).toBe(false)
  })

  it("复用：目录存在且分支一致 → 返回 reused，不执行任何写命令", async () => {
    await mkdir(path.join(projectDir, ".worktree/user-auth-login"), { recursive: true })
    const calls: string[] = []
    setGit(async (args) => {
      calls.push(args)
      if (args.includes("rev-parse --abbrev-ref HEAD")) return { stdout: "feat/user-auth-login", stderr: "" }
      throw new Error(`unexpected git call: ${args}`)
    })

    const result = await worktreeStart({ projectDir, slug: "user-auth-login", base: "main" })
    expect(result).toEqual({
      ok: true,
      branch: "feat/user-auth-login",
      path: path.join(projectDir, ".worktree/user-auth-login"),
      reused: true,
    })
    expect(calls.some(c => c.startsWith("worktree add"))).toBe(false)
  })

  it("复用：目录存在但分支不一致 → 报错 BRANCH_MISMATCH", async () => {
    await mkdir(path.join(projectDir, ".worktree/user-auth-login"), { recursive: true })
    const calls: string[] = []
    setGit(async (args) => {
      calls.push(args)
      if (args.includes("rev-parse --abbrev-ref HEAD")) return { stdout: "main", stderr: "" }
      throw new Error(`unexpected git call: ${args}`)
    })

    const result = await worktreeStart({ projectDir, slug: "user-auth-login", base: "main" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("BRANCH_MISMATCH")
      expect(result.message).toContain("main")
      expect(result.message).toContain("feat/user-auth-login")
    }
    expect(calls.some(c => c.startsWith("worktree add"))).toBe(false)
  })

  it("创建：git add 失败 → GIT_FAILED", async () => {
    setGit(async (args) => {
      if (args.startsWith("worktree add")) throw new Error("fatal: could not create worktree")
      throw new Error(`unexpected git call: ${args}`)
    })

    const result = await worktreeStart({ projectDir, slug: "user-auth-login", base: "main" })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("GIT_FAILED")
    }
  })
})

describe("destroyWorktree", () => {
  const worktreeDir = (): string => path.join(projectDir, ".worktree/user-auth-login")
  const branch = "feat/user-auth-login"

  it("PR 已合并且干净 → git worktree remove + branch -D，无 --force", async () => {
    await mkdir(worktreeDir(), { recursive: true })
    const calls: string[] = []
    setGit(async (args) => {
      calls.push(args)
      if (args.includes("status --porcelain")) return { stdout: "", stderr: "" }
      if (args.startsWith("worktree remove")) return { stdout: "", stderr: "" }
      if (args.includes("rev-parse --verify refs/heads/")) return { stdout: "abc123", stderr: "" }
      if (args.startsWith("branch -D")) return { stdout: "", stderr: "" }
      throw new Error(`unexpected git call: ${args}`)
    })

    const result = await destroyWorktree({ worktreeDir: worktreeDir(), branch, prMerged: true, userConfirmed: false })
    expect(result).toEqual({ ok: true, reason: "OK" })
    expect(calls.some(c => c.startsWith("worktree remove"))).toBe(true)
    expect(calls.some(c => c.startsWith("branch -D"))).toBe(true)
    for (const c of calls) {
      expect(c).not.toContain("--force")
    }
  })

  it("PR 已合并但 worktree 脏 → 拒绝 DIRTY_WORKTREE，不执行 remove", async () => {
    await mkdir(worktreeDir(), { recursive: true })
    const calls: string[] = []
    setGit(async (args) => {
      calls.push(args)
      if (args.includes("status --porcelain")) return { stdout: " M src/kernel/worktree.ts", stderr: "" }
      throw new Error(`unexpected git call: ${args}`)
    })

    const result = await destroyWorktree({ worktreeDir: worktreeDir(), branch, prMerged: true, userConfirmed: false })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("DIRTY_WORKTREE")
    }
    expect(calls.some(c => c.startsWith("worktree remove"))).toBe(false)
  })

  it("PR 未合并且未确认 → 拒绝 PR_NOT_MERGED，不查推送", async () => {
    await mkdir(worktreeDir(), { recursive: true })
    const calls: string[] = []
    setGit(async (args) => {
      calls.push(args)
      if (args.includes("status --porcelain")) return { stdout: "", stderr: "" }
      throw new Error(`unexpected git call: ${args}`)
    })

    const result = await destroyWorktree({ worktreeDir: worktreeDir(), branch, prMerged: false, userConfirmed: false })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("PR_NOT_MERGED")
    }
    expect(calls.some(c => c.includes("ls-remote"))).toBe(false)
    expect(calls.some(c => c.startsWith("worktree remove"))).toBe(false)
  })

  it("PR 未合并、已确认但分支未推送 → 拒绝 BRANCH_NOT_PUSHED", async () => {
    await mkdir(worktreeDir(), { recursive: true })
    const calls: string[] = []
    setGit(async (args) => {
      calls.push(args)
      if (args.includes("status --porcelain")) return { stdout: "", stderr: "" }
      if (args.includes("ls-remote")) return { stdout: "", stderr: "" }
      throw new Error(`unexpected git call: ${args}`)
    })

    const result = await destroyWorktree({ worktreeDir: worktreeDir(), branch, prMerged: false, userConfirmed: true })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.reason).toBe("BRANCH_NOT_PUSHED")
    }
    expect(calls.some(c => c.startsWith("worktree remove"))).toBe(false)
  })

  it("PR 未合并、已确认且分支已推送 → 删除 OK", async () => {
    await mkdir(worktreeDir(), { recursive: true })
    const calls: string[] = []
    setGit(async (args) => {
      calls.push(args)
      if (args.includes("status --porcelain")) return { stdout: "", stderr: "" }
      if (args.includes("ls-remote")) return { stdout: `abc123\trefs/heads/${branch}`, stderr: "" }
      if (args.startsWith("worktree remove")) return { stdout: "", stderr: "" }
      if (args.includes("rev-parse --verify refs/heads/")) return { stdout: "abc123", stderr: "" }
      if (args.startsWith("branch -D")) return { stdout: "", stderr: "" }
      throw new Error(`unexpected git call: ${args}`)
    })

    const result = await destroyWorktree({ worktreeDir: worktreeDir(), branch, prMerged: false, userConfirmed: true })
    expect(result).toEqual({ ok: true, reason: "OK" })
    expect(calls.some(c => c.startsWith("worktree remove"))).toBe(true)
    for (const c of calls) {
      expect(c).not.toContain("--force")
    }
  })

  it("worktree 不存在 → 幂等 NOT_FOUND，不执行任何 git 调用", async () => {
    const calls: string[] = []
    setGit(async (args) => {
      calls.push(args)
      return { stdout: "", stderr: "" }
    })

    const result = await destroyWorktree({ worktreeDir: worktreeDir(), branch, prMerged: false, userConfirmed: false })
    expect(result).toEqual({ ok: true, reason: "NOT_FOUND" })
    expect(calls).toHaveLength(0)
  })

  it("本地分支不存在时跳过 branch -D", async () => {
    await mkdir(worktreeDir(), { recursive: true })
    const calls: string[] = []
    setGit(async (args) => {
      calls.push(args)
      if (args.includes("status --porcelain")) return { stdout: "", stderr: "" }
      if (args.startsWith("worktree remove")) return { stdout: "", stderr: "" }
      if (args.includes("rev-parse --verify refs/heads/")) throw new Error("branch not found")
      throw new Error(`unexpected git call: ${args}`)
    })

    const result = await destroyWorktree({ worktreeDir: worktreeDir(), branch, prMerged: true, userConfirmed: false })
    expect(result).toEqual({ ok: true, reason: "OK" })
    expect(calls.some(c => c.startsWith("branch -D"))).toBe(false)
  })
})

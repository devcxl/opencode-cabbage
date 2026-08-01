/**
 * 对抗测试 #7 — 脏 worktree 销毁：
 * 有未提交变更的 worktree 必须被 destroyWorktree 拒绝（DIRTY_WORKTREE），
 * 无任何 --force 路径；未合并 PR / 未推送分支同样需要人工确认。
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { destroyWorktree } from "../../src/kernel/worktree.js"
import type { setWorktreeGitExecutor as SetGitExecutorType } from "../../src/kernel/worktree.js"

type GitFn = (args: string) => Promise<{ stdout: string; stderr: string }>

let setGit: typeof SetGitExecutorType
let projectDir: string

beforeAll(async () => {
  const mod = await import("../../src/kernel/worktree.js")
  setGit = mod.setWorktreeGitExecutor
})

beforeEach(async () => {
  projectDir = await mkdtemp(path.join(os.tmpdir(), "cabbage-adv-destroy-"))
  setGit(() => {
    throw new Error("unexpected git call")
  })
})

afterEach(async () => {
  setGit(null)
  await rm(projectDir, { recursive: true, force: true })
})

const worktreeDir = () => path.join(projectDir, ".worktree/user-auth-login")
const branch = "feat/user-auth-login"

describe("adversarial #7 — 脏 worktree 销毁必须被拒", () => {
  it("worktree 脏 → DIRTY_WORKTREE，不执行 remove，无 --force", async () => {
    await mkdir(worktreeDir(), { recursive: true })
    const calls: string[] = []
    setGit(async (args) => {
      calls.push(args)
      if (args.includes("status --porcelain")) return { stdout: " M src/kernel/worktree.ts", stderr: "" }
      throw new Error(`unexpected git call: ${args}`)
    })

    const result = await destroyWorktree({ worktreeDir: worktreeDir(), branch, prMerged: true, userConfirmed: false })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("DIRTY_WORKTREE")
    expect(calls.some(c => c.startsWith("worktree remove"))).toBe(false)
    for (const c of calls) expect(c).not.toContain("--force")
  })

  it("未合并 PR + 无确认 → PR_NOT_MERGED，不查推送、不删除", async () => {
    await mkdir(worktreeDir(), { recursive: true })
    const calls: string[] = []
    setGit(async (args) => {
      calls.push(args)
      if (args.includes("status --porcelain")) return { stdout: "", stderr: "" }
      throw new Error(`unexpected git call: ${args}`)
    })

    const result = await destroyWorktree({ worktreeDir: worktreeDir(), branch, prMerged: false, userConfirmed: false })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("PR_NOT_MERGED")
    expect(calls.some(c => c.includes("ls-remote"))).toBe(false)
    expect(calls.some(c => c.startsWith("worktree remove"))).toBe(false)
  })

  it("已确认但分支未推送 → BRANCH_NOT_PUSHED（拒绝删除未备份分支）", async () => {
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
    if (!result.ok) expect(result.reason).toBe("BRANCH_NOT_PUSHED")
    expect(calls.some(c => c.startsWith("worktree remove"))).toBe(false)
  })

  it("任何成功删除路径都不含 --force（preflight 语义，无强制删除面）", async () => {
    await mkdir(worktreeDir(), { recursive: true })
    const calls: string[] = []
    setGit(async (args) => {
      calls.push(args)
      if (args.includes("status --porcelain")) return { stdout: "", stderr: "" }
      if (args.includes("ls-remote")) return { stdout: `abc\trefs/heads/${branch}`, stderr: "" }
      if (args.startsWith("worktree remove")) return { stdout: "", stderr: "" }
      if (args.includes("refs/heads/")) return { stdout: "abc", stderr: "" }
      if (args.startsWith("branch -D")) return { stdout: "", stderr: "" }
      throw new Error(`unexpected git call: ${args}`)
    })

    const result = await destroyWorktree({ worktreeDir: worktreeDir(), branch, prMerged: false, userConfirmed: true })
    expect(result.ok).toBe(true)
    for (const c of calls) expect(c).not.toContain("--force")
  })
})

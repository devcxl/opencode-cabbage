import { exec } from "node:child_process"
import { promisify } from "node:util"
import path from "node:path"
import { symlink } from "node:fs/promises"
import { branchFor, worktreeFor } from "./slug.js"
import type { BranchType } from "./slug.js"
import { pathExists } from "../util/fs.js"
import { escapeShellArg } from "../util/shell.js"

const execAsync = promisify(exec)

type GitFn = (args: string) => Promise<{ stdout: string; stderr: string }>

let worktreeGitExecutor: GitFn | null = null

export function setWorktreeGitExecutor(fn: GitFn | null): void {
  worktreeGitExecutor = fn
}

async function git(args: string): Promise<{ stdout: string; stderr: string }> {
  if (worktreeGitExecutor) {
    return worktreeGitExecutor(args)
  }
  return execAsync(`git ${args}`)
}

// ─── worktree-start：创建 / 复用校验 ───

export type WorktreeStartResult =
  | { ok: true; branch: string; path: string; reused: boolean }
  | { ok: false; code: "BRANCH_EXISTS" | "BRANCH_EXISTS_UNMERGED" | "BRANCH_MISMATCH" | "INVALID_SLUG" | "GIT_FAILED"; message: string }

export interface WorktreeStartInput {
  projectDir: string
  slug: string
  base: string
  branchType?: BranchType
}

/** 合法 kebab-case slug（与 slug.ts 一致；防御：从远端标题派生的 slug 也必须过此关） */
const SLUG_SAFE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** git 分支名安全白名单：仅允许分支名合法字符，杜绝 shell 元字符 */
const BRANCH_SAFE = /^[A-Za-z0-9._/-]+$/

/** 分支已存在（本地 ref），未合并 → BRANCH_EXISTS_UNMERGED；已合并残留 → BRANCH_EXISTS */
export async function worktreeStart(input: WorktreeStartInput): Promise<WorktreeStartResult> {
  if (!SLUG_SAFE.test(input.slug)) {
    return { ok: false, code: "INVALID_SLUG", message: `Invalid worktree slug format: ${input.slug}` }
  }
  if (!BRANCH_SAFE.test(input.base)) {
    return { ok: false, code: "INVALID_SLUG", message: `Invalid base branch name: ${input.base}` }
  }

  const branch = branchFor(input.slug, input.branchType ?? "feat")
  const worktreeDir = path.join(input.projectDir, worktreeFor(input.slug))

  if (await pathExists(worktreeDir)) {
    return reuseWorktree(worktreeDir, branch)
  }

  if (await branchExists(branch)) {
    const merged = await isMergedToBase(branch, input.base)
    return merged
      ? { ok: false, code: "BRANCH_EXISTS", message: `branch ${branch} already exists and is merged; remove leftover branch manually` }
      : { ok: false, code: "BRANCH_EXISTS_UNMERGED", message: `branch ${branch} already exists and is not merged into ${input.base}` }
  }

  try {
    await git(`worktree add -b '${escapeShellArg(branch)}' '${escapeShellArg(worktreeDir)}' '${escapeShellArg(input.base)}'`)
    await linkSharedNodeModules(input.projectDir, worktreeDir)
    return { ok: true, branch, path: worktreeDir, reused: false }
  } catch (err) {
    return { ok: false, code: "GIT_FAILED", message: String(err) }
  }
}

/**
 * worktree 依赖复用：主工作区已有 node_modules 且 worktree 无 → 符号链接
 * （避免每个 worktree 重新 npm install 约 1-2 分钟；非 Node 项目自然跳过）。
 * 失败不阻塞（模型可自行安装）。
 */
async function linkSharedNodeModules(projectDir: string, worktreeDir: string): Promise<void> {
  try {
    const src = path.join(projectDir, "node_modules")
    const dst = path.join(worktreeDir, "node_modules")
    if ((await pathExists(src)) && !(await pathExists(dst))) {
      await symlink(src, dst, "dir")
    }
  } catch {
    // 链接失败（如跨文件系统/权限）：忽略，worktree 可自行安装
  }
}

/** 目录已存在：HEAD 分支与期望分支一致才复用，否则报错 */
async function reuseWorktree(worktreeDir: string, branch: string): Promise<WorktreeStartResult> {
  try {
    const { stdout } = await git(`-C '${escapeShellArg(worktreeDir)}' rev-parse --abbrev-ref HEAD`)
    const current = stdout.trim()
    if (current !== branch) {
      return {
        ok: false,
        code: "BRANCH_MISMATCH",
        message: `worktree at ${worktreeDir} is on branch ${current}, expected ${branch}`,
      }
    }
    return { ok: true, branch, path: worktreeDir, reused: true }
  } catch (err) {
    return { ok: false, code: "GIT_FAILED", message: String(err) }
  }
}

async function branchExists(branch: string): Promise<boolean> {
  try {
    const { stdout } = await git(`rev-parse --verify 'refs/heads/${escapeShellArg(branch)}'`)
    return stdout.trim() !== ""
  } catch {
    return false
  }
}

/** branch 是否是 base 的祖先（已合并）；非祖先或 git 失败 → false */
async function isMergedToBase(branch: string, base: string): Promise<boolean> {
  try {
    await git(`merge-base --is-ancestor '${escapeShellArg(branch)}' '${escapeShellArg(base)}'`)
    return true
  } catch {
    return false
  }
}

// ─── destroy-worktree：preflight 销毁（无 --force） ───

export type DestroyReason = "OK" | "DIRTY_WORKTREE" | "PR_NOT_MERGED" | "BRANCH_NOT_PUSHED" | "NOT_FOUND"

export type DestroyWorktreeResult =
  | { ok: true; reason: "OK" | "NOT_FOUND" }
  | { ok: false; reason: "DIRTY_WORKTREE" | "PR_NOT_MERGED" | "BRANCH_NOT_PUSHED" | "GIT_FAILED"; message: string }

export interface DestroyWorktreeInput {
  worktreeDir: string
  branch: string
  prMerged: boolean
  userConfirmed: boolean
}

/**
 * preflight 顺序：不存在 → 幂等跳过；脏 → 拒绝（不 --force）；
 * 未合并 → 需 user_confirmed 且分支已推送；合并且干净 → 自动删除。
 */
export async function destroyWorktree(input: DestroyWorktreeInput): Promise<DestroyWorktreeResult> {
  if (!(await pathExists(input.worktreeDir))) {
    return { ok: true, reason: "NOT_FOUND" }
  }

  if (await isDirty(input.worktreeDir)) {
    return { ok: false, reason: "DIRTY_WORKTREE", message: `worktree ${input.worktreeDir} has uncommitted changes; refusing to remove without --force` }
  }

  if (!input.prMerged) {
    if (!input.userConfirmed) {
      return { ok: false, reason: "PR_NOT_MERGED", message: "PR is not merged; require user_confirmed to destroy the worktree" }
    }
    if (!(await isBranchPushed(input.branch))) {
      return { ok: false, reason: "BRANCH_NOT_PUSHED", message: `branch ${input.branch} is not pushed to origin` }
    }
  }

  try {
    await git(`worktree remove '${escapeShellArg(input.worktreeDir)}'`)
    await removeLocalBranch(input.branch)
    return { ok: true, reason: "OK" }
  } catch (err) {
    return { ok: false, reason: "GIT_FAILED", message: String(err) }
  }
}

async function isDirty(worktreeDir: string): Promise<boolean> {
  const { stdout } = await git(`-C '${escapeShellArg(worktreeDir)}' status --porcelain`)
  return stdout.trim() !== ""
}

/** 分支是否已推送到 origin（ls-remote 命中 refs/heads/<branch>） */
async function isBranchPushed(branch: string): Promise<boolean> {
  try {
    const { stdout } = await git(`ls-remote --heads origin '${escapeShellArg(branch)}'`)
    return stdout.includes(`refs/heads/${branch}`)
  } catch {
    return false
  }
}

async function removeLocalBranch(branch: string): Promise<void> {
  try {
    await git(`rev-parse --verify 'refs/heads/${escapeShellArg(branch)}'`)
  } catch {
    return // 本地分支不存在，跳过
  }
  await git(`branch -D '${escapeShellArg(branch)}'`)
}

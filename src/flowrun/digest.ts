import { createHash } from "node:crypto"
import { readFile, lstat, readdir, realpath } from "node:fs/promises"
import { join, relative, resolve, sep, isAbsolute } from "node:path"
import { execFileSync } from "node:child_process"
import type { VersionedDigest } from "./types.js"

// ─── 类型 ───

export interface DigestOptions {
  testFilePatterns: string[]
  implementationFilePatterns: string[]
  generatedArtifactPatterns: string[]
}

// ─── 常量 ───

/** 始终忽略的目录 */
const ALWAYS_IGNORED = new Set([
  ".git",
  "node_modules",
  "coverage",
  "dist",
  ".nyc_output",
])

/** 始终忽略的前缀（目录 + 分隔符） */
function isAlwaysIgnored(relPath: string): boolean {
  const parts = relPath.split(sep)
  if (parts.length === 0) return false
  const top = parts[0]
  if (!top) return false
  return ALWAYS_IGNORED.has(top)
}

/** 危险字符正则：拒绝可能逃逸路径的字符 */
const DANGEROUS_PATH = /[\x00-\x1f\x7f]/

// ─── Git 辅助 ───

function runGit(args: string[], cwd: string): string[] {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
      maxBuffer: 10 * 1024 * 1024,
    })
    return output.trim().split("\n").filter(Boolean)
  } catch {
    return []
  }
}

/** 获取 Git 已跟踪的文件列表（repo-relative paths） */
function getTrackedFiles(cwd: string): Set<string> {
  const lines = runGit(["ls-files", "--cached", "-z"], cwd)
  if (lines.length === 0) return new Set()
  // -z 输出的行以 null 分隔，但 execFileSync 返回时 null 被转为换行
  // 实际用 -z 时输出用 \0 分隔，这里按 \0 分割
  const raw = execFileSync("git", ["ls-files", "--cached", "-z"], {
    cwd, encoding: "utf-8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
    maxBuffer: 10 * 1024 * 1024,
  })
  return new Set(raw.split("\0").filter(Boolean))
}

/** 获取已跟踪但已删除的文件列表 */
function getDeletedFiles(cwd: string): Set<string> {
  try {
    const raw = execFileSync("git", ["ls-files", "--deleted", "-z"], {
      cwd, encoding: "utf-8",
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
      maxBuffer: 10 * 1024 * 1024,
    })
    return new Set(raw.split("\0").filter(Boolean))
  } catch {
    return new Set()
  }
}

// ─── 模式匹配 ───

/**
 * 简单的 glob 匹配（支持 **、*）
 * 不做完整 micromatch，仅覆盖常见 pattern
 */
function matchPattern(filePath: string, pattern: string): boolean {
  // 将路径分隔符统一为 /
  const normalized = filePath.split(sep).join("/")

  // 构建正则
  let regexStr = ""
  let i = 0
  while (i < pattern.length) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      // **：零或多个路径段
      i += 2
      // 跳过可选的 /（**/ 匹配零或多个目录）
      if (i < pattern.length && pattern[i] === "/") {
        regexStr += "(.*/)?"
        i++
      } else {
        // 独立的 **（末尾）：匹配所有
        regexStr += ".*"
      }
    } else if (pattern[i] === "*") {
      // *：匹配单段内的任意字符（除 /）
      regexStr += "[^/]*"
      i++
    } else if (pattern[i] === ".") {
      regexStr += "\\."
      i++
    } else if (pattern[i] === "?") {
      regexStr += "[^/]"
      i++
    } else {
      // 转义正则特殊字符
      if ("+^$(){}[]|\\".includes(pattern[i])) {
        regexStr += "\\" + pattern[i]
      } else {
        regexStr += pattern[i]
      }
      i++
    }
  }

  const regex = new RegExp(`^${regexStr}$`)
  return regex.test(normalized)
}

function matchesAnyPattern(filePath: string, patterns: string[]): boolean {
  return patterns.some(p => matchPattern(filePath, p))
}

// ─── 路径校验 ───

function validateRelPath(relPath: string): void {
  // 拒绝包含危险字符的路径
  if (DANGEROUS_PATH.test(relPath)) {
    throw new Error(`Dangerous characters in path: ${relPath}`)
  }
  // 拒绝以 .. 开头的路径
  const normalized = relPath.split(sep).join("/")
  if (normalized.startsWith("..") || normalized.includes("/../")) {
    throw new Error(`Path escapes worktree: ${relPath}`)
  }
  if (isAbsolute(relPath)) {
    throw new Error(`Path must be relative: ${relPath}`)
  }
}

// ─── 文件扫描 ───

/**
 * 递归列出目录下所有文件（repo-relative paths）
 * 忽略 always-ignored 目录
 */
async function scanDir(root: string, subDir: string = "", results: string[] = []): Promise<string[]> {
  const fullPath = subDir ? join(root, subDir) : root
  let dirents
  try {
    dirents = await readdir(fullPath, { withFileTypes: true })
  } catch {
    return results
  }

  for (const entry of dirents) {
    const relPath = subDir ? `${subDir}${sep}${entry.name}` : entry.name
    const relPathSlash = relPath.split(sep).join("/")

    // 跳过 always-ignored 顶层目录
    if (isAlwaysIgnored(relPath)) continue

    if (entry.isDirectory()) {
      await scanDir(root, relPath, results)
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      results.push(relPathSlash)
    }
  }

  return results
}

// ─── 获取文件信息 ───

interface FileEntry {
  path: string
  mode: number
  content: Buffer | null // null = 删除标记
}

async function collectFileEntries(
  root: string,
  tracked: Set<string>,
  deleted: Set<string>,
  untrackedPaths: Set<string>,
  generatedPatterns: string[],
): Promise<FileEntry[]> {
  const entries: FileEntry[] = []

  // 处理已跟踪文件
  for (const relPath of tracked) {
    validateRelPath(relPath)

    // 跳过生成的 artifacts
    if (matchesAnyPattern(relPath, generatedPatterns)) continue
    // 跳过 always-ignored 目录
    if (isAlwaysIgnored(relPath)) continue

    // 已删除文件：使用删除标记
    if (deleted.has(relPath)) {
      entries.push({ path: relPath, mode: 0, content: null })
      continue
    }

    const absPath = join(root, relPath)
    try {
      const fileLstat = await lstat(absPath)

      // 检查 symlink 是否逃逸
      if (fileLstat.isSymbolicLink()) {
        const resolved = await realpath(absPath)
        const resolvedNorm = resolve(resolved)
        const rootNorm = resolve(root)
        if (!resolvedNorm.startsWith(rootNorm + sep) && resolvedNorm !== rootNorm) {
          throw new Error(`Symlink escapes worktree: ${relPath} → ${resolved}`)
        }
      }

      if (fileLstat.isFile() || fileLstat.isSymbolicLink()) {
        const content = await readFile(absPath)
        // mode: 只保留权限位（低 9 位），用于区分可执行位
        const mode = fileLstat.mode & 0o777
        entries.push({ path: relPath, mode, content })
      }
      // 目录、设备文件等跳过
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith("Symlink escapes")) {
        throw err
      }
      // 文件不存在（可能被外部删除），添加删除标记
      entries.push({ path: relPath, mode: 0, content: null })
    }
  }

  // 处理 policy 范围内的 untracked 文件
  for (const relPath of untrackedPaths) {
    validateRelPath(relPath)

    // 跳过已跟踪文件的重复
    if (tracked.has(relPath)) continue
    // 跳过 always-ignored
    if (isAlwaysIgnored(relPath)) continue
    // 跳过生成的 artifacts
    if (matchesAnyPattern(relPath, generatedPatterns)) continue

    const absPath = join(root, relPath)
    try {
      const fileLstat = await lstat(absPath)

      if (fileLstat.isSymbolicLink()) {
        const resolved = await realpath(absPath)
        const resolvedNorm = resolve(resolved)
        const rootNorm = resolve(root)
        if (!resolvedNorm.startsWith(rootNorm + sep) && resolvedNorm !== rootNorm) {
          throw new Error(`Symlink escapes worktree: ${relPath} → ${resolved}`)
        }
      }

      if (fileLstat.isFile() || fileLstat.isSymbolicLink()) {
        const content = await readFile(absPath)
        const mode = fileLstat.mode & 0o777
        entries.push({ path: relPath, mode, content })
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith("Symlink escapes")) {
        throw err
      }
      // 无法读取的文件跳过
    }
  }

  return entries
}

// ─── 主函数 ───

/**
 * 计算 worktree 的 Canonical Content Digest。
 *
 * 规则：
 * 1. repo-relative paths，按 UTF-8 字节序排序
 * 2. 纳入文件类型（含可执行位）、原始字节、删除标记
 * 3. 拒绝逃逸 worktree 的 symlink
 * 4. 忽略 .git/、node_modules/、coverage/、dist/、policy 声明的 generated artifacts
 * 5. tracked + policy 范围内 untracked 文件均纳入
 */
export async function computeWorkspaceDigest(
  root: string,
  options: DigestOptions,
): Promise<VersionedDigest> {
  const rootNorm = resolve(root)

  // 1. 获取 Git 跟踪状态
  const tracked = getTrackedFiles(rootNorm)
  const deleted = getDeletedFiles(rootNorm)

  // 2. 扫描文件系统获取 policy 范围内的 untracked 文件
  const allFiles = await scanDir(rootNorm)
  const includedPatterns = [...options.testFilePatterns, ...options.implementationFilePatterns]
  const untrackedPaths = new Set(
    allFiles.filter(f => !tracked.has(f) && matchesAnyPattern(f, includedPatterns))
  )

  // 3. 收集文件条目
  const entries = await collectFileEntries(
    rootNorm,
    tracked,
    deleted,
    untrackedPaths,
    options.generatedArtifactPatterns,
  )

  // 4. 按 UTF-8 字节序排序
  entries.sort((a, b) => {
    const bufA = Buffer.from(a.path, "utf-8")
    const bufB = Buffer.from(b.path, "utf-8")
    return Buffer.compare(bufA, bufB)
  })

  // 5. 构建 canonical 内容
  const hash = createHash("sha256")
  for (const entry of entries) {
    // path
    hash.update(entry.path)
    hash.update("\0")
    // mode (8 进制字符串)
    hash.update(entry.mode.toString(8))
    hash.update("\0")
    // content 或删除标记
    if (entry.content === null) {
      hash.update("\0DELETED\0")
    } else {
      hash.update(entry.content)
    }
    hash.update("\0")
  }

  return {
    algorithm: "sha256-content-v1",
    value: hash.digest("hex"),
  }
}

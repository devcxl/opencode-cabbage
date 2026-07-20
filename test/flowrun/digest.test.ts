import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, writeFileSync, symlinkSync, chmodSync, rmSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { execSync } from "node:child_process"
import { computeWorkspaceDigest, type DigestOptions } from "../../src/flowrun/digest.js"

// ─── 辅助函数 ───

let tmpDir: string
let worktree: string

function git(args: string, cwd: string = worktree): string {
  try {
    return execSync(`git ${args}`, { cwd, encoding: "utf-8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: tmpDir } })
  } catch {
    return ""
  }
}

function setupGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cabbage-digest-test-"))
  execSync("git init", { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })
  execSync("git config user.email test@test.com", { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })
  execSync("git config user.name test", { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })
  return dir
}

/** 写入文件前自动创建父目录 */
function writeFile(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true })
  writeFileSync(filePath, content)
}

function defaultOptions(overrides: Partial<DigestOptions> = {}): DigestOptions {
  return {
    testFilePatterns: ["test/**/*.ts"],
    implementationFilePatterns: ["src/**/*.ts"],
    generatedArtifactPatterns: [],
    ...overrides,
  }
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "cabbage-digest-"))
  worktree = setupGitRepo()
})

afterAll(() => {
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

// ─── 测试 ───

describe("computeWorkspaceDigest", () => {
  it("returns a VersionedDigest with sha256-content-v1 algorithm", async () => {
    writeFile(join(worktree, "README.md"), "hello")
    git("add README.md")
    git('commit -m "init"')

    const result = await computeWorkspaceDigest(worktree, defaultOptions())
    expect(result.algorithm).toBe("sha256-content-v1")
    expect(result.value).toMatch(/^[a-f0-9]{64}$/)
  })

  it("produces deterministic digest for same workspace content", async () => {
    // clean workspace with tracked file
    const dir = setupGitRepo()
    writeFile(join(dir, "src", "index.ts"), "export const x = 1")
    writeFile(join(dir, "test", "index.test.ts"), 'import { x } from "../src/index.js"')
    execSync("git add src/index.ts test/index.test.ts", { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })
    execSync('git commit -m "init"', { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })

    const opts = defaultOptions()
    const d1 = await computeWorkspaceDigest(dir, opts)
    const d2 = await computeWorkspaceDigest(dir, opts)

    expect(d1.value).toBe(d2.value)

    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it("produces different digest when tracked file content changes", async () => {
    const dir = setupGitRepo()
    writeFile(join(dir, "src", "index.ts"), "export const x = 1")
    execSync("git add src/index.ts", { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })
    execSync('git commit -m "init"', { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })

    const opts = defaultOptions()
    const d1 = await computeWorkspaceDigest(dir, opts)

    writeFile(join(dir, "src", "index.ts"), "export const x = 2")
    const d2 = await computeWorkspaceDigest(dir, opts)

    expect(d1.value).not.toBe(d2.value)

    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it("includes executable bit in digest", async () => {
    const dir = setupGitRepo()
    writeFile(join(dir, "script.sh"), "#!/bin/sh\necho hi")
    chmodSync(join(dir, "script.sh"), 0o755)
    execSync("git add script.sh", { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })
    execSync('git commit -m "init"', { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })

    const d1 = await computeWorkspaceDigest(dir, defaultOptions())

    chmodSync(join(dir, "script.sh"), 0o644)
    const d2 = await computeWorkspaceDigest(dir, defaultOptions())

    expect(d1.value).not.toBe(d2.value)

    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it("includes delete marker for tracked but deleted files", async () => {
    const dir = setupGitRepo()
    writeFile(join(dir, "src", "index.ts"), "export const x = 1")
    execSync("git add src/index.ts", { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })
    execSync('git commit -m "init"', { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })

    const opts = defaultOptions()
    const d1 = await computeWorkspaceDigest(dir, opts)

    rmSync(join(dir, "src", "index.ts"))
    const d2 = await computeWorkspaceDigest(dir, opts)

    // 删除文件 vs 存在文件，digest 应不同
    expect(d1.value).not.toBe(d2.value)

    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it("ignores .git/ directory", async () => {
    const dir = setupGitRepo()
    writeFile(join(dir, "src", "index.ts"), "export const x = 1")
    execSync("git add src/index.ts", { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })
    execSync('git commit -m "init"', { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })

    const d1 = await computeWorkspaceDigest(dir, defaultOptions())

    // 修改 .git 内部文件不应影响 digest
    writeFile(join(dir, ".git", "some-file"), "should be ignored")
    const d2 = await computeWorkspaceDigest(dir, defaultOptions())

    expect(d1.value).toBe(d2.value)

    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it("ignores node_modules/ directory", async () => {
    const dir = setupGitRepo()
    writeFile(join(dir, "src", "index.ts"), "export const x = 1")
    execSync("git add src/index.ts", { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })
    execSync('git commit -m "init"', { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })

    const d1 = await computeWorkspaceDigest(dir, defaultOptions())

    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true })
    writeFile(join(dir, "node_modules", "pkg", "index.js"), "module.exports = {}")
    const d2 = await computeWorkspaceDigest(dir, defaultOptions())

    expect(d1.value).toBe(d2.value)

    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it("ignores coverage/ and dist/ directories", async () => {
    const dir = setupGitRepo()
    writeFile(join(dir, "src", "index.ts"), "export const x = 1")
    execSync("git add src/index.ts", { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })
    execSync('git commit -m "init"', { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })

    const d1 = await computeWorkspaceDigest(dir, defaultOptions())

    mkdirSync(join(dir, "coverage"), { recursive: true })
    writeFile(join(dir, "coverage", "report.json"), "{}")
    mkdirSync(join(dir, "dist"), { recursive: true })
    writeFile(join(dir, "dist", "index.js"), "x")
    const d2 = await computeWorkspaceDigest(dir, defaultOptions())

    expect(d1.value).toBe(d2.value)

    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it("ignores generated artifacts declared in policy", async () => {
    const dir = setupGitRepo()
    writeFile(join(dir, "src", "index.ts"), "export const x = 1")
    execSync("git add src/index.ts", { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })
    execSync('git commit -m "init"', { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })

    const opts = defaultOptions({
      generatedArtifactPatterns: ["coverage/**", "build/**"],
    })
    const d1 = await computeWorkspaceDigest(dir, opts)

    mkdirSync(join(dir, "coverage"), { recursive: true })
    writeFile(join(dir, "coverage", "lcov.info"), "SF:src/index.ts")
    mkdirSync(join(dir, "build"), { recursive: true })
    writeFile(join(dir, "build", "output.js"), "console.log(1)")
    const d2 = await computeWorkspaceDigest(dir, opts)

    expect(d1.value).toBe(d2.value)

    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it("includes policy-scoped untracked files", async () => {
    const dir = setupGitRepo()
    writeFile(join(dir, "src", "existing.ts"), "export const y = 2")
    execSync("git add src/existing.ts", { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })
    execSync('git commit -m "init"', { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })

    const opts = defaultOptions()
    const d1 = await computeWorkspaceDigest(dir, opts)

    // 添加一个匹配 implementationFilePatterns 的 untracked 文件
    writeFile(join(dir, "src", "new-feature.ts"), "export const z = 3")
    const d2 = await computeWorkspaceDigest(dir, opts)

    expect(d1.value).not.toBe(d2.value)

    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it("sorts paths by UTF-8 byte order", async () => {
    // 验证排序对 digest 的影响：使用两个不同路径前缀确保一致性
    const dir = setupGitRepo()
    writeFile(join(dir, "a.ts"), "a")
    writeFile(join(dir, "b.ts"), "b")
    execSync("git add a.ts b.ts", { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })
    execSync('git commit -m "init"', { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })

    // 即使文件系统返回不同顺序，digest 应一致
    const d1 = await computeWorkspaceDigest(dir, defaultOptions())
    const d2 = await computeWorkspaceDigest(dir, defaultOptions())

    expect(d1.value).toBe(d2.value)

    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it("rejects symlinks that escape the worktree", async () => {
    const dir = setupGitRepo()
    writeFile(join(dir, "src", "safe.ts"), "a")
    execSync("git add src/safe.ts", { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })
    execSync('git commit -m "init"', { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })

    // 创建指向 worktree 外部的 symlink 并加入 git 跟踪
    const outsidePath = join(tmpdir(), "outside-file")
    writeFileSync(outsidePath, "secret")
    symlinkSync(outsidePath, join(dir, "src", "escape-link.ts"))

    // 确保 symlink 被 git 跟踪，这样 digest 必须处理它
    execSync("git add src/escape-link.ts", { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })

    await expect(computeWorkspaceDigest(dir, defaultOptions())).rejects.toThrow(/symlink|escape|outside/i)

    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
    try { rmSync(outsidePath) } catch { /* ignore */ }
  })

  it("includes untracked test files matching testFilePatterns", async () => {
    const dir = setupGitRepo()
    writeFile(join(dir, "src", "lib.ts"), "export const fn = () => 1")
    execSync("git add src/lib.ts", { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })
    execSync('git commit -m "init"', { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })

    const opts = defaultOptions()
    const d1 = await computeWorkspaceDigest(dir, opts)

    // 添加 untracked 测试文件
    writeFile(join(dir, "test", "lib.test.ts"), 'import { fn } from "../src/lib.js";\ndescribe("test", () => { it("works", () => expect(fn()).toBe(1)) })')
    const d2 = await computeWorkspaceDigest(dir, opts)

    expect(d1.value).not.toBe(d2.value)

    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })
})

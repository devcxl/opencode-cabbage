import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { createHash } from "node:crypto"
import { mkdtemp, stat, utimes, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import {
  getContextBlock,
  resetContextCache,
  formatContextBlock,
  CONTEXT_MARKER,
  MAX_CONTEXT_LINES,
} from "../../src/kernel/context.js"

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "cabbage-context-"))
  resetContextCache()
})

afterEach(async () => {
  resetContextCache()
  await rm(tmpDir, { recursive: true, force: true })
})

function sha16(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16)
}

describe("getContextBlock — 发现与摘要", () => {
  it("发现根 CONTEXT.md 并返回 path/mtime/digest/terms", async () => {
    const content = "## Terms\n- user\n- agent\n"
    await writeFile(path.join(tmpDir, "CONTEXT.md"), content, "utf8")

    const block = await getContextBlock(tmpDir)

    expect(block).not.toBeNull()
    expect(block!.path).toBe(path.join(tmpDir, "CONTEXT.md"))
    expect(block!.mtimeMs).toBeGreaterThan(0)
    expect(block!.digest).toBe(sha16(content))
    expect(block!.terms).toEqual(["Terms"])
  })

  it("CONTEXT.md 缺失时返回 null 且不报错", async () => {
    expect(await getContextBlock(tmpDir)).toBeNull()
  })

  it("digest 稳定：同内容两次调用 digest 一致", async () => {
    await writeFile(path.join(tmpDir, "CONTEXT.md"), "## Terms\nsame\n", "utf8")

    const first = await getContextBlock(tmpDir)
    const second = await getContextBlock(tmpDir)

    expect(first!.digest).toBe(second!.digest)
  })

  it("提取全部 ## 标题为 terms", async () => {
    await writeFile(path.join(tmpDir, "CONTEXT.md"), "## Terms\n## Roles\n## Workflow\n", "utf8")

    const block = await getContextBlock(tmpDir)

    expect(block!.terms).toEqual(["Terms", "Roles", "Workflow"])
  })
})

describe("getContextBlock — mtime 缓存刷新", () => {
  it("mtime 变化后重读并刷新 digest", async () => {
    const file = path.join(tmpDir, "CONTEXT.md")
    await writeFile(file, "## v1\n", "utf8")
    const first = await getContextBlock(tmpDir)

    await writeFile(file, "## v2\nnew term\n", "utf8")
    const stats = await stat(file)
    await utimes(file, stats.atime, new Date(stats.mtimeMs + 5000))

    const second = await getContextBlock(tmpDir)

    expect(second!.digest).not.toBe(first!.digest)
    expect(second!.terms).toEqual(["v2"])
  })

  it("mtime 不变时命中缓存（内容变化也不重读）", async () => {
    const file = path.join(tmpDir, "CONTEXT.md")
    const fixedMtime = new Date(1_000_000_000_000) // 固定整数毫秒，可精确还原
    await writeFile(file, "## cached\n", "utf8")
    await utimes(file, new Date(), fixedMtime)
    const first = await getContextBlock(tmpDir)

    // 内容变化但把 mtime 还原 → 应命中缓存
    await writeFile(file, "## changed\n", "utf8")
    await utimes(file, new Date(), fixedMtime)

    const second = await getContextBlock(tmpDir)

    expect(second!.digest).toBe(first!.digest)
  })
})

describe("formatContextBlock — 注入块格式", () => {
  it("包含 marker、来源、digest 与全文", async () => {
    await writeFile(path.join(tmpDir, "CONTEXT.md"), "## Terms\n- user\n", "utf8")
    const block = await getContextBlock(tmpDir)

    const text = formatContextBlock(block!)

    expect(text).toContain(CONTEXT_MARKER)
    expect(text).toContain("Project Context (auto-injected)")
    expect(text).toContain("CONTEXT.md")
    expect(text).toContain(block!.digest)
    expect(text).toContain("## Terms")
    expect(text).toContain("- user")
  })

  it("超长文件截断并提示", async () => {
    const lines = Array.from({ length: MAX_CONTEXT_LINES + 50 }, (_, i) => `line ${i}`)
    await writeFile(path.join(tmpDir, "CONTEXT.md"), lines.join("\n"), "utf8")
    const block = await getContextBlock(tmpDir)

    const text = formatContextBlock(block!)

    expect(text).toContain("截断")
    expect(text).not.toContain(`line ${MAX_CONTEXT_LINES + 49}`)
  })

  it("CONTEXT.md 缺失时 format 返回空字符串", () => {
    expect(formatContextBlock(null)).toBe("")
  })
})

/**
 * adapter 真实执行集成测试（不 mock）：真实 vitest 子进程 + 真实失败分类。
 * 验证 RED（断言失败→assertion）与 GREEN（全部通过→null）的端到端链路，
 * 覆盖 executeVitest / parseVitestSummary / classifyVitestFailure 真实路径。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { executeRedCheck } from "../../../src/kernel/tdd/adapter.js"
import type { TddRunnerPolicy } from "../../../src/kernel/types.js"

let repoDir: string

const VITEST_BIN = join(import.meta.dirname, "../../../node_modules/vitest/vitest.mjs")

function makePolicy(): TddRunnerPolicy {
  return {
    adapter: "vitest",
    baseCommand: `node ${VITEST_BIN} run`,
    timeoutMs: 60_000,
    executionInputPatterns: [],
  }
}

beforeAll(() => {
  repoDir = mkdtempSync(join(tmpdir(), "cabbage-adapter-real-"))
})

afterAll(() => {
  try { rmSync(repoDir, { recursive: true, force: true }) } catch { /* ignore */ }
})

describe("executeRedCheck 真实 vitest 集成", () => {
  it("RED：断言失败 → failureKind=assertion，退出码非零", async () => {
    writeFileSync(join(repoDir, "red.test.ts"), "import { test, expect } from 'vitest'\ntest('fails', () => expect(1).toBe(2))\n")

    const evidence = await executeRedCheck(makePolicy(), "red.test.ts", repoDir)
    expect(evidence.exitCode).not.toBe(0)
    expect(evidence.failureKind).toBe("assertion")
    expect(evidence.testsCollected).toBeGreaterThan(0)
    expect(evidence.testsFailed).toBeGreaterThan(0)
    expect(evidence.summary).toContain("failed")
  })

  it("GREEN：全部通过 → failureKind=null，退出码 0", async () => {
    writeFileSync(join(repoDir, "green.test.ts"), "import { test, expect } from 'vitest'\ntest('passes', () => expect(1).toBe(1))\n")

    const evidence = await executeRedCheck(makePolicy(), "green.test.ts", repoDir)
    expect(evidence.exitCode).toBe(0)
    expect(evidence.failureKind).toBeNull()
    expect(evidence.testsCollected).toBeGreaterThan(0)
    expect(evidence.testsFailed).toBe(0)
    expect(evidence.summary).toContain("passed")
  })

  it("RED：测试导入不存在的实现模块 → failureKind=missing-behavior", async () => {
    writeFileSync(
      join(repoDir, "missing.test.ts"),
      "import { test } from 'vitest'\nimport { notThere } from './src/nonexistent'\ntest('x', () => notThere())\n",
    )

    const evidence = await executeRedCheck(makePolicy(), "missing.test.ts", repoDir)
    expect(evidence.exitCode).not.toBe(0)
    expect(evidence.failureKind).toBe("missing-behavior")
  })

  it("selector 含 shell 元字符 → 拒绝执行", async () => {
    await expect(executeRedCheck(makePolicy(), "red.test.ts; rm -rf /tmp/x", repoDir)).rejects.toThrow(/dangerous/i)
  })
})

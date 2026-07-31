import { describe, it, expect, beforeEach, afterEach, beforeAll } from "vitest"
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { tmpdir } from "node:os"
import { execSync } from "node:child_process"
import {
  captureWorkspaceBaseline,
  buildEvidenceBlock,
  recordTddEvidence,
  type EvidenceBlockInput,
} from "../../../src/kernel/tdd/evidence.js"
import type { setRecordsGhExecutor as SetRecordsGhExecutorType } from "../../../src/kernel/records.js"

type GhFn = (args: string) => Promise<{ stdout: string; stderr: string }>

let setRecordsGhExecutor: typeof SetRecordsGhExecutorType

beforeAll(async () => {
  const mod = await import("../../../src/kernel/records.js")
  setRecordsGhExecutor = mod.setRecordsGhExecutor
})

beforeEach(() => {
  setRecordsGhExecutor(() => {
    throw new Error("unexpected gh call")
  })
})

afterEach(() => {
  setRecordsGhExecutor(null)
})

function setupGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cabbage-evidence-test-"))
  execSync("git init", { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })
  execSync("git config user.email test@test.com", { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })
  execSync("git config user.name test", { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })
  return dir
}

function makeInput(overrides: Partial<EvidenceBlockInput> = {}): EvidenceBlockInput {
  return {
    stage: "red",
    criterionId: "AC-1",
    cycleId: "cycle-1",
    command: "npx vitest run test/foo.test.ts",
    testSelector: "test/foo.test.ts",
    exitCode: 1,
    failureKind: "assertion",
    status: "red",
    workspaceDigest: { algorithm: "sha256-content-v1", value: "a".repeat(64) },
    summary: "1/3 tests failed",
    ...overrides,
  }
}

// ─── buildEvidenceBlock（纯函数） ───

describe("buildEvidenceBlock", () => {
  it("includes criterion, cycle, command, exit code, failure kind, status, digest and summary", () => {
    const block = buildEvidenceBlock(makeInput())

    expect(block).toContain("AC-1")
    expect(block).toContain("cycle-1")
    expect(block).toContain("npx vitest run test/foo.test.ts")
    expect(block).toContain("exitCode: 1")
    expect(block).toContain("failureKind: assertion")
    expect(block).toContain("status: red")
    expect(block).toContain("a".repeat(64))
    expect(block).toContain("1/3 tests failed")
  })

  it("handles optional fields being absent", () => {
    const block = buildEvidenceBlock(
      makeInput({ criterionId: undefined, cycleId: undefined, testSelector: null, failureKind: null, workspaceDigest: null }),
    )
    expect(block).toContain("stage: red")
    expect(block).not.toContain("criterionId")
  })
})

// ─── captureWorkspaceBaseline ───

describe("captureWorkspaceBaseline", () => {
  it("captures a stable digest snapshot with patterns and timestamp", async () => {
    const dir = setupGitRepo()
    mkdirSync(join(dir, "src"), { recursive: true })
    mkdirSync(join(dir, "test"), { recursive: true })
    writeFileSync(join(dir, "src", "index.ts"), "export const x = 1")
    writeFileSync(join(dir, "test", "index.test.ts"), "import { x } from '../src/index.js'")
    execSync("git add src/index.ts test/index.test.ts", { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })
    execSync('git commit -m "init"', { cwd: dir, env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", HOME: dir } })

    const options = {
      testFilePatterns: ["test/**/*.ts"],
      implementationFilePatterns: ["src/**/*.ts"],
      generatedArtifactPatterns: [],
    }
    const baseline = await captureWorkspaceBaseline(dir, options)

    expect(baseline.digest.algorithm).toBe("sha256-content-v1")
    expect(baseline.digest.value).toMatch(/^[a-f0-9]{64}$/)
    expect(baseline.testFilePatterns).toEqual(options.testFilePatterns)
    expect(baseline.implementationFilePatterns).toEqual(options.implementationFilePatterns)
    expect(baseline.capturedAt).toBeTruthy()

    // 同内容快照 digest 稳定
    const baseline2 = await captureWorkspaceBaseline(dir, options)
    expect(baseline2.digest.value).toBe(baseline.digest.value)

    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  })
})

// ─── recordTddEvidence（调用 records.appendTddEvidence） ───

describe("recordTddEvidence", () => {
  it("builds a block and appends it via records.appendTddEvidence (creates comment)", async () => {
    const calls: string[] = []
    setRecordsGhExecutor(async (args) => {
      calls.push(args)
      if (args.startsWith("issue view 42")) {
        return { stdout: "null", stderr: "" }
      }
      return { stdout: "", stderr: "" }
    })

    const result = await recordTddEvidence(42, makeInput())

    expect(result.ok).toBe(true)
    expect(result.revision).toBe(1)
    // appendTddEvidence 创建受控 comment
    const commentCall = calls.find(c => c.startsWith("issue comment 42"))
    expect(commentCall).toBeDefined()
    expect(commentCall).toContain("<!-- cabbage-tdd-evidence:start -->")
    expect(commentCall).toContain("cycle-1")
  })

  it("returns error when gh fails", async () => {
    setRecordsGhExecutor(async () => {
      throw new Error("gh auth failed")
    })

    const result = await recordTddEvidence(42, makeInput())
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain("gh auth failed")
    }
  })
})

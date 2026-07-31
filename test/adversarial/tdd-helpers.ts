/**
 * test/adversarial 共享测试设施（tdd_checkpoint 场景 #4/#5 复用）。
 * 无测试定义，vitest include 只匹配 *.test.ts，本文件不会被当作测试收集。
 */
import { vi } from "vitest"
import { executeRedCheck } from "../../src/kernel/tdd/adapter.js"
import { computeWorkspaceDigest } from "../../src/kernel/tdd/digest.js"
import { TASK_TDD_TAG } from "../../src/plugin/tdd-checkpoint.js"
import type { TddPolicy, TddCommandEvidence, VersionedDigest } from "../../src/kernel/types.js"

export const BASELINE_IMPL: VersionedDigest = { algorithm: "sha256-content-v1", value: "b".repeat(64) }
export const CHANGED_IMPL: VersionedDigest = { algorithm: "sha256-content-v1", value: "c".repeat(64) }
export const INPUT_DIGEST: VersionedDigest = { algorithm: "sha256-content-v1", value: "d".repeat(64) }
export const OTHER_INPUT: VersionedDigest = { algorithm: "sha256-content-v1", value: "e".repeat(64) }

export function makePolicy(overrides: Partial<TddPolicy> = {}): TddPolicy {
  return {
    mode: "strict",
    enforcement: "runtime",
    runner: {
      adapter: "vitest",
      baseCommand: "npx vitest run",
      timeoutMs: 30000,
      executionInputPatterns: ["package.json", "vitest.config.ts"],
    },
    testFilePatterns: ["test/**/*.test.ts"],
    implementationFilePatterns: ["src/**/*.ts"],
    generatedArtifactPatterns: [],
    exception: null,
    source: { manifestPath: "test.yml", revisionSha: "sha1" },
    ...overrides,
  }
}

export function makeCriteria() {
  return [
    { id: "AC-1", description: "TDD behavior", verification: "tdd" as const },
    { id: "AC-2", description: "regression stays green", verification: "regression" as const },
  ]
}

export function makeRun(overrides: Partial<TddCommandEvidence> = {}): TddCommandEvidence {
  return {
    command: "npx vitest run test/foo.test.ts",
    testSelector: "test/foo.test.ts",
    exitCode: 1,
    failureKind: "assertion",
    testsCollected: 3,
    testsFailed: 1,
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:01Z",
    durationMs: 1000,
    changedFiles: [],
    outputDigest: { algorithm: "sha256-output-v1", value: "a".repeat(64) },
    workspaceDigest: BASELINE_IMPL,
    executionInputDigest: INPUT_DIGEST,
    summary: "1/3 tests failed",
    ...overrides,
  }
}

export function passingRun(): TddCommandEvidence {
  return makeRun({ exitCode: 0, failureKind: null, testsFailed: 0, summary: "3/3 tests passed" })
}

/** 有状态的 records gh mock：支持 evidence comment 新建与 PATCH 更新（与既有 tdd-checkpoint 测试一致） */
export function makeRecordsState() {
  const comments: { id: number; body: string }[] = []
  const parseBodyArg = (args: string): string => {
    const m = args.match(/(?:--body |body=')([\s\S]*?)'$/)
    return m ? m[1] : ""
  }
  const ghFn = async (args: string): Promise<{ stdout: string; stderr: string }> => {
    if (args.startsWith("issue view") && args.includes("--json comments")) {
      const first = comments.find(c => c.body.includes("<!-- cabbage-tdd-evidence:start -->"))
      return { stdout: first ? JSON.stringify({ id: first.id, body: first.body }) : "null", stderr: "" }
    }
    if (args.startsWith("issue comment")) {
      comments.push({ id: comments.length + 1, body: parseBodyArg(args) })
      return { stdout: "", stderr: "" }
    }
    if (args.startsWith("repo view")) {
      return { stdout: "devcxl/opencode-cabbage", stderr: "" }
    }
    if (args.startsWith("api repos/")) {
      const match = args.match(/issues\/comments\/(\d+) -X PATCH -f body='([\s\S]*?)'$/)
      if (match) {
        const id = Number(match[1])
        const idx = comments.findIndex(c => c.id === id)
        comments[idx] = { id, body: match[2] }
      }
      return { stdout: "", stderr: "" }
    }
    throw new Error(`unexpected records gh: ${args}`)
  }
  return { ghFn, comments }
}

export function makeTaskBody(): string {
  return `## Task Record\n\n${TASK_TDD_TAG}\n${JSON.stringify({
    policy: makePolicy(),
    criteria: makeCriteria(),
    worktreeDir: ".worktree/tdd-x",
  })}`
}

export function makeSessionClient(role: "developer" | "primary" = "developer") {
  return { session: { get: async () => ({ data: { parentID: role === "primary" ? null : "parent" } }) } }
}

export function makeCtx(agent: string) {
  return { agent, sessionID: "sess-1", messageID: "m1", directory: ".", worktree: "." }
}

/** 重置 adapter/digest 的 vi mock（须在 vi.mock 之后调用） */
export function resetDigestMocks() {
  vi.mocked(executeRedCheck).mockReset()
  vi.mocked(computeWorkspaceDigest).mockReset()
}

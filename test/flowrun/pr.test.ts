import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type {
  TaskState,
  FlowRun,
  TddEvidence,
  TaskExecutionBinding,
  TddPolicy,
  AcceptanceCriterion,
} from "../../src/flowrun/types.js"
import { createInitialFlowRun } from "../../src/flowrun/github.js"

// ─── Mock gh utility ───

const mockGh = vi.fn()

vi.mock("../../src/util/gh.js", () => ({
  gh: (...args: unknown[]) => mockGh(...args),
}))

// 在所有 mock 设置完成后动态导入被测试模块
import {
  preflightPRCreate,
  createOrReusePR,
  type CreatePRParams,
  type CreatePRResult,
  type PreflightResult,
} from "../../src/flowrun/pr.js"

// ─── 辅助工厂 ───

function makeTaskState(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: "task-1",
    name: "Test Task",
    status: "running",
    dependsOn: [],
    area: "backend",
    expectedFiles: [],
    parallelSafe: false,
    prNumber: null,
    prCheckpoints: null,
    blockedReason: null,
    startedAt: "2026-01-01T00:00:00Z",
    acceptanceCriteria: [{ id: "AC-1", description: "验收条件", verification: "tdd" }],
    testCommands: [{ command: "npm test", cwd: ".", timeoutMs: 30000, env: {} }],
    verifyCommands: [{ command: "npm run typecheck", cwd: ".", timeoutMs: 30000, env: {} }],
    executionBinding: {
      branch: "feat/test-task",
      baseSha: "baseSha1",
      startHeadSha: "startHead1",
      worktreeId: "worktree-1",
      sessionId: "session-1",
    },
    tddPolicy: {
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
    },
    tddEvidence: makePassingEvidence(),
    coveragePolicy: null,
    ...overrides,
  }
}

function makePassingEvidence(): TddEvidence {
  return {
    revision: 5,
    reworkRevision: 0,
    status: "pass",
    taskStart: { status: "pass", headSha: "committed-head-sha", treeSha: "tree-sha", startedAt: "2026-01-01T00:00:00Z" },
    cycles: [],
    regression: {
      status: "pass",
      headSha: "committed-head-sha",
      treeSha: "tree-sha",
      reworkRevision: 0,
      runs: [
        {
          command: "npm test",
          testSelector: null,
          exitCode: 0,
          failureKind: null,
          testsCollected: 10,
          testsFailed: 0,
          startedAt: "2026-01-01T00:05:00Z",
          finishedAt: "2026-01-01T00:05:10Z",
          durationMs: 10000,
          changedFiles: [],
          outputDigest: { algorithm: "sha256-output-v1", value: "a".repeat(64) },
          workspaceDigest: { algorithm: "sha256-content-v1", value: "a".repeat(64) },
          executionInputDigest: { algorithm: "sha256-content-v1", value: "a".repeat(64) },
          summary: "10/10 tests passed",
        },
      ],
    },
    verification: {
      status: "pass",
      headSha: "committed-head-sha",
      treeSha: "tree-sha",
      runs: [
        {
          command: "npm run typecheck",
          testSelector: null,
          exitCode: 0,
          failureKind: null,
          testsCollected: null,
          testsFailed: null,
          startedAt: "2026-01-01T00:06:00Z",
          finishedAt: "2026-01-01T00:06:05Z",
          durationMs: 5000,
          changedFiles: [],
          outputDigest: { algorithm: "sha256-output-v1", value: "b".repeat(64) },
          workspaceDigest: { algorithm: "sha256-content-v1", value: "b".repeat(64) },
          executionInputDigest: { algorithm: "sha256-content-v1", value: "b".repeat(64) },
          summary: "typecheck passed",
        },
      ],
    },
    alternativeValidation: [],
    reworks: [],
    warnings: [],
    updatedAt: "2026-01-01T00:06:05Z",
  }
}

// ─── preflightPRCreate 测试 ───

describe("preflightPRCreate", () => {
  it("passes when task is running, regression=pass, verification=pass, head matches", () => {
    const task = makeTaskState()
    const result = preflightPRCreate(task, "committed-head-sha")
    expect(result.ok).toBe(true)
  })

  it("fails when task status is not running", () => {
    const task = makeTaskState({ status: "pending" })
    const result = preflightPRCreate(task, "committed-head-sha")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("TASK_NOT_RUNNING")
    }
  })

  it("fails when task status is blocked", () => {
    const task = makeTaskState({ status: "blocked", blockedReason: "deps not met" })
    const result = preflightPRCreate(task, "committed-head-sha")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("TASK_NOT_RUNNING")
    }
  })

  it("fails when task status is reviewing (already has PR)", () => {
    const task = makeTaskState({ status: "reviewing", prNumber: 42 })
    const result = preflightPRCreate(task, "committed-head-sha")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("TASK_NOT_RUNNING")
    }
  })

  it("fails when regression status is not pass", () => {
    const task = makeTaskState({
      tddEvidence: {
        ...makePassingEvidence(),
        regression: {
          ...makePassingEvidence().regression,
          status: "pending",
        },
      },
    })
    const result = preflightPRCreate(task, "committed-head-sha")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("REGRESSION_NOT_COMPLETE")
    }
  })

  it("fails when regression status is fail", () => {
    const task = makeTaskState({
      tddEvidence: {
        ...makePassingEvidence(),
        regression: {
          ...makePassingEvidence().regression,
          status: "fail",
        },
      },
    })
    const result = preflightPRCreate(task, "committed-head-sha")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("REGRESSION_NOT_COMPLETE")
    }
  })

  it("fails when verification status is not pass", () => {
    const task = makeTaskState({
      tddEvidence: {
        ...makePassingEvidence(),
        verification: {
          ...makePassingEvidence().verification,
          status: "pending",
        },
      },
    })
    const result = preflightPRCreate(task, "committed-head-sha")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("VERIFICATION_NOT_COMPLETE")
    }
  })

  it("fails when verification status is fail", () => {
    const task = makeTaskState({
      tddEvidence: {
        ...makePassingEvidence(),
        verification: {
          ...makePassingEvidence().verification,
          status: "fail",
        },
      },
    })
    const result = preflightPRCreate(task, "committed-head-sha")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("VERIFICATION_NOT_COMPLETE")
    }
  })

  it("fails when headSha does not match committed head", () => {
    const task = makeTaskState()
    const result = preflightPRCreate(task, "different-head-sha")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("HEAD_MISMATCH")
    }
  })

  it("fails when regression headSha is null", () => {
    const task = makeTaskState({
      tddEvidence: {
        ...makePassingEvidence(),
        regression: {
          ...makePassingEvidence().regression,
          headSha: null,
        },
      },
    })
    const result = preflightPRCreate(task, "committed-head-sha")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("HEAD_MISMATCH")
    }
  })
})

// ─── createOrReusePR 测试 ───

describe("createOrReusePR", () => {
  beforeEach(() => {
    mockGh.mockReset()
  })

  const makeParams = (overrides: Partial<CreatePRParams> = {}): CreatePRParams => ({
    repo: "owner/repo",
    headBranch: "feat/test-task",
    baseBranch: "main",
    title: "feat: add test task",
    body: "PR created by opencode-cabbage",
    ...overrides,
  })

  it("creates a new PR when no existing open PR found", async () => {
    // 第一次调用：gh pr list 返回空
    mockGh.mockResolvedValueOnce({ stdout: "", stderr: "" })
    // gh pr create 返回 PR URL
    mockGh.mockResolvedValueOnce({ stdout: "https://github.com/owner/repo/pull/123", stderr: "" })

    const result = await createOrReusePR(makeParams())

    expect(result.prNumber).toBe(123)
    expect(result.prUrl).toBe("https://github.com/owner/repo/pull/123")
    expect(result.created).toBe(true)

    // 验证调用了正确的 gh 命令
    expect(mockGh).toHaveBeenCalledTimes(2)
    expect(mockGh.mock.calls[0][0]).toContain("pr list")
    expect(mockGh.mock.calls[0][0]).toContain("feat/test-task")
    expect(mockGh.mock.calls[1][0]).toContain("pr create")
  })

  it("reuses existing open PR (idempotent)", async () => {
    // gh pr list 返回已有 PR
    mockGh.mockResolvedValueOnce({
      stdout: JSON.stringify({ number: 42, url: "https://github.com/owner/repo/pull/42" }),
      stderr: "",
    })

    const result = await createOrReusePR(makeParams())

    expect(result.prNumber).toBe(42)
    expect(result.prUrl).toBe("https://github.com/owner/repo/pull/42")
    expect(result.created).toBe(false)

    // 只调用了 pr list，没有 pr create
    expect(mockGh).toHaveBeenCalledTimes(1)
    expect(mockGh.mock.calls[0][0]).toContain("pr list")
  })

  it("reuses first PR when multiple open PRs exist for same head branch", async () => {
    // gh pr list 返回多个 PR（取第一个）
    mockGh.mockResolvedValueOnce({
      stdout: JSON.stringify({ number: 10, url: "https://github.com/owner/repo/pull/10" }),
      stderr: "",
    })

    const result = await createOrReusePR(makeParams())

    expect(result.prNumber).toBe(10)
    expect(result.created).toBe(false)
  })

  it("throws when gh pr create fails", async () => {
    mockGh.mockResolvedValueOnce({ stdout: "", stderr: "" })
    mockGh.mockRejectedValueOnce(new Error("gh command failed"))

    await expect(createOrReusePR(makeParams())).rejects.toThrow()
  })

  it("throws when pr list returns invalid JSON", async () => {
    mockGh.mockResolvedValueOnce({ stdout: "not-json", stderr: "" })
    // Should fall through to create new PR
    mockGh.mockResolvedValueOnce({ stdout: "https://github.com/owner/repo/pull/456", stderr: "" })

    const result = await createOrReusePR(makeParams())

    expect(result.prNumber).toBe(456)
    expect(result.created).toBe(true)
  })

  it("parses PR number from different URL formats", async () => {
    mockGh.mockResolvedValueOnce({ stdout: "", stderr: "" })
    mockGh.mockResolvedValueOnce({ stdout: "https://github.com/owner/repo/pull/789", stderr: "" })

    const result = await createOrReusePR(makeParams())
    expect(result.prNumber).toBe(789)
  })

  it("parses PR number when gh returns just a number", async () => {
    mockGh.mockResolvedValueOnce({ stdout: "", stderr: "" })
    mockGh.mockResolvedValueOnce({ stdout: "555", stderr: "" })

    const result = await createOrReusePR(makeParams())
    expect(result.prNumber).toBe(555)
  })
})

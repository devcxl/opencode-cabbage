import { describe, it, expect, vi, beforeEach } from "vitest"
import type {
  FlowRun,
  TaskState,
  TddEvidence,
  FlowControlResponse,
} from "../../src/flowrun/types.js"
import { createInitialFlowRun } from "../../src/flowrun/github.js"

// ─── Mock github module ───
const mockReadFlowRunWithLock = vi.fn()
const mockWriteFlowRunWithLock = vi.fn()

vi.mock("../../src/flowrun/github.js", async () => {
  const actual = await vi.importActual("../../src/flowrun/github.js")
  return {
    ...actual,
    readFlowRunWithLock: (...args: unknown[]) => mockReadFlowRunWithLock(...args),
    writeFlowRunWithLock: (...args: unknown[]) => mockWriteFlowRunWithLock(...args),
  }
})

// ─── Mock gh utility ───
const mockGh = vi.fn()

vi.mock("../../src/util/gh.js", () => ({
  gh: (...args: unknown[]) => mockGh(...args),
}))

import { FlowBroker } from "../../src/plugin/broker.js"
import { handleFlowPrCreateWithBroker } from "../../src/plugin/flow-pr-tool.js"

// ─── 辅助工厂 ───

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

function makeFlowRun(tasks: Record<string, TaskState> = {}): FlowRun {
  const fr = createInitialFlowRun("flow-o/r-1", "owner/repo", 1)
  return {
    ...fr,
    status: "running",
    revision: 10,
    stages: {
      ...fr.stages,
      code: { ...fr.stages.code, status: "running" },
    },
    tasks: {
      "task-1": makeTaskState(),
      ...tasks,
    },
  }
}

function setupBrokerRead(flowRun: FlowRun) {
  mockReadFlowRunWithLock.mockResolvedValue({
    flowRunResult: { ok: true, data: flowRun, migrated: false },
    currentBody: "mock-issue-body",
  })
}

function setupBrokerWriteSuccess() {
  mockWriteFlowRunWithLock.mockResolvedValue({ success: true, conflict: false })
}

describe("handleFlowPrCreateWithBroker", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockGh.mockReset()
  })

  describe("preflight failures", () => {
    it("returns error when task is not running", async () => {
      const task = makeTaskState({ status: "pending" })
      const flowRun = makeFlowRun({ "task-1": task })
      const broker = new FlowBroker()

      setupBrokerRead(flowRun)
      setupBrokerWriteSuccess()

      const resp = await handleFlowPrCreateWithBroker(broker, {
        op: "pr-create",
        parentIssueNumber: 1,
        taskId: "task-1",
        currentHeadSha: "committed-head-sha",
        prTitle: "feat: test",
        prBody: "body",
      })

      expect(resp.ok).toBe(false)
      expect(resp.error?.code).toBe("TASK_NOT_RUNNING")
      expect(resp.persisted).toBe(false)
    })

    it("returns error when regression not complete", async () => {
      const task = makeTaskState({
        tddEvidence: {
          ...makePassingEvidence(),
          regression: { ...makePassingEvidence().regression, status: "pending" },
        },
      })
      const flowRun = makeFlowRun({ "task-1": task })
      const broker = new FlowBroker()

      setupBrokerRead(flowRun)
      setupBrokerWriteSuccess()

      const resp = await handleFlowPrCreateWithBroker(broker, {
        op: "pr-create",
        parentIssueNumber: 1,
        taskId: "task-1",
        currentHeadSha: "committed-head-sha",
        prTitle: "feat: test",
        prBody: "body",
      })

      expect(resp.ok).toBe(false)
      expect(resp.error?.code).toBe("REGRESSION_NOT_COMPLETE")
    })

    it("returns error when verification not complete", async () => {
      const task = makeTaskState({
        tddEvidence: {
          ...makePassingEvidence(),
          verification: { ...makePassingEvidence().verification, status: "pending" },
        },
      })
      const flowRun = makeFlowRun({ "task-1": task })
      const broker = new FlowBroker()

      setupBrokerRead(flowRun)
      setupBrokerWriteSuccess()

      const resp = await handleFlowPrCreateWithBroker(broker, {
        op: "pr-create",
        parentIssueNumber: 1,
        taskId: "task-1",
        currentHeadSha: "committed-head-sha",
        prTitle: "feat: test",
        prBody: "body",
      })

      expect(resp.ok).toBe(false)
      expect(resp.error?.code).toBe("VERIFICATION_NOT_COMPLETE")
    })

    it("returns error when task not found in FlowRun", async () => {
      const flowRun = makeFlowRun()
      const broker = new FlowBroker()

      setupBrokerRead(flowRun)
      setupBrokerWriteSuccess()

      const resp = await handleFlowPrCreateWithBroker(broker, {
        op: "pr-create",
        parentIssueNumber: 1,
        taskId: "non-existent-task",
        currentHeadSha: "committed-head-sha",
        prTitle: "feat: test",
        prBody: "body",
      })

      expect(resp.ok).toBe(false)
      expect(resp.error?.code).toBe("TASK_NOT_FOUND")
    })
  })

  describe("successful PR creation", () => {
    it("creates a new PR and transitions task to reviewing", async () => {
      const flowRun = makeFlowRun()
      const broker = new FlowBroker()

      setupBrokerRead(flowRun)

      // 模拟 gh pr list 返回空
      mockGh.mockResolvedValueOnce({ stdout: "", stderr: "" })
      // 模拟 gh pr create 返回 PR URL
      mockGh.mockResolvedValueOnce({ stdout: "https://github.com/owner/repo/pull/123", stderr: "" })
      setupBrokerWriteSuccess()

      const resp = await handleFlowPrCreateWithBroker(broker, {
        op: "pr-create",
        parentIssueNumber: 1,
        taskId: "task-1",
        currentHeadSha: "committed-head-sha",
        prTitle: "feat: test task",
        prBody: "PR body content",
      })

      expect(resp.ok).toBe(true)
      expect(resp.persisted).toBe(true)
      expect(resp.prNumber).toBe(123)
      expect(resp.taskStatus).toBe("reviewing")
    })

    it("initializes prCheckpoints when creating PR", async () => {
      const flowRun = makeFlowRun()
      const broker = new FlowBroker()

      setupBrokerRead(flowRun)

      mockGh.mockResolvedValueOnce({ stdout: "", stderr: "" })
      mockGh.mockResolvedValueOnce({ stdout: "https://github.com/owner/repo/pull/123", stderr: "" })
      setupBrokerWriteSuccess()

      const resp = await handleFlowPrCreateWithBroker(broker, {
        op: "pr-create",
        parentIssueNumber: 1,
        taskId: "task-1",
        currentHeadSha: "committed-head-sha",
        prTitle: "feat: test task",
        prBody: "PR body",
      })

      expect(resp.ok).toBe(true)
      // 验证 broker handler 里设置了 checkpoints
      // (broker write 被 mock 了，所以通过 mockWriteFlowRunWithLock 参数验证)
      expect(mockWriteFlowRunWithLock).toHaveBeenCalledTimes(1)

      const writeCall = mockWriteFlowRunWithLock.mock.calls[0]
      // writeCall[1] 是 flowRun, writeCall[2] 是 previousBody
      const writtenFlowRun = writeCall[1]
      expect(writtenFlowRun.tasks["task-1"].prNumber).toBe(123)
      expect(writtenFlowRun.tasks["task-1"].status).toBe("reviewing")
      expect(writtenFlowRun.tasks["task-1"].prCheckpoints).toBeDefined()
      expect(writtenFlowRun.tasks["task-1"].prCheckpoints!.prNumber).toBe(123)
    })
  })

  describe("idempotency", () => {
    it("reuses existing open PR when already created", async () => {
      const flowRun = makeFlowRun()
      const broker = new FlowBroker()

      setupBrokerRead(flowRun)

      // gh pr list 返回已有 PR
      mockGh.mockResolvedValueOnce({
        stdout: JSON.stringify({ number: 42, url: "https://github.com/owner/repo/pull/42" }),
        stderr: "",
      })
      setupBrokerWriteSuccess()

      const resp = await handleFlowPrCreateWithBroker(broker, {
        op: "pr-create",
        parentIssueNumber: 1,
        taskId: "task-1",
        currentHeadSha: "committed-head-sha",
        prTitle: "feat: test task",
        prBody: "PR body",
      })

      expect(resp.ok).toBe(true)
      expect(resp.persisted).toBe(true)
      // 验证找到了已有 PR，但没有创建新的
      expect(mockGh).toHaveBeenCalledTimes(1) // only pr list, no pr create
      expect(mockGh.mock.calls[0][0]).toContain("pr list")

      // 验证 write 调用
      const writeCall = mockWriteFlowRunWithLock.mock.calls[0]
      const writtenFlowRun = writeCall[1]
      expect(writtenFlowRun.tasks["task-1"].prNumber).toBe(42)
      expect(writtenFlowRun.tasks["task-1"].status).toBe("reviewing")
    })
  })

  describe("compensation - PR created but FlowRun write fails", () => {
    it("recovers by finding the already-created PR on retry", async () => {
      const flowRun = makeFlowRun()
      const broker = new FlowBroker()

      // ── 第一次调用：PR 创建成功，但 FlowRun 写入失败 ──
      setupBrokerRead(flowRun)

      // gh pr list: 第一次为空
      mockGh.mockResolvedValueOnce({ stdout: "", stderr: "" })
      // gh pr create: 成功创建 PR
      mockGh.mockResolvedValueOnce({ stdout: "https://github.com/owner/repo/pull/777", stderr: "" })
      // writeFlowRunWithLock: 模拟失败（如冲突）
      mockWriteFlowRunWithLock.mockResolvedValueOnce({
        success: false,
        error: "Conflict: body changed",
        conflict: true,
      })

      const resp1 = await handleFlowPrCreateWithBroker(broker, {
        op: "pr-create",
        parentIssueNumber: 1,
        taskId: "task-1",
        currentHeadSha: "committed-head-sha",
        prTitle: "feat: test task",
        prBody: "PR body",
      })

      expect(resp1.ok).toBe(false)
      expect(resp1.conflictPause).toBe(true)

      // ── 第二次调用（重试/恢复）：应该找回已创建的 PR ──
      // 重新设置 flowRun（模拟重新读取）
      const flowRun2 = makeFlowRun()
      setupBrokerRead(flowRun2)

      // gh pr list: 这次返回已存在的 PR
      mockGh.mockResolvedValueOnce({
        stdout: JSON.stringify({ number: 777, url: "https://github.com/owner/repo/pull/777" }),
        stderr: "",
      })
      // write 这次成功
      setupBrokerWriteSuccess()

      const resp2 = await handleFlowPrCreateWithBroker(broker, {
        op: "pr-create",
        parentIssueNumber: 1,
        taskId: "task-1",
        currentHeadSha: "committed-head-sha",
        prTitle: "feat: test task",
        prBody: "PR body",
      })

      expect(resp2.ok).toBe(true)
      expect(resp2.persisted).toBe(true)

      // 验证没有再次创建 PR
      expect(mockGh).toHaveBeenCalledTimes(3) // 1 (list) + 1 (create) + 1 (list on retry)
      expect(mockGh.mock.calls[0][0]).toContain("pr list")
      expect(mockGh.mock.calls[1][0]).toContain("pr create")
      expect(mockGh.mock.calls[2][0]).toContain("pr list") // retry only queries

      // 验证写入了正确的 PR number
      const writeCall2 = mockWriteFlowRunWithLock.mock.calls[1]
      const writtenFlowRun2 = writeCall2[1]
      expect(writtenFlowRun2.tasks["task-1"].prNumber).toBe(777)
      expect(writtenFlowRun2.tasks["task-1"].status).toBe("reviewing")
    })
  })

  describe("persist failure without conflict", () => {
    it("returns error when read fails", async () => {
      const broker = new FlowBroker()

      mockReadFlowRunWithLock.mockResolvedValue({
        flowRunResult: { ok: false, code: "NOT_FOUND", errors: [{ path: "", message: "not found" }] },
        currentBody: null,
      })

      const resp = await handleFlowPrCreateWithBroker(broker, {
        op: "pr-create",
        parentIssueNumber: 1,
        taskId: "task-1",
        currentHeadSha: "committed-head-sha",
        prTitle: "feat: test",
        prBody: "body",
      })

      expect(resp.ok).toBe(false)
      expect(resp.conflictPause).toBe(false)
      expect(resp.error?.code).toBe("READ_FAILED")
    })
  })
})

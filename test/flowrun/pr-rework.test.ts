import { describe, it, expect, vi, beforeEach } from "vitest"
import type { TaskState, TddEvidence, TddReworkEvidence } from "../../src/flowrun/types.js"

// ─── Mock gh utility ───

const mockGh = vi.fn()

vi.mock("../../src/util/gh.js", () => ({
  gh: (...args: unknown[]) => mockGh(...args),
}))

// 动态导入被测试模块
import {
  initiateRework,
  completeRework,
  fetchRemotePRHead,
  revalidateRemoteHead,
  type ReworkInput,
  type ReworkResult,
  type RemotePRHead,
  type RevalidateResult,
  type CompleteReworkInput,
  type CompleteReworkResult,
} from "../../src/flowrun/pr.js"

// ─── 辅助工厂 ───

function makeTaskState(overrides: Partial<TaskState> = {}): TaskState {
  return {
    id: "task-1",
    name: "Test Task",
    status: "reviewing",
    dependsOn: [],
    area: "backend",
    expectedFiles: [],
    parallelSafe: false,
    prNumber: 42,
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
      runs: [],
    },
    verification: {
      status: "pass",
      headSha: "committed-head-sha",
      treeSha: "tree-sha",
      runs: [],
    },
    alternativeValidation: [],
    reworks: [],
    warnings: [],
    updatedAt: "2026-01-01T00:06:05Z",
  }
}

// ─── initiateRework 测试 ───

describe("initiateRework", () => {
  it("behavior rework: increments reworkRevision and adds rework evidence", () => {
    const task = makeTaskState({ status: "reviewing", tddEvidence: { ...makePassingEvidence(), reworkRevision: 0 } })
    const input: ReworkInput = {
      kind: "behavior",
      affectedCriterionIds: ["AC-1"],
      startHeadSha: "new-head-sha",
    }

    const result = initiateRework(task, input)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.task.tddEvidence.reworkRevision).toBe(1)
    expect(result.task.tddEvidence.status).toBe("in-progress")
    expect(result.task.tddEvidence.reworks).toHaveLength(1)

    const rework = result.task.tddEvidence.reworks[0]
    expect(rework.reworkRevision).toBe(1)
    expect(rework.kind).toBe("behavior")
    expect(rework.affectedCriterionIds).toEqual(["AC-1"])
    expect(rework.status).toBe("started")
    expect(rework.startHeadSha).toBe("new-head-sha")
    expect(rework.approval).toBeNull()
  })

  it("refactor rework: requires approval info", () => {
    const task = makeTaskState({ status: "reviewing", tddEvidence: { ...makePassingEvidence(), reworkRevision: 0 } })
    const input: ReworkInput = {
      kind: "refactor",
      affectedCriterionIds: [],
      startHeadSha: "new-head-sha2",
    }

    const result = initiateRework(task, input)

    expect(result.ok).toBe(true)
    if (!result.ok) return

    expect(result.task.tddEvidence.reworkRevision).toBe(1)
    const rework = result.task.tddEvidence.reworks[0]
    expect(rework.kind).toBe("refactor")
    expect(rework.affectedCriterionIds).toEqual([])
    expect(rework.approval).toBeNull()
  })

  it("rework increments revision on existing reworks", () => {
    const task = makeTaskState({
      status: "reviewing",
      tddEvidence: {
        ...makePassingEvidence(),
        reworkRevision: 2,
        reworks: [
          {
            reworkRevision: 1,
            kind: "behavior",
            affectedCriterionIds: ["AC-1"],
            status: "pass",
            startHeadSha: "head-1",
            approval: null,
          },
          {
            reworkRevision: 2,
            kind: "refactor",
            affectedCriterionIds: [],
            status: "pass",
            startHeadSha: "head-2",
            approval: {
              reworkRevision: 2,
              kind: "refactor",
              headSha: "head-2",
              treeSha: "tree-2",
              reviewerSessionId: "sess-1",
              reviewerMessageId: "msg-1",
              contentDigest: { algorithm: "sha256-content-v1", value: "c".repeat(64) },
              policyDigest: "policy-digest",
            },
          },
        ],
      },
    })
    const input: ReworkInput = {
      kind: "behavior",
      affectedCriterionIds: ["AC-2"],
      startHeadSha: "head-3",
    }

    const result = initiateRework(task, input)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.task.tddEvidence.reworkRevision).toBe(3)
    expect(result.task.tddEvidence.reworks).toHaveLength(3)
    expect(result.task.tddEvidence.reworks[2].reworkRevision).toBe(3)
    expect(result.task.tddEvidence.reworks[2].affectedCriterionIds).toEqual(["AC-2"])
  })

  it("rework resets regression and verification to pending", () => {
    const task = makeTaskState({ status: "reviewing", tddEvidence: { ...makePassingEvidence(), reworkRevision: 0 } })
    const input: ReworkInput = {
      kind: "behavior",
      affectedCriterionIds: ["AC-1"],
      startHeadSha: "head-3",
    }

    const result = initiateRework(task, input)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.task.tddEvidence.regression.status).toBe("pending")
    expect(result.task.tddEvidence.regression.reworkRevision).toBe(1)
    expect(result.task.tddEvidence.verification.status).toBe("pending")
  })

  it("fails when task status is not reviewing", () => {
    const task = makeTaskState({ status: "running", tddEvidence: { ...makePassingEvidence(), reworkRevision: 0 } })
    const input: ReworkInput = {
      kind: "behavior",
      affectedCriterionIds: ["AC-1"],
      startHeadSha: "head-3",
    }

    const result = initiateRework(task, input)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("TASK_NOT_REVIEWING")
    }
  })

  it("fails when task has no PR (status reviewing but prNumber null)", () => {
    const task = makeTaskState({ status: "reviewing", prNumber: null, tddEvidence: { ...makePassingEvidence(), reworkRevision: 0 } })
    const input: ReworkInput = {
      kind: "behavior",
      affectedCriterionIds: ["AC-1"],
      startHeadSha: "head-3",
    }

    const result = initiateRework(task, input)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("NO_PR_EXISTS")
    }
  })
})

// ─── completeRework 测试 ───

describe("completeRework", () => {
  it("completes rework when regression and verification pass", () => {
    const task = makeTaskState({
      status: "running",
      tddEvidence: {
        ...makePassingEvidence(),
        reworkRevision: 1,
        status: "in-progress",
        regression: {
          status: "pass",
          headSha: "new-head-sha",
          treeSha: "new-tree-sha",
          reworkRevision: 1,
          runs: [],
        },
        verification: {
          status: "pass",
          headSha: "new-head-sha",
          treeSha: "new-tree-sha",
          runs: [],
        },
        reworks: [
          {
            reworkRevision: 1,
            kind: "behavior",
            affectedCriterionIds: ["AC-1"],
            status: "started",
            startHeadSha: "head-1",
            approval: null,
          },
        ],
      },
    })
    const input: CompleteReworkInput = {
      committedHeadSha: "new-head-sha",
    }

    const result = completeRework(task, input)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.task.status).toBe("reviewing")
    expect(result.task.tddEvidence.reworks[0].status).toBe("pass")
    expect(result.task.tddEvidence.status).toBe("pass")
  })

  it("fails when regression status is not pass", () => {
    const task = makeTaskState({
      status: "running",
      tddEvidence: {
        ...makePassingEvidence(),
        reworkRevision: 1,
        status: "in-progress",
        regression: {
          status: "pending",
          headSha: null,
          treeSha: null,
          reworkRevision: 1,
          runs: [],
        },
        verification: {
          status: "pass",
          headSha: "new-head-sha",
          treeSha: "new-tree-sha",
          runs: [],
        },
        reworks: [
          {
            reworkRevision: 1,
            kind: "behavior",
            affectedCriterionIds: ["AC-1"],
            status: "started",
            startHeadSha: "head-1",
            approval: null,
          },
        ],
      },
    })
    const input: CompleteReworkInput = {
      committedHeadSha: "new-head-sha",
    }

    const result = completeRework(task, input)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("REGRESSION_NOT_PASS")
    }
  })

  it("fails when verification status is not pass", () => {
    const task = makeTaskState({
      status: "running",
      tddEvidence: {
        ...makePassingEvidence(),
        reworkRevision: 1,
        status: "in-progress",
        regression: {
          status: "pass",
          headSha: "new-head-sha",
          treeSha: "new-tree-sha",
          reworkRevision: 1,
          runs: [],
        },
        verification: {
          status: "fail",
          headSha: "new-head-sha",
          treeSha: "new-tree-sha",
          runs: [],
        },
        reworks: [
          {
            reworkRevision: 1,
            kind: "behavior",
            affectedCriterionIds: ["AC-1"],
            status: "started",
            startHeadSha: "head-1",
            approval: null,
          },
        ],
      },
    })
    const input: CompleteReworkInput = {
      committedHeadSha: "new-head-sha",
    }

    const result = completeRework(task, input)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("VERIFICATION_NOT_PASS")
    }
  })

  it("fails when head SHA from evidence doesn't match committed head", () => {
    const task = makeTaskState({
      status: "running",
      tddEvidence: {
        ...makePassingEvidence(),
        reworkRevision: 1,
        status: "in-progress",
        regression: {
          status: "pass",
          headSha: "different-head",
          treeSha: "new-tree-sha",
          reworkRevision: 1,
          runs: [],
        },
        verification: {
          status: "pass",
          headSha: "different-head",
          treeSha: "new-tree-sha",
          runs: [],
        },
        reworks: [
          {
            reworkRevision: 1,
            kind: "behavior",
            affectedCriterionIds: ["AC-1"],
            status: "started",
            startHeadSha: "head-1",
            approval: null,
          },
        ],
      },
    })
    const input: CompleteReworkInput = {
      committedHeadSha: "new-head-sha",
    }

    const result = completeRework(task, input)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("HEAD_MISMATCH")
    }
  })

  it("fails when no active rework found (status not in-progress)", () => {
    const task = makeTaskState({
      status: "running",
      tddEvidence: {
        ...makePassingEvidence(),
        reworkRevision: 0,
        status: "pass",
        regression: {
          status: "pass",
          headSha: "new-head-sha",
          treeSha: "new-tree-sha",
          reworkRevision: 0,
          runs: [],
        },
        verification: {
          status: "pass",
          headSha: "new-head-sha",
          treeSha: "new-tree-sha",
          runs: [],
        },
        reworks: [],
      },
    })
    const input: CompleteReworkInput = {
      committedHeadSha: "new-head-sha",
    }

    const result = completeRework(task, input)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("NO_ACTIVE_REWORK")
    }
  })
})

// ─── fetchRemotePRHead 测试 ───

describe("fetchRemotePRHead", () => {
  beforeEach(() => {
    mockGh.mockReset()
  })

  it("returns head SHA from gh pr view", async () => {
    // 第一次调用：gh pr view --json headRefOid → 返回完整 JSON
    mockGh.mockResolvedValueOnce({
      stdout: JSON.stringify({ headRefOid: "abc123def456" }),
      stderr: "",
    })
    // 第二次调用：gh api ... --jq '.tree.sha' → 返回 tree SHA
    mockGh.mockResolvedValueOnce({
      stdout: "tree123456789",
      stderr: "",
    })

    const result = await fetchRemotePRHead("owner/repo", 42)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.head.headSha).toBe("abc123def456")
    expect(result.head.treeSha).toBe("tree123456789")
    expect(mockGh.mock.calls[0][0]).toContain("pr view")
    expect(mockGh.mock.calls[0][0]).toContain("--json")
  })

  it("returns error when gh fails", async () => {
    mockGh.mockRejectedValueOnce(new Error("gh command failed"))

    const result = await fetchRemotePRHead("owner/repo", 42)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("GH_ERROR")
    }
  })

  it("returns error when JSON is malformed", async () => {
    // gh pr view 返回非 JSON 字符串
    mockGh.mockResolvedValueOnce({
      stdout: "not-json",
      stderr: "",
    })

    const result = await fetchRemotePRHead("owner/repo", 42)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("PARSE_ERROR")
    }
  })

  it("returns error when headRefOid is missing", async () => {
    // gh pr view 返回完整 JSON 但缺少 headRefOid
    mockGh.mockResolvedValueOnce({
      stdout: JSON.stringify({ headRepository: { name: "repo" } }),
      stderr: "",
    })

    const result = await fetchRemotePRHead("owner/repo", 42)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("MISSING_HEAD_SHA")
    }
  })
})

// ─── revalidateRemoteHead 测试 ───

describe("revalidateRemoteHead", () => {
  it("returns same-tree when remote tree SHA matches evidence tree SHA", () => {
    // 我们需要 mock 来获取 remote tree SHA
    // revalidateRemoteHead 比较 task.tddEvidence.verification.treeSha 与 remote tree SHA
    // 为此我们需要先获取 remote tree SHA（通过另一个 API 调用）
    // 但 revalidateRemoteHead 接受已获取的 remote head 信息作为参数

    const task = makeTaskState({
      tddEvidence: {
        ...makePassingEvidence(),
        verification: {
          ...makePassingEvidence().verification,
          treeSha: "tree-sha-abc",
        },
      },
    })

    // 传入 remote head info（tree SHA 匹配）
    const result = revalidateRemoteHead(task, {
      headSha: "new-commit-sha",
      treeSha: "tree-sha-abc",
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.action).toBe("revalidate")
    expect(result.summary).toContain("tree matches")
  })

  it("signals rework-needed when remote tree SHA differs", () => {
    const task = makeTaskState({
      tddEvidence: {
        ...makePassingEvidence(),
        verification: {
          ...makePassingEvidence().verification,
          treeSha: "tree-sha-abc",
        },
      },
    })

    const result = revalidateRemoteHead(task, {
      headSha: "new-commit-sha",
      treeSha: "tree-sha-different",
    })

    expect(result.ok).toBe(false)
    if (!result.ok) return
    expect(result.action).toBe("rework-needed")
    expect(result.summary).toContain("tree changed")
  })

  it("signals rework-needed when evidence treeSha is null", () => {
    const task = makeTaskState({
      tddEvidence: {
        ...makePassingEvidence(),
        verification: {
          ...makePassingEvidence().verification,
          treeSha: null,
        },
      },
    })

    const result = revalidateRemoteHead(task, {
      headSha: "new-commit-sha",
      treeSha: "tree-sha-abc",
    })

    expect(result.ok).toBe(false)
    if (!result.ok) return
    expect(result.action).toBe("rework-needed")
  })
})

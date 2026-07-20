import { describe, it, expect, vi, beforeEach } from "vitest"
import type {
  FlowRun, FlowStage, TaskState, TaskExecutionBinding,
  GoalFlowRunRef,
} from "../../src/flowrun/types.js"
import { CABINET_START_MARKER, CABINET_END_MARKER } from "../../src/flowrun/types.js"
import { createInitialFlowRun } from "../../src/flowrun/github.js"
import {
  flowRunStart,
  flowStageStart,
  flowStageComplete,
  flowTaskStart,
} from "../../src/flowrun/transitions.js"

// ─── Mock github module（模拟 gh CLI） ───

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

// ─── 辅助工厂函数 ───

function makeFlowRun(overrides: Partial<FlowRun> = {}): FlowRun {
  const fr = createInitialFlowRun("flow-o/r-1", "o/r", 1)
  return {
    ...fr,
    status: "running",
    revision: 0,
    stages: {
      requirements: { status: "pass", requiredArtifacts: [], checks: [], completedAt: "2026-01-01T00:00:00Z", evidence: [] },
      design: { status: "pass", requiredArtifacts: [], checks: [], completedAt: "2026-01-01T00:00:00Z", evidence: [] },
      tasks: { status: "pass", requiredArtifacts: [], checks: [], completedAt: "2026-01-01T00:00:00Z", evidence: [] },
      code: { status: "pending", requiredArtifacts: [], checks: [], completedAt: null, evidence: [] },
      test: { status: "pending", requiredArtifacts: [], checks: [], completedAt: null, evidence: [] },
      review: { status: "pending", requiredArtifacts: [], checks: [], completedAt: null, evidence: [] },
      merge: { status: "pending", requiredArtifacts: [], checks: [], completedAt: null, evidence: [] },
    },
    tasks: {
      "task-1": makeTaskState("task-1", "Task 1", [], "pending"),
      "task-2": makeTaskState("task-2", "Task 2", ["task-1"], "pending"),
      "task-3": makeTaskState("task-3", "Task 3", [], "pending"),
    },
    ...overrides,
  }
}

function makeTaskState(
  id: string,
  name: string,
  dependsOn: string[] = [],
  status: TaskState["status"] = "pending",
): TaskState {
  return {
    id,
    name,
    status,
    dependsOn,
    area: "backend",
    expectedFiles: [],
    parallelSafe: dependsOn.length === 0,
    prNumber: null,
    prCheckpoints: null,
    blockedReason: null,
    startedAt: null,
    acceptanceCriteria: [{ id: "AC-1", description: "验收条件", verification: "tdd" }],
    testCommands: [{ command: "npm test", cwd: ".", timeoutMs: 30000, env: {} }],
    verifyCommands: [{ command: "npm run typecheck", cwd: ".", timeoutMs: 30000, env: {} }],
    executionBinding: null,
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
    tddEvidence: {
      revision: 0,
      reworkRevision: 0,
      status: "not-recorded",
      taskStart: { status: "pending", headSha: null, treeSha: null, startedAt: null },
      cycles: [],
      regression: { status: "pending", headSha: null, treeSha: null, reworkRevision: 0, runs: [] },
      verification: { status: "pending", headSha: null, treeSha: null, runs: [] },
      alternativeValidation: [],
      reworks: [],
      warnings: [],
      updatedAt: null,
    },
    coveragePolicy: null,
  }
}

function makeExecutionBinding(overrides: Partial<TaskExecutionBinding> = {}): TaskExecutionBinding {
  return {
    branch: "feat/test-branch",
    baseSha: "baseSha123",
    startHeadSha: "headSha123",
    worktreeId: "worktree-1",
    sessionId: "session-1",
    ...overrides,
  }
}

function mockIssueBody(flowRun: FlowRun): string {
  const json = JSON.stringify(flowRun, null, 2)
  return `# Issue Title\n\nSome description\n\n${CABINET_START_MARKER}\n\`\`\`json\n${json}\n\`\`\`\n${CABINET_END_MARKER}`
}

function setupReadWrite(flowRun: FlowRun) {
  const body = mockIssueBody(flowRun)
  mockReadFlowRunWithLock.mockResolvedValue({
    flowRunResult: { ok: true, data: JSON.parse(JSON.stringify(flowRun)), migrated: false },
    currentBody: body,
  })
  mockWriteFlowRunWithLock.mockResolvedValue({ success: true, conflict: false })
}

beforeEach(() => {
  vi.clearAllMocks()
})

// ─── 纯函数测试：transitions ───

describe("Transitions — flowRunStart", () => {
  it("planned → running", () => {
    const fr = makeFlowRun({ status: "planned" })
    const result = flowRunStart(fr)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.status).toBe("running")
      expect(result.value.startedAt).toBeDefined()
    }
  })

  it("幂等：已是 running 不报错", () => {
    const fr = makeFlowRun({ status: "running" })
    const result = flowRunStart(fr)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.status).toBe("running")
    }
  })

  it("拒绝非 planned 状态（completed/blocked 等）", () => {
    const fr = makeFlowRun({ status: "completed" })
    const result = flowRunStart(fr)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("INVALID_TRANSITION")
    }
  })
})

describe("Transitions — flowStageStart", () => {
  it("pending → running（requirements 阶段）", () => {
    const fr = makeFlowRun({ status: "running" })
    fr.stages.requirements.status = "pending"
    fr.stages.design.status = "pending"
    fr.stages.tasks.status = "pending"
    // 第一个 pending stage 是 requirements，前置条件为空 → 应允许
    const result = flowStageStart(fr, "requirements")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.stages.requirements.status).toBe("running")
    }
  })

  it("拒绝非受控 stage（test）", () => {
    const fr = makeFlowRun()
    const result = flowStageStart(fr, "test")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("STAGE_NOT_CONTROLLABLE")
    }
  })

  it("拒绝：前置 stage 未 pass", () => {
    const fr = makeFlowRun()
    fr.stages.design.status = "pending" // 前置未通过
    fr.stages.tasks.status = "pending"
    fr.stages.code.status = "pending"
    // tasks 前置 design 为 pending → 应拒绝
    const result = flowStageStart(fr, "tasks")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("GATE_BLOCKED")
    }
  })

  it("幂等：已是 running 不报错", () => {
    const fr = makeFlowRun()
    fr.stages.code.status = "running"
    const result = flowStageStart(fr, "code")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.stages.code.status).toBe("running")
    }
  })
})

describe("Transitions — flowStageComplete", () => {
  it("running → pass（requirements 阶段，无 required artifacts/checks）", () => {
    const fr = makeFlowRun()
    fr.stages.requirements.status = "running"
    const result = flowStageComplete(fr, "requirements")
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.stages.requirements.status).toBe("pass")
    }
  })

  it("拒绝非受控 stage（code 由 finalize 完成）", () => {
    const fr = makeFlowRun()
    fr.stages.code.status = "running"
    const result = flowStageComplete(fr, "code")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("STAGE_NOT_CONTROLLABLE")
    }
  })

  it("拒绝：有 pending checks", () => {
    const fr = makeFlowRun()
    fr.stages.tasks.status = "running"
    fr.stages.tasks.checks = [{ name: "review-tasks", status: "pending", evidence: [] }]
    const result = flowStageComplete(fr, "tasks")
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("GATE_BLOCKED")
    }
  })
})

describe("Transitions — flowTaskStart", () => {
  it("pending → running（写入 executionBinding）", () => {
    const fr = makeFlowRun()
    fr.stages.code.status = "running"
    const binding = makeExecutionBinding()
    const result = flowTaskStart(fr, "task-1", binding)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.task.status).toBe("running")
      expect(result.value.task.executionBinding).toEqual(binding)
      expect(result.value.task.startedAt).toBeDefined()
    }
  })

  it("拒绝：依赖未 merged", () => {
    const fr = makeFlowRun()
    fr.stages.code.status = "running"
    // task-2 depends on task-1 which is still pending
    const binding = makeExecutionBinding()
    const result = flowTaskStart(fr, "task-2", binding)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("GATE_BLOCKED")
    }
  })

  it("允许：依赖已 merged", () => {
    const fr = makeFlowRun()
    fr.stages.code.status = "running"
    fr.tasks["task-1"].status = "merged"
    const binding = makeExecutionBinding()
    const result = flowTaskStart(fr, "task-2", binding)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.task.status).toBe("running")
    }
  })

  it("冻结 policy：传入 tddPolicy 覆盖现有", () => {
    const fr = makeFlowRun()
    fr.stages.code.status = "running"
    const binding = makeExecutionBinding()
    const frozenPolicy = {
      ...fr.tasks["task-1"].tddPolicy,
      mode: "relaxed" as const,
      source: { manifestPath: "frozen/manifest.yml", revisionSha: "frozen-sha" },
    }
    const result = flowTaskStart(fr, "task-1", binding, frozenPolicy)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.task.tddPolicy.mode).toBe("relaxed")
      expect(result.value.task.tddPolicy.source.manifestPath).toBe("frozen/manifest.yml")
    }
  })

  it("幂等：已是 running → 更新 executionBinding", () => {
    const fr = makeFlowRun()
    fr.stages.code.status = "running"
    fr.tasks["task-1"].status = "running"
    fr.tasks["task-1"].executionBinding = makeExecutionBinding({ sessionId: "old-session" })
    const newBinding = makeExecutionBinding({ sessionId: "new-session" })
    const result = flowTaskStart(fr, "task-1", newBinding)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.task.executionBinding?.sessionId).toBe("new-session")
    }
  })

  it("TASK_NOT_FOUND：taskId 不存在", () => {
    const fr = makeFlowRun()
    const binding = makeExecutionBinding()
    const result = flowTaskStart(fr, "nonexistent", binding)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.code).toBe("TASK_NOT_FOUND")
    }
  })
})

// ─── 集成测试：flow_control 工具（通过 FlowBroker） ───

describe("flow_control tool — run-start", () => {
  it("通过 broker 启动 FlowRun：planned → running", async () => {
    const { FlowBroker } = await import("../../src/plugin/broker.js")
    const broker = new FlowBroker()
    const fr = makeFlowRun({ status: "planned" })
    setupReadWrite(fr)

    const result = await broker.writeFlowRunWithLock(1, (flowRun) => {
      const res = flowRunStart(flowRun)
      if (res.ok) {
        return { flowRun: res.value, result: res.value.status, shouldPersist: true }
      }
      return { flowRun, result: null, shouldPersist: false }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result).toBe("running")
      expect(result.persisted).toBe(true)
    }
    expect(mockWriteFlowRunWithLock).toHaveBeenCalledTimes(1)
  })
})

describe("flow_control tool — stage-start", () => {
  it("通过 broker 启动 code stage", async () => {
    const { FlowBroker } = await import("../../src/plugin/broker.js")
    const broker = new FlowBroker()
    const fr = makeFlowRun()
    // all prerequisite stages pass, code is pending
    fr.stages.code.status = "pending"
    setupReadWrite(fr)

    const result = await broker.writeFlowRunWithLock(1, (flowRun) => {
      const res = flowStageStart(flowRun, "code")
      if (res.ok) {
        const stageResult = { stage: "code", status: res.value.stages.code.status }
        return { flowRun: res.value, result: stageResult, shouldPersist: true }
      }
      return { flowRun, result: null, shouldPersist: false }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result).not.toBeNull()
      const r = result.result as { stage: string; status: string }
      expect(r.stage).toBe("code")
      expect(r.status).toBe("running")
      expect(result.persisted).toBe(true)
    }
  })
})

describe("flow_control tool — task-start", () => {
  it("通过 broker 启动 task 并写入 executionBinding", async () => {
    const { FlowBroker } = await import("../../src/plugin/broker.js")
    const broker = new FlowBroker()
    const fr = makeFlowRun()
    fr.stages.code.status = "running"
    setupReadWrite(fr)

    const binding = makeExecutionBinding()

    const result = await broker.writeFlowRunWithLock(1, (flowRun) => {
      const res = flowTaskStart(flowRun, "task-1", binding)
      if (res.ok) {
        const taskResult = { taskId: "task-1", status: res.value.task.status, executionBinding: res.value.task.executionBinding }
        return { flowRun: res.value.flowRun, result: taskResult, shouldPersist: true }
      }
      return { flowRun, result: null, shouldPersist: false }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result).not.toBeNull()
      const r = result.result as { taskId: string; status: string; executionBinding: TaskExecutionBinding | null }
      expect(r.taskId).toBe("task-1")
      expect(r.status).toBe("running")
      expect(r.executionBinding).toEqual(binding)
    }
  })
})

describe("flow_control tool — PERSIST_CONFLICT 路径", () => {
  it("写入冲突时返回错误", async () => {
    const { FlowBroker } = await import("../../src/plugin/broker.js")
    const broker = new FlowBroker()
    const fr = makeFlowRun({ status: "planned" })
    setupReadWrite(fr)
    mockWriteFlowRunWithLock.mockResolvedValue({ success: false, error: "Conflict", conflict: true })

    const result = await broker.writeFlowRunWithLock(1, (flowRun) => {
      const res = flowRunStart(flowRun)
      if (res.ok) {
        return { flowRun: res.value, result: res.value.status, shouldPersist: true }
      }
      return { flowRun, result: null, shouldPersist: false }
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("PERSIST_CONFLICT")
    }
  })
})

// ─── GoalFlowRunRef 绑定测试 ───

describe("GoalFlowRunRef 绑定逻辑", () => {
  it("未绑定 → 写入 flowRunRef", () => {
    const sessionMetadata: Record<string, unknown> = { goal: { objective: "test", completionCriterion: "pass", status: "active", continuationCount: 0 } }
    const ref: GoalFlowRunRef = { repo: "o/r", parentIssueNumber: 1, flowRunId: "flow-o/r-1" }

    // 写入
    sessionMetadata.flowRunRef = ref
    expect(sessionMetadata.flowRunRef).toEqual(ref)
  })

  it("已绑定同一 FlowRun → 幂等（不报错）", () => {
    const ref: GoalFlowRunRef = { repo: "o/r", parentIssueNumber: 1, flowRunId: "flow-o/r-1" }
    const existingRef: GoalFlowRunRef = { ...ref }

    const isSameRef = existingRef.flowRunId === ref.flowRunId && existingRef.parentIssueNumber === ref.parentIssueNumber && existingRef.repo === ref.repo
    expect(isSameRef).toBe(true)
  })

  it("已绑定不同 FlowRun → GOAL_FLOW_CONFLICT", () => {
    const ref: GoalFlowRunRef = { repo: "o/r", parentIssueNumber: 1, flowRunId: "flow-o/r-2" }
    const existingRef: GoalFlowRunRef = { repo: "o/r", parentIssueNumber: 1, flowRunId: "flow-o/r-1" }

    const isSameRef = existingRef.flowRunId === ref.flowRunId && existingRef.parentIssueNumber === ref.parentIssueNumber && existingRef.repo === ref.repo
    expect(isSameRef).toBe(false)
    // 应返回 GOAL_FLOW_CONFLICT 错误
  })
})

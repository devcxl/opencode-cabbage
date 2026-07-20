import { describe, it, expect, vi, beforeEach } from "vitest"
import { FlowBroker } from "../../src/plugin/broker.js"
import type { FlowRun, TaskState } from "../../src/flowrun/types.js"
import { CABINET_START_MARKER, CABINET_END_MARKER } from "../../src/flowrun/types.js"
import { createInitialFlowRun } from "../../src/flowrun/github.js"
import { createTaskEvidence } from "../../src/plugin/tdd-tool.js"

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

// ─── Mock gh util (for verifyCredentials tests) ───

const mockGhFn = vi.fn()

vi.mock("../../src/util/gh.js", () => ({
  gh: (...args: unknown[]) => mockGhFn(...args),
}))

// ─── 辅助函数 ───

function delay(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

function makeFlowRun(overrides: Partial<FlowRun> = {}): FlowRun {
  const fr = createInitialFlowRun("flow-o/r-1", "o/r", 1)
  return {
    ...fr,
    status: "running",
    revision: 0,
    tasks: {
      "task-1": makeTaskState(),
      "task-2": makeTaskState({ id: "task-2", name: "Task 2" }),
    },
    ...overrides,
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
    acceptanceCriteria: [{ id: "AC-1", description: "TDD test", verification: "tdd" }],
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
    tddEvidence: createTaskEvidence(),
    coveragePolicy: null,
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

// ─── 独立凭证测试 ───

describe("FlowBroker — 独立凭证", () => {
  it("接受 BrokerCredentials 构造参数", () => {
    const broker = new FlowBroker({ token: "ghp_test123" })
    expect(broker).toBeDefined()
  })

  it("无凭证构造时正常运行（降级 ambient）", () => {
    const broker = new FlowBroker()
    expect(broker).toBeDefined()
  })

  it("broker token 不在 JSON 序列化输出中", () => {
    const broker = new FlowBroker({ token: "ghp_secret_do_not_leak" })
    const serialized = JSON.stringify(broker)
    expect(serialized).not.toContain("ghp_secret_do_not_leak")
  })

  it("broker token 不通过 Object.keys 暴露", () => {
    const broker = new FlowBroker({ token: "ghp_secret" })
    const valueStr = JSON.stringify(Object.values(broker as unknown as Record<string, unknown>))
    // Token 不应作为可枚举属性出现
    expect(valueStr).not.toContain("ghp_secret")
  })
})

describe("FlowBroker — verifyCredentials", () => {
  it("无凭证时返回 ok: false", async () => {
    const broker = new FlowBroker()
    const result = await broker.verifyCredentials()
    expect(result.ok).toBe(false)
    expect(result.message).toContain("No broker credentials")
    // 无凭证时不应调用 gh
    expect(mockGhFn).not.toHaveBeenCalled()
  })

  it("凭证有效时返回 ok: true", async () => {
    mockGhFn.mockResolvedValue({ stdout: "", stderr: "" })

    const broker = new FlowBroker({ token: "ghp_valid_token" })
    const result = await broker.verifyCredentials()

    expect(result.ok).toBe(true)
    expect(mockGhFn).toHaveBeenCalledWith(
      "auth status",
      15_000,
      expect.objectContaining({ GH_TOKEN: "ghp_valid_token", GITHUB_TOKEN: "ghp_valid_token" }),
    )
  })

  it("凭证无效时返回 ok: false", async () => {
    mockGhFn.mockRejectedValue(new Error("Authentication failed"))

    const broker = new FlowBroker({ token: "ghp_invalid" })
    const result = await broker.verifyCredentials()

    expect(result.ok).toBe(false)
    expect(result.message).toContain("failed")
  })
})

describe("FlowBroker — 凭证传递给 GitHub 操作", () => {
  it("有凭证时 readFlowRunWithLock 收到 ghEnv", async () => {
    const broker = new FlowBroker({ token: "ghp_broker" })
    const flowRun = makeFlowRun()
    setupReadWrite(flowRun)

    await broker.writeFlowRunWithLock(1, (fr) => {
      fr.status = "completed"
      return { flowRun: fr, result: 42, shouldPersist: true }
    })

    expect(mockReadFlowRunWithLock).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ GH_TOKEN: "ghp_broker", GITHUB_TOKEN: "ghp_broker" }),
    )
  })

  it("有凭证时 writeFlowRunWithLock 收到 ghEnv", async () => {
    const broker = new FlowBroker({ token: "ghp_broker" })
    const flowRun = makeFlowRun()
    setupReadWrite(flowRun)

    await broker.writeFlowRunWithLock(1, (fr) => {
      fr.status = "completed"
      return { flowRun: fr, result: 42, shouldPersist: true }
    })

    expect(mockWriteFlowRunWithLock).toHaveBeenCalledWith(
      1,
      expect.any(Object), // flowRun
      expect.any(String), // currentBody
      expect.objectContaining({ GH_TOKEN: "ghp_broker", GITHUB_TOKEN: "ghp_broker" }),
    )
  })

  it("无凭证时不传递 ghEnv（undefined）", async () => {
    const broker = new FlowBroker() // no credentials
    const flowRun = makeFlowRun()
    setupReadWrite(flowRun)

    await broker.writeFlowRunWithLock(1, (fr) => {
      fr.status = "completed"
      return { flowRun: fr, result: 42, shouldPersist: true }
    })

    expect(mockReadFlowRunWithLock).toHaveBeenCalledWith(1, undefined)
    expect(mockWriteFlowRunWithLock).toHaveBeenCalledWith(
      1,
      expect.any(Object),
      expect.any(String),
      undefined,
    )
  })

  it("enqueue 操作不传递 ghEnv（enqueue 不调用 gh）", async () => {
    const broker = new FlowBroker({ token: "ghp_broker" })
    let result = ""
    await broker.enqueue(1, async () => {
      result = "done"
      return result
    })
    expect(result).toBe("done")
    // enqueue 不应调用任何 gh 操作
    expect(mockReadFlowRunWithLock).not.toHaveBeenCalled()
    expect(mockWriteFlowRunWithLock).not.toHaveBeenCalled()
  })
})

// ─── Keyed Mutex 测试 ───

describe("FlowBroker — enqueue (keyed mutex)", () => {
  it("串行化相同 parentIssueNumber 的操作", async () => {
    const broker = new FlowBroker()
    const order: number[] = []

    const op1 = broker.enqueue(1, async () => {
      order.push(1)
      await delay(30)
      order.push(2)
      return "a"
    })

    const op2 = broker.enqueue(1, async () => {
      order.push(3)
      await delay(10)
      order.push(4)
      return "b"
    })

    const [r1, r2] = await Promise.all([op1, op2])
    expect(order).toEqual([1, 2, 3, 4])
    expect(r1).toBe("a")
    expect(r2).toBe("b")
  })

  it("允许不同 parentIssueNumber 的操作并行", async () => {
    const broker = new FlowBroker()
    const order: number[] = []

    const op1 = broker.enqueue(1, async () => {
      order.push(1)
      await delay(50)
      order.push(2)
      return "a"
    })

    const op2 = broker.enqueue(2, async () => {
      order.push(3)
      await delay(10)
      order.push(4)
      return "b"
    })

    const [r1, r2] = await Promise.all([op1, op2])
    // key 2 的操作应在 key 1 操作完成前完成
    expect(order).toEqual([1, 3, 4, 2])
    expect(r1).toBe("a")
    expect(r2).toBe("b")
  })

  it("不同 keys 各自串行，互不干扰", async () => {
    const broker = new FlowBroker()
    const order: number[] = []

    const k1a = broker.enqueue(1, async () => {
      order.push(1)
      await delay(30)
      order.push(2)
    })
    const k1b = broker.enqueue(1, async () => {
      order.push(3)
      await delay(10)
      order.push(4)
    })
    const k2a = broker.enqueue(2, async () => {
      order.push(5)
      await delay(30)
      order.push(6)
    })
    const k2b = broker.enqueue(2, async () => {
      order.push(7)
      await delay(10)
      order.push(8)
    })

    await Promise.all([k1a, k1b, k2a, k2b])
    // key 1 内部: 1,2,3,4 顺序
    // key 2 内部: 5,6,7,8 顺序
    expect(order.indexOf(2)).toBeGreaterThan(order.indexOf(1))
    expect(order.indexOf(3)).toBeGreaterThan(order.indexOf(2))
    expect(order.indexOf(4)).toBeGreaterThan(order.indexOf(3))
    expect(order.indexOf(6)).toBeGreaterThan(order.indexOf(5))
    expect(order.indexOf(7)).toBeGreaterThan(order.indexOf(6))
    expect(order.indexOf(8)).toBeGreaterThan(order.indexOf(7))
  })
})

// ─── writeFlowRunWithLock 测试 ───

describe("FlowBroker — writeFlowRunWithLock", () => {
  it("成功执行 read-modify-write 循环", async () => {
    const broker = new FlowBroker()
    const flowRun = makeFlowRun()
    setupReadWrite(flowRun)

    const result = await broker.writeFlowRunWithLock(1, (fr) => {
      fr.status = "completed"
      return { flowRun: fr, result: 42, shouldPersist: true }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result).toBe(42)
      expect(result.persisted).toBe(true)
    }

    // 验证 readFlowRunWithLock 被调用
    expect(mockReadFlowRunWithLock).toHaveBeenCalledWith(1, undefined)
    // 验证 writeFlowRunWithLock 被调用，且 revision 已 bump
    expect(mockWriteFlowRunWithLock).toHaveBeenCalledTimes(1)
    const writtenFlowRun = mockWriteFlowRunWithLock.mock.calls[0][1] as FlowRun
    expect(writtenFlowRun.revision).toBe(flowRun.revision + 1)
    expect(writtenFlowRun.status).toBe("completed")
  })

  it("shouldPersist=false 时不执行写入", async () => {
    const broker = new FlowBroker()
    const flowRun = makeFlowRun()
    setupReadWrite(flowRun)

    const result = await broker.writeFlowRunWithLock(1, (fr) => {
      return { flowRun: fr, result: "skipped", shouldPersist: false }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result).toBe("skipped")
      expect(result.persisted).toBe(false)
    }
    // 验证未调用 writeFlowRunWithLock
    expect(mockWriteFlowRunWithLock).not.toHaveBeenCalled()
  })

  it("检测到 body 变化时返回 PERSIST_CONFLICT", async () => {
    const broker = new FlowBroker()
    const flowRun = makeFlowRun()
    setupReadWrite(flowRun)
    // 模拟写入冲突
    mockWriteFlowRunWithLock.mockResolvedValue({ success: false, error: "Conflict: body has changed", conflict: true })

    const result = await broker.writeFlowRunWithLock(1, (fr) => {
      fr.status = "completed"
      return { flowRun: fr, result: null, shouldPersist: true }
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("PERSIST_CONFLICT")
    }
  })

  it("读取失败时返回 READ_FAILED", async () => {
    const broker = new FlowBroker()
    mockReadFlowRunWithLock.mockResolvedValue({
      flowRunResult: { ok: false, code: "NOT_FOUND", errors: [{ path: "", message: "Not found" }] },
      currentBody: null,
    })

    const result = await broker.writeFlowRunWithLock(1, (fr) => {
      return { flowRun: fr, result: null, shouldPersist: true }
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("READ_FAILED")
    }
  })

  it("每次写入自动增加 revision 和时间戳", async () => {
    const broker = new FlowBroker()
    const flowRun = makeFlowRun({ revision: 5 })
    setupReadWrite(flowRun)

    await broker.writeFlowRunWithLock(1, (fr) => {
      return { flowRun: fr, result: null, shouldPersist: true }
    })

    const written = mockWriteFlowRunWithLock.mock.calls[0][1] as FlowRun
    expect(written.revision).toBe(6)
    expect(written.lastTickAt).toBeDefined()
    expect(new Date(written.lastTickAt!).getTime()).toBeGreaterThan(0)
  })
})

// ─── 并行写入互不覆盖测试 ───

describe("FlowBroker — 并行写入互不覆盖", () => {
  it("两个并行操作修改不同 Task → 均持久化成功", async () => {
    const broker = new FlowBroker()
    const flowRun = makeFlowRun()
    setupReadWrite(flowRun)

    // 模拟两次写入，每次返回不同的 body
    let callCount = 0
    mockReadFlowRunWithLock.mockImplementation(async (issueNumber: number) => {
      callCount++
      // 每次读取返回不同状态的 FlowRun（模拟前一次写入已生效）
      const fr = JSON.parse(JSON.stringify(flowRun))
      if (callCount === 1) {
        fr.revision = 0
      } else {
        fr.revision = 1
        fr.tasks["task-1"].tddEvidence.revision = 1
      }
      const body = mockIssueBody(fr)
      return { flowRunResult: { ok: true, data: fr, migrated: false }, currentBody: body }
    })

    mockWriteFlowRunWithLock.mockResolvedValue({ success: true, conflict: false })

    // 操作 1：修改 task-1 的 evidence
    const op1 = broker.writeFlowRunWithLock(1, (fr) => {
      fr.tasks["task-1"].tddEvidence = {
        ...fr.tasks["task-1"].tddEvidence,
        revision: 1,
        status: "in-progress",
      }
      return { flowRun: fr, result: "op1", shouldPersist: true }
    })

    // 操作 2：修改 task-2 的 evidence
    const op2 = broker.writeFlowRunWithLock(1, (fr) => {
      fr.tasks["task-2"].tddEvidence = {
        ...fr.tasks["task-2"].tddEvidence,
        revision: 1,
        status: "pass",
      }
      return { flowRun: fr, result: "op2", shouldPersist: true }
    })

    const [r1, r2] = await Promise.all([op1, op2])

    // 两个操作都应成功（由于 keyed mutex 串行化 + 正确的 body 更新）
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)

    // 验证 writeFlowRunWithLock 被调用两次
    expect(mockWriteFlowRunWithLock).toHaveBeenCalledTimes(2)

    // 第二次写入的 FlowRun 应包含两次修改的结果
    const secondWrite = mockWriteFlowRunWithLock.mock.calls[1][1] as FlowRun
    expect(secondWrite.tasks["task-1"].tddEvidence.revision).toBe(1)
    expect(secondWrite.tasks["task-2"].tddEvidence.revision).toBe(1)
  })
})

// ─── 冲突暂停测试 ───

describe("FlowBroker — 冲突暂停", () => {
  it("检测到外部 revision 变化 → 返回 PERSIST_CONFLICT", async () => {
    const broker = new FlowBroker()
    const flowRun = makeFlowRun({ revision: 3 })
    setupReadWrite(flowRun)

    // 模拟 body 不匹配（外部修改）
    mockWriteFlowRunWithLock.mockResolvedValue({
      success: false,
      error: "Conflict: body has changed since last read",
      conflict: true,
    })

    const result = await broker.writeFlowRunWithLock(1, (fr) => {
      fr.tasks["task-1"].tddEvidence.status = "pass"
      return { flowRun: fr, result: null, shouldPersist: true }
    })

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("PERSIST_CONFLICT")
      expect(result.message).toContain("changed")
    }

    // 确认冲突后没有写入
    expect(mockWriteFlowRunWithLock).toHaveBeenCalledTimes(1)
  })

  it("冲突后 FlowRun 状态不受影响（原数据未写入）", async () => {
    const broker = new FlowBroker()
    const flowRun = makeFlowRun({ revision: 3, status: "running" })
    setupReadWrite(flowRun)

    // 第一次写入成功
    mockWriteFlowRunWithLock.mockResolvedValueOnce({ success: true, conflict: false })

    const r1 = await broker.writeFlowRunWithLock(1, (fr) => {
      fr.status = "blocked"
      return { flowRun: fr, result: null, shouldPersist: true }
    })
    expect(r1.ok).toBe(true)

    // 第二次写入冲突
    mockWriteFlowRunWithLock.mockResolvedValueOnce({
      success: false,
      error: "Conflict",
      conflict: true,
    })

    // 更新 body 为"已被外部修改"的版本
    const modifiedFR = makeFlowRun({ revision: 5, status: "cancelled" })
    const modifiedBody = mockIssueBody(modifiedFR)
    mockReadFlowRunWithLock.mockResolvedValue({
      flowRunResult: { ok: true, data: JSON.parse(JSON.stringify(modifiedFR)), migrated: false },
      currentBody: modifiedBody,
    })

    const r2 = await broker.writeFlowRunWithLock(1, (fr) => {
      fr.status = "completed"
      return { flowRun: fr, result: null, shouldPersist: true }
    })
    expect(r2.ok).toBe(false)
    if (!r2.ok) {
      expect(r2.code).toBe("PERSIST_CONFLICT")
    }
  })
})

// ─── TDD checkpoint 集成测试 ───

describe("FlowBroker — tdd_checkpoint 集成", () => {
  it("通过 broker 执行 cycle-start → 持久化 evidence", async () => {
    const broker = new FlowBroker()
    const flowRun = makeFlowRun()
    setupReadWrite(flowRun)

    const { handleTddCheckpoint } = await import("../../src/plugin/tdd-tool.js")

    const result = await broker.writeFlowRunWithLock(1, (fr) => {
      const task = fr.tasks["task-1"]
      const resp = handleTddCheckpoint(
        {
          op: "cycle-start",
          parentIssueNumber: 1,
          taskId: "task-1",
          cycleId: "cycle-1",
          criterionId: "AC-1",
          testPaths: ["test/foo.test.ts"],
          testSelector: "test/foo.test.ts",
        },
        task,
      )
      return { flowRun: fr, result: resp, shouldPersist: resp.ok }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.ok).toBe(true)
      expect(result.persisted).toBe(true)
      // 验证 evidence 已更新
      expect(result.flowRun.tasks["task-1"].tddEvidence.cycles).toHaveLength(1)
      expect(result.flowRun.tasks["task-1"].tddEvidence.cycles[0].cycleId).toBe("cycle-1")
    }
  })

  it("handleTddCheckpoint 失败时不持久化", async () => {
    const broker = new FlowBroker()
    const flowRun = makeFlowRun()
    setupReadWrite(flowRun)

    const { handleTddCheckpoint } = await import("../../src/plugin/tdd-tool.js")

    const result = await broker.writeFlowRunWithLock(1, (fr) => {
      const task = fr.tasks["task-1"]
      // 尝试一个不存在的 criterionId
      const resp = handleTddCheckpoint(
        {
          op: "cycle-start",
          parentIssueNumber: 1,
          taskId: "task-1",
          cycleId: "cycle-1",
          criterionId: "NONEXISTENT",
          testPaths: ["test/foo.test.ts"],
          testSelector: "test/foo.test.ts",
        },
        task,
      )
      return { flowRun: fr, result: resp, shouldPersist: resp.ok }
    })

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.result.ok).toBe(false)
      expect(result.result.error!.code).toBe("CRITERION_NOT_FOUND")
      expect(result.persisted).toBe(false)
    }
    // 未写入
    expect(mockWriteFlowRunWithLock).not.toHaveBeenCalled()
  })
})

// ─── 乐观锁重试逻辑测试 ───

describe("FlowBroker — 乐观锁重试", () => {
  it("enqueue 中的操作不会被并发打断", async () => {
    const broker = new FlowBroker()
    const flowRun = makeFlowRun()
    setupReadWrite(flowRun)

    let insideCount = 0
    let maxInsideCount = 0

    // 启动 3 个并行操作，但由于 keyed mutex，内部应串行
    const ops = [1, 2, 3].map(id =>
      broker.enqueue(1, async () => {
        insideCount++
        maxInsideCount = Math.max(maxInsideCount, insideCount)
        await delay(10)
        insideCount--
        return id
      })
    )

    await Promise.all(ops)
    // keyed mutex 保证同时只有一个操作在执行
    expect(maxInsideCount).toBe(1)
  })

  it("PERSIST_CONFLICT 后调用方可实现重试逻辑", async () => {
    const broker = new FlowBroker()
    const flowRun = makeFlowRun()
    setupReadWrite(flowRun)

    // 第一次冲突，第二次成功
    mockWriteFlowRunWithLock
      .mockResolvedValueOnce({ success: false, error: "Conflict", conflict: true })
      .mockResolvedValueOnce({ success: true, conflict: false })

    let attempts = 0
    const maxRetries = 3

    let finalResult: unknown = null
    for (let i = 0; i < maxRetries; i++) {
      attempts++
      const result = await broker.writeFlowRunWithLock(1, (fr) => {
        fr.tasks["task-1"].tddEvidence.status = "pass"
        return { flowRun: fr, result: "done", shouldPersist: true }
      })

      if (result.ok) {
        finalResult = result
        break
      }
      if (!result.ok && result.code === "PERSIST_CONFLICT") {
        // 重试前刷新 mock（模拟重新读取）
        const updatedFR = makeFlowRun({ revision: flowRun.revision + attempts })
        const body = mockIssueBody(updatedFR)
        mockReadFlowRunWithLock.mockResolvedValue({
          flowRunResult: { ok: true, data: JSON.parse(JSON.stringify(updatedFR)), migrated: false },
          currentBody: body,
        })
      }
    }

    expect(attempts).toBe(2)
    expect(finalResult).not.toBeNull()
    expect((finalResult as { ok: boolean })?.ok).toBe(true)
  })
})

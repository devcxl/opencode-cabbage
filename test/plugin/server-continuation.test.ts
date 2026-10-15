import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { queueContinuation, autoResume, SessionActivityTracker } from "../../src/plugin/continuation.js"
import { markAborted } from "../../src/plugin/session-abort.js"
import { createSessionGoalStore } from "../../src/plugin/goal-store.js"
import { writeIndex } from "../../src/kernel/session-index.js"

/**
 * queueContinuation 的 V2 ctx/session mock：
 * - session.get/update：goal 读改写 + 会话 tokens 快照
 * - session.context：续接前消息投影（尾部检查 + 信号检测）
 * - session.synthetic：续接发送；compact：周期性压缩；switchAgent/switchModel：profile 恢复
 * projectDir 传不可写路径，索引写入失败被静默吞掉（相关断言在 goal-tool / autoResume 测试）。
 */

const PROJECT_DIR = "/nonexistent-dir"

const ASSISTANT_MSG = {
  type: "assistant",
  id: "msg-1",
  time: { created: 1, completed: 2 },
  agent: "dev-lifecycle",
  content: [{ type: "text", text: "工作完成。" }],
}

interface HarnessOptions {
  goal?: Record<string, unknown> | null
  context?: Array<Record<string, unknown>>
  tokens?: unknown
  syntheticError?: Error
}

function makeHarness(options: HarnessOptions = {}) {
  const sessions = new Map<string, { parentID?: string; metadata: Record<string, unknown>; tokens?: unknown }>()
  const goalMeta = options.goal === undefined
    ? { parentIssueNumber: 42, status: "active" as const, continuationCount: 0 }
    : options.goal
  sessions.set("sess-main", { metadata: goalMeta ? { goal: goalMeta } : {}, tokens: options.tokens })

  const session = {
    get: vi.fn(async ({ sessionID }: { sessionID: string }) => {
      const s = sessions.get(sessionID) ?? { metadata: {} }
      return { parentID: s.parentID ?? null, metadata: s.metadata, tokens: s.tokens }
    }),
    update: vi.fn(async ({ sessionID, metadata }: { sessionID: string; metadata: Record<string, unknown> }) => {
      const existing = sessions.get(sessionID) ?? { metadata: {} }
      sessions.set(sessionID, { ...existing, metadata })
    }),
    context: vi.fn(async () => options.context ?? [ASSISTANT_MSG]),
    synthetic: options.syntheticError
      ? vi.fn(async () => { throw options.syntheticError })
      : vi.fn(async () => ({ id: "msg-c", sessionID: "sess-main", type: "synthetic" })),
    switchAgent: vi.fn(async () => undefined),
    switchModel: vi.fn(async () => undefined),
    compact: vi.fn(async () => ({ id: "msg-compact" })),
  }

  const ctx = { session } as never
  const store = createSessionGoalStore(session as never)
  const tracker = new SessionActivityTracker()
  return { ctx, session, sessions, store, tracker }
}

const activeGoal = (overrides: Record<string, unknown> = {}) => ({
  parentIssueNumber: 42,
  status: "active" as const,
  continuationCount: 0,
  ...overrides,
})

describe("queueContinuation — 子会话活动闸（事件跟踪）", () => {
  it("直接子会话 busy 时跳过续接", async () => {
    const { ctx, session, store, tracker } = makeHarness({ goal: activeGoal() })
    tracker.onCreated("child-1", "sess-main")
    tracker.onBusy("child-1")
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    expect(session.synthetic).not.toHaveBeenCalled()
  })

  it("子会话结束后正常续接", async () => {
    const { ctx, session, store, tracker } = makeHarness({ goal: activeGoal() })
    tracker.onCreated("child-1", "sess-main")
    tracker.onBusy("child-1")
    tracker.onIdle("child-1")
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    expect(session.synthetic).toHaveBeenCalledTimes(1)
  })

  it("无子会话或无关子会话时不阻塞", async () => {
    const { ctx, session, store, tracker } = makeHarness({ goal: activeGoal() })
    tracker.onCreated("child-1", "other-session")
    tracker.onBusy("child-1")
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    expect(session.synthetic).toHaveBeenCalledTimes(1)
  })
})

describe("queueContinuation — 尾部静默检查", () => {
  it("最后一条是 user 消息时跳过续接", async () => {
    const { ctx, session, store, tracker } = makeHarness({
      goal: activeGoal(),
      context: [{ type: "user", id: "msg-user", time: { created: 1 }, text: "新消息" }],
    })
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    expect(session.synthetic).not.toHaveBeenCalled()
  })

  it("最后一条是未消费的 synthetic 时跳过续接", async () => {
    const { ctx, session, store, tracker } = makeHarness({
      goal: activeGoal(),
      context: [ASSISTANT_MSG, { type: "synthetic", id: "msg-s", time: { created: 3 }, text: "续接中" }],
    })
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    expect(session.synthetic).not.toHaveBeenCalled()
  })

  it("最后 assistant 未完成（无 completed 时间）时跳过续接", async () => {
    const { ctx, session, store, tracker } = makeHarness({
      goal: activeGoal(),
      context: [{ type: "assistant", id: "msg-inflight", time: { created: 1 }, content: [{ type: "text", text: "流式中" }] }],
    })
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    expect(session.synthetic).not.toHaveBeenCalled()
  })

  it("无任何 assistant 消息时跳过续接", async () => {
    const { ctx, session, store, tracker } = makeHarness({ goal: activeGoal(), context: [] })
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    expect(session.synthetic).not.toHaveBeenCalled()
  })
})

describe("queueContinuation — [BLOCKED:] 阻塞报告", () => {
  it("agent 报告阻塞时暂停 goal 且不续接", async () => {
    const { ctx, session, store, tracker } = makeHarness({
      goal: activeGoal(),
      context: [{ ...ASSISTANT_MSG, content: [{ type: "text", text: "[BLOCKED: missing API key] 无法继续" }] }],
    })
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    expect(session.synthetic).not.toHaveBeenCalled()
    const update = session.update.mock.calls[0][0] as unknown as { metadata: { goal: { status: string } } }
    expect(update.metadata.goal.status).toBe("paused")
  })

  it("普通回复不触发阻塞暂停", async () => {
    const { ctx, session, store, tracker } = makeHarness({
      goal: activeGoal(),
      context: [{ ...ASSISTANT_MSG, content: [{ type: "text", text: "继续推进，已修复 X。" }] }],
    })
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    expect(session.synthetic).toHaveBeenCalledTimes(1)
  })

  it("resume 后首次 tick 豁免 blocked 检测（避免 resume 立即被旧报告再次暂停）", async () => {
    const { ctx, session, store, tracker } = makeHarness({
      goal: activeGoal({ statusReason: "resumed" }),
      context: [{ ...ASSISTANT_MSG, content: [{ type: "text", text: "[BLOCKED: missing API key] 无法继续" }] }],
    })
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    // 豁免：继续续接，且 statusReason 被消费清除
    expect(session.synthetic).toHaveBeenCalledTimes(1)
    const update = session.update.mock.calls[0][0] as unknown as { metadata: { goal: { status: string; statusReason: string } } }
    expect(update.metadata.goal.status).toBe("active")
    expect(update.metadata.goal.statusReason).toBe("")
  })

  it("首 tick 正常推进也消费豁免，后续真实 blocked 不再被误豁免", async () => {
    const { ctx, session, store, tracker } = makeHarness({
      goal: activeGoal({ statusReason: "resumed" }),
      context: [{ ...ASSISTANT_MSG, content: [{ type: "text", text: "正常推进。" }] }],
    })
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    expect(session.synthetic).toHaveBeenCalledTimes(1)
    const firstUpdate = session.update.mock.calls[0][0] as unknown as { metadata: { goal: { statusReason: string } } }
    expect(firstUpdate.metadata.goal.statusReason).toBe("")
    // 后续 tick：真实 blocked 报告 → 不再豁免，暂停
    ;(session.context as ReturnType<typeof vi.fn>).mockResolvedValue([{
      ...ASSISTANT_MSG,
      content: [{ type: "text", text: "[BLOCKED: still missing]" }],
    }])
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    expect(session.synthetic).toHaveBeenCalledTimes(1) // 未再发送
    const lastUpdate = session.update.mock.calls.at(-1)![0] as unknown as { metadata: { goal: { status: string } } }
    expect(lastUpdate.metadata.goal.status).toBe("paused")
  })
})

describe("queueContinuation — [DONE:] 完成报告", () => {
  it("agent 报告完成时暂停 goal 且不续接（等待 goal-verify 验证）", async () => {
    const { ctx, session, store, tracker } = makeHarness({
      goal: activeGoal(),
      context: [{ ...ASSISTANT_MSG, content: [{ type: "text", text: "全部验收项通过。\n[DONE: tests pass, build green]" }] }],
    })
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    expect(session.synthetic).not.toHaveBeenCalled()
    const update = session.update.mock.calls[0][0] as unknown as { metadata: { goal: { status: string; statusReason: string } } }
    expect(update.metadata.goal.status).toBe("paused")
    expect(update.metadata.goal.statusReason).toBe("done report")
  })

  it("普通推进回复不触发完成暂停", async () => {
    const { ctx, session, store, tracker } = makeHarness({
      goal: activeGoal(),
      context: [{ ...ASSISTANT_MSG, content: [{ type: "text", text: "还剩最后一步。" }] }],
    })
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    expect(session.synthetic).toHaveBeenCalledTimes(1)
  })
})

describe("queueContinuation — 中断兜底", () => {
  it("被标记中断的会话暂停 goal 且不续接", async () => {
    const { ctx, session, store, tracker } = makeHarness({ goal: activeGoal() })
    markAborted("sess-main")
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    expect(session.synthetic).not.toHaveBeenCalled()
    const update = session.update.mock.calls[0][0] as unknown as { metadata: { goal: { status: string; statusReason: string } } }
    expect(update.metadata.goal.status).toBe("paused")
    expect(update.metadata.goal.statusReason).toBe("aborted by user")
  })
})

describe("queueContinuation — token 记账与预算护栏（会话累计快照）", () => {
  const SESSION_TOKENS = { input: 500, output: 100, reasoning: 0, cache: { read: 900, write: 0 } } // 快照 1500

  it("用量 = 会话累计 − 基线，达预算前正常续接", async () => {
    const { ctx, session, store, tracker } = makeHarness({
      goal: activeGoal({ tokensBaseline: 35, tokenBudget: 2000 }),
      tokens: SESSION_TOKENS,
    })
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    expect(session.synthetic).toHaveBeenCalledTimes(1)
    const update = session.update.mock.calls[0][0] as unknown as { metadata: { goal: { tokensBaseline: number; tokensUsed: number } } }
    expect(update.metadata.goal.tokensBaseline).toBe(35)
    expect(update.metadata.goal.tokensUsed).toBe(1500 - 35)
  })

  it("tokensUsed 达预算时暂停且不续接", async () => {
    const { ctx, session, store, tracker } = makeHarness({
      goal: activeGoal({ tokensBaseline: 0, tokenBudget: 1000 }),
      tokens: SESSION_TOKENS,
    })
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    expect(session.synthetic).not.toHaveBeenCalled()
    const update = session.update.mock.calls[0][0] as unknown as { metadata: { goal: { status: string } } }
    expect(update.metadata.goal.status).toBe("paused")
  })

  it("tokensUsed 单调不减（会话重建/压缩后不回退）", async () => {
    const { ctx, session, store, tracker } = makeHarness({
      goal: activeGoal({ tokensBaseline: 0, tokenBudget: 99999, tokensUsed: 5000 }),
      tokens: SESSION_TOKENS,
    })
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    const update = session.update.mock.calls[0][0] as unknown as { metadata: { goal: { tokensUsed: number } } }
    expect(update.metadata.goal.tokensUsed).toBe(5000)
  })

  it("edit 换 Flow 后基线为 edit 时点快照，旧消耗不计入新预算", async () => {
    const { ctx, session, store, tracker } = makeHarness({
      // edit 换 Flow 后：baseline = edit 时点会话快照 1500，tokensUsed 已清零
      goal: activeGoal({ tokensBaseline: 1500, tokensUsed: 0 }),
      tokens: SESSION_TOKENS,
    })
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    const update = session.update.mock.calls[0][0] as unknown as { metadata: { goal: { tokensBaseline: number; tokensUsed: number } } }
    expect(update.metadata.goal.tokensBaseline).toBe(1500)
    expect(update.metadata.goal.tokensUsed).toBe(0)
  })
})

describe("queueContinuation — 先写后发与失败回滚", () => {
  it("计数先于 synthetic 落盘（防崩溃窗口双发）", async () => {
    const { ctx, session, store, tracker } = makeHarness({
      goal: activeGoal({ continuationCount: 3 }),
    })
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    const updateOrder = session.update.mock.invocationCallOrder[0]
    const syntheticOrder = session.synthetic.mock.invocationCallOrder[0]
    expect(updateOrder).toBeLessThan(syntheticOrder)
    const update = session.update.mock.calls[0][0] as unknown as { metadata: { goal: { continuationCount: number } } }
    expect(update.metadata.goal.continuationCount).toBe(4)
  })

  it("synthetic 发送失败时回滚计数，goal 保持 active", async () => {
    const { ctx, session, store, tracker } = makeHarness({
      goal: activeGoal({ continuationCount: 3 }),
      syntheticError: new Error("boom"),
    })
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    const lastUpdate = session.update.mock.calls.at(-1)![0] as unknown as { metadata: { goal: { continuationCount: number; status: string } } }
    expect(lastUpdate.metadata.goal.continuationCount).toBe(3)
    expect(lastUpdate.metadata.goal.status).toBe("active")
  })

  it("消息投影读取失败时跳过续接（fail-closed）", async () => {
    const { ctx, session, store, tracker } = makeHarness({ goal: activeGoal() })
    ;(session.context as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"))
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    expect(session.synthetic).not.toHaveBeenCalled()
  })

  it("continuationCount 达 compaction 阈值时先 compact 再续接", async () => {
    const { ctx, session, store, tracker } = makeHarness({ goal: activeGoal({ continuationCount: 19 }) })
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    expect(session.compact).toHaveBeenCalledTimes(1)
    expect(session.synthetic).toHaveBeenCalledTimes(1)
    const compactOrder = session.compact.mock.invocationCallOrder[0]
    const syntheticOrder = session.synthetic.mock.invocationCallOrder[0]
    expect(compactOrder).toBeLessThan(syntheticOrder)
    const syntheticCall = session.synthetic.mock.calls[0][0] as unknown as { text: string }
    expect(syntheticCall.text).toContain("#42")
  })

  it("profile 快照在续接前恢复（switchAgent/switchModel）", async () => {
    const { ctx, session, store, tracker } = makeHarness({
      goal: activeGoal({
        sessionProfile: { agent: "dev-lifecycle", model: { providerID: "provider", modelID: "model" } },
      }),
    })
    await queueContinuation(ctx, store, "sess-main", PROJECT_DIR, tracker)
    expect(session.switchAgent).toHaveBeenCalledWith({ sessionID: "sess-main", agent: "dev-lifecycle" })
    expect(session.switchModel).toHaveBeenCalledWith({ sessionID: "sess-main", model: { providerID: "provider", id: "model" } })
  })
})

describe("queueContinuation — 索引只记录最近续接时刻", () => {
  let tmpDir: string

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
  })

  it("发送前写入 lastContinuedAt，不镜像状态/计数字段", async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cabbage-continuation-index-"))
    const { ctx, session, store, tracker } = makeHarness({ goal: activeGoal() })
    await writeIndex(tmpDir, { flows: { "42": { sessionID: "sess-main" } } })
    const before = Date.now()
    await queueContinuation(ctx, store, "sess-main", tmpDir, tracker)
    expect(session.synthetic).toHaveBeenCalledTimes(1)
    const index = JSON.parse(await readFile(
      path.join(tmpDir, ".opencode", "opencode-cabbage", "session-index.json"), "utf8",
    )) as { flows: Record<string, Record<string, unknown>> }
    const flow = index.flows["42"]!
    expect(flow.sessionID).toBe("sess-main")
    expect(flow.lastContinuedAt).toBeGreaterThanOrEqual(before)
    // entry 无其它字段（status/continuationCount/updatedAt 已删除）
    expect(Object.keys(flow).sort()).toEqual(["lastContinuedAt", "sessionID"])
  })
})

describe("autoResume — goal 为唯一状态权威，lastContinuedAt 重启双发防护", () => {
  let tmpDir: string

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
  })

  const makeIndexDir = async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cabbage-autoresume-"))
    return tmpDir
  }

  it("最近实际续接过（30s 内 lastContinuedAt）的 flow 跳过恢复", async () => {
    const dir = await makeIndexDir()
    const { ctx, session, store } = makeHarness({ goal: activeGoal({ continuationCount: 5 }) })
    await writeIndex(dir, {
      flows: { "42": { sessionID: "sess-main", lastContinuedAt: Date.now() - 1000 } },
    })
    await autoResume(ctx, store, dir)
    expect(session.synthetic).not.toHaveBeenCalled()
  })

  it("Goal active 且 entry 无 lastContinuedAt（resume 后、下一次续接前重启）→ 正常续接", async () => {
    const dir = await makeIndexDir()
    const { ctx, session, store } = makeHarness({ goal: activeGoal({ statusReason: "resumed" }) })
    await writeIndex(dir, { flows: { "42": { sessionID: "sess-main" } } })
    await autoResume(ctx, store, dir)
    expect(session.synthetic).toHaveBeenCalledTimes(1)
  })

  it("超过 30s 未续接的 active flow 正常恢复", async () => {
    const dir = await makeIndexDir()
    const { ctx, session, store } = makeHarness({ goal: activeGoal({ continuationCount: 5 }) })
    await writeIndex(dir, {
      flows: { "42": { sessionID: "sess-main", lastContinuedAt: Date.now() - 60_000 } },
    })
    await autoResume(ctx, store, dir)
    expect(session.synthetic).toHaveBeenCalledTimes(1)
  })

  it("旧格式 entry（含 status/continuationCount/updatedAt）多余字段被忽略 → 正常恢复", async () => {
    const dir = await makeIndexDir()
    const { ctx, session, store } = makeHarness({ goal: activeGoal({ continuationCount: 5 }) })
    await writeIndex(dir, {
      flows: { "42": { sessionID: "sess-main", status: "active", continuationCount: 5, updatedAt: Date.now() - 60_000 } as never },
    })
    await autoResume(ctx, store, dir)
    expect(session.synthetic).toHaveBeenCalledTimes(1)
  })

  it("goal 已不 active 的 flow 跳过恢复，且不回写索引", async () => {
    const dir = await makeIndexDir()
    const { ctx, session, store } = makeHarness({
      goal: { parentIssueNumber: 42, status: "paused", continuationCount: 5 },
    })
    await writeIndex(dir, { flows: { "42": { sessionID: "sess-main" } } })
    await autoResume(ctx, store, dir)
    expect(session.synthetic).not.toHaveBeenCalled()
    const index = JSON.parse(await readFile(
      path.join(dir, ".opencode", "opencode-cabbage", "session-index.json"), "utf8",
    )) as { flows: Record<string, { sessionID?: string; status?: string }> }
    // 索引不再镜像 goal 状态：entry 保持绑定原样
    expect(index.flows["42"]).toEqual({ sessionID: "sess-main" })
  })

  it("索引指向的 goal 已是别的 Flow（edit 残留）时清理陈旧 entry 不续接", async () => {
    const dir = await makeIndexDir()
    const { ctx, session, store } = makeHarness({ goal: activeGoal({ parentIssueNumber: 99 }) })
    await writeIndex(dir, {
      flows: {
        "42": { sessionID: "sess-main" },
        "99": { sessionID: "sess-main" },
      },
    })
    await autoResume(ctx, store, dir)
    expect(session.synthetic).toHaveBeenCalledTimes(1) // 仅 #99 恢复，#42 被自愈清理
    const index = JSON.parse(await readFile(
      path.join(dir, ".opencode", "opencode-cabbage", "session-index.json"), "utf8",
    )) as { flows: Record<string, unknown> }
    expect(index.flows["42"]).toBeUndefined()
    expect(index.flows["99"]).toBeDefined()
  })
})

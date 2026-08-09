import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { queueContinuation, autoResume } from "../../src/plugin/server.js"
import { writeIndex } from "../../src/kernel/session-index.js"

/**
 * queueContinuation 的 client mock：
 * - session.get/update：供 goal.js 的 mutateGoal 读改写
 * - session.messages：续接前消息拉取（尾部检查 + blocked 检测 + token 记账）
 * - session.children / session.status：子会话活动闸
 * - session.promptAsync：续接发送
 * projectDir 传 undefined，避免依赖 context/index 文件系统。
 */

const ASSISTANT_INFO = {
  id: "msg-1",
  role: "assistant",
  time: { completed: 2 },
  providerID: "provider",
  modelID: "model",
  agent: "dev-lifecycle",
  tokens: { input: 100, output: 50, cache: { read: 200 } },
}

interface ClientOptions {
  goal?: Record<string, unknown> | null
  messages?: Array<{ info: Record<string, unknown>; parts?: Array<{ type: string; text?: string }> }>
  children?: Array<{ id: string }>
  statuses?: Record<string, { type: string }>
  promptError?: Error
}

function makeClient(options: ClientOptions = {}) {
  const sessions = new Map<string, { parentID?: string; metadata: Record<string, unknown> }>()
  const goalMeta = options.goal === undefined
    ? { parentIssueNumber: 42, status: "active" as const, continuationCount: 0 }
    : options.goal
  sessions.set("sess-main", {
    parentID: undefined,
    metadata: goalMeta ? { goal: goalMeta } : {},
  })
  const client = {
    session: {
      get: vi.fn(async () => {
        const s = sessions.get("sess-main")!
        return { data: { parentID: s.parentID ?? null, metadata: s.metadata } }
      }),
      update: vi.fn(async ({ sessionID, metadata }: { sessionID: string; metadata: Record<string, unknown> }) => {
        sessions.set(sessionID, { metadata })
        return { data: { sessionID, metadata } }
      }),
      messages: vi.fn(async () => ({ data: options.messages ?? [] })),
      children: vi.fn(async () => ({ data: options.children ?? [] })),
      status: vi.fn(async () => ({ data: options.statuses ?? {} })),
      promptAsync: options.promptError
        ? vi.fn(async () => { throw options.promptError })
        : vi.fn(async () => ({ data: {} })),
    },
  }
  return { client, sessions }
}

const activeGoal = (overrides: Record<string, unknown> = {}) => ({
  parentIssueNumber: 42,
  status: "active" as const,
  continuationCount: 0,
  sessionProfile: { agent: "dev-lifecycle", model: { providerID: "provider", modelID: "model" } },
  ...overrides,
})

describe("queueContinuation — 子会话活动闸", () => {
  it("直接子会话 busy 时跳过续接", async () => {
    const { client } = makeClient({
      goal: activeGoal(),
      messages: [{ info: ASSISTANT_INFO, parts: [{ type: "text", text: "工作完成。" }] }],
      children: [{ id: "child-1" }],
      statuses: { "child-1": { type: "busy" } },
    })
    await queueContinuation(client as never, "sess-main")
    expect(client.session.promptAsync).not.toHaveBeenCalled()
  })

  it("直接子会话 retry 时跳过续接", async () => {
    const { client } = makeClient({
      goal: activeGoal(),
      messages: [{ info: ASSISTANT_INFO, parts: [{ type: "text", text: "工作完成。" }] }],
      children: [{ id: "child-1" }],
      statuses: { "child-1": { type: "retry" } },
    })
    await queueContinuation(client as never, "sess-main")
    expect(client.session.promptAsync).not.toHaveBeenCalled()
  })

  it("无子会话或子会话空闲时正常续接", async () => {
    const { client } = makeClient({
      goal: activeGoal(),
      messages: [{ info: ASSISTANT_INFO, parts: [{ type: "text", text: "工作完成。" }] }],
    })
    await queueContinuation(client as never, "sess-main")
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
  })

  it("children/status 查询失败时保守跳过（不续接）", async () => {
    const { client } = makeClient({
      goal: activeGoal(),
      messages: [{ info: ASSISTANT_INFO, parts: [{ type: "text", text: "工作完成。" }] }],
      children: [{ id: "child-1" }],
    })
    ;(client.session.status as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"))
    await queueContinuation(client as never, "sess-main")
    expect(client.session.promptAsync).not.toHaveBeenCalled()
  })

  it("children 查询失败同样保守跳过（fail-closed 一致）", async () => {
    const { client } = makeClient({
      goal: activeGoal(),
      messages: [{ info: ASSISTANT_INFO, parts: [{ type: "text", text: "工作完成。" }] }],
    })
    ;(client.session.children as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"))
    await queueContinuation(client as never, "sess-main")
    expect(client.session.promptAsync).not.toHaveBeenCalled()
  })
})

describe("queueContinuation — 尾部静默检查", () => {
  it("最后一条是 user 消息时跳过续接", async () => {
    const { client } = makeClient({
      goal: activeGoal(),
      messages: [{ info: { id: "msg-user", role: "user" } }],
    })
    await queueContinuation(client as never, "sess-main")
    expect(client.session.promptAsync).not.toHaveBeenCalled()
  })

  it("最后 assistant 未完成（无 completed 时间）时跳过续接", async () => {
    const { client } = makeClient({
      goal: activeGoal(),
      messages: [{ info: { id: "msg-inflight", role: "assistant", time: {} } }],
    })
    await queueContinuation(client as never, "sess-main")
    expect(client.session.promptAsync).not.toHaveBeenCalled()
  })

  it("无任何 assistant 消息时跳过续接（无 provider/model 可续）", async () => {
    const { client } = makeClient({ goal: activeGoal(), messages: [] })
    await queueContinuation(client as never, "sess-main")
    expect(client.session.promptAsync).not.toHaveBeenCalled()
  })
})

describe("queueContinuation — [BLOCKED:] 阻塞报告", () => {
  it("agent 报告阻塞时暂停 goal 且不续接", async () => {
    const { client } = makeClient({
      goal: activeGoal(),
      messages: [{
        info: ASSISTANT_INFO,
        parts: [{ type: "text", text: "[BLOCKED: missing API key] 无法继续" }],
      }],
    })
    await queueContinuation(client as never, "sess-main")
    expect(client.session.promptAsync).not.toHaveBeenCalled()
    const update = client.session.update.mock.calls[0][0] as unknown as { metadata: { goal: { status: string } } }
    expect(update.metadata.goal.status).toBe("paused")
  })

  it("普通回复不触发阻塞暂停", async () => {
    const { client } = makeClient({
      goal: activeGoal(),
      messages: [{ info: ASSISTANT_INFO, parts: [{ type: "text", text: "继续推进，已修复 X。" }] }],
    })
    await queueContinuation(client as never, "sess-main")
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
  })

  it("resume 后首次 tick 豁免 blocked 检测（避免 resume 立即被旧报告再次暂停）", async () => {
    const { client } = makeClient({
      goal: activeGoal({ statusReason: "resumed" }),
      messages: [{
        info: ASSISTANT_INFO,
        parts: [{ type: "text", text: "[BLOCKED: missing API key] 无法继续" }],
      }],
    })
    await queueContinuation(client as never, "sess-main")
    // 豁免：继续续接，且 statusReason 被消费清除
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
    const update = client.session.update.mock.calls[0][0] as unknown as { metadata: { goal: { status: string; statusReason: string } } }
    expect(update.metadata.goal.status).toBe("active")
    expect(update.metadata.goal.statusReason).toBe("")
  })

  it("首 tick 正常推进也消费豁免，后续真实 blocked 不再被误豁免", async () => {
    const { client } = makeClient({
      goal: activeGoal({ statusReason: "resumed" }),
      messages: [{ info: ASSISTANT_INFO, parts: [{ type: "text", text: "正常推进。" }] }],
    })
    await queueContinuation(client as never, "sess-main")
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
    const firstUpdate = client.session.update.mock.calls[0][0] as unknown as { metadata: { goal: { statusReason: string } } }
    expect(firstUpdate.metadata.goal.statusReason).toBe("")
    // 后续 tick：真实 blocked 报告 → 不再豁免，暂停
    ;(client.session.messages as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [{
      info: ASSISTANT_INFO,
      parts: [{ type: "text", text: "[BLOCKED: still missing]" }],
    }] })
    await queueContinuation(client as never, "sess-main")
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1) // 未再发送
    const lastUpdate = client.session.update.mock.calls.at(-1)![0] as unknown as { metadata: { goal: { status: string } } }
    expect(lastUpdate.metadata.goal.status).toBe("paused")
  })
})

describe("queueContinuation — [DONE:] 完成报告", () => {
  it("agent 报告完成时暂停 goal 且不续接（等待 goal-verify 验证）", async () => {
    const { client } = makeClient({
      goal: activeGoal(),
      messages: [{
        info: ASSISTANT_INFO,
        parts: [{ type: "text", text: "全部验收项通过。\n[DONE: tests pass, build green]" }],
      }],
    })
    await queueContinuation(client as never, "sess-main")
    expect(client.session.promptAsync).not.toHaveBeenCalled()
    const update = client.session.update.mock.calls[0][0] as unknown as { metadata: { goal: { status: string; statusReason: string } } }
    expect(update.metadata.goal.status).toBe("paused")
    expect(update.metadata.goal.statusReason).toBe("done report")
  })

  it("普通推进回复不触发完成暂停", async () => {
    const { client } = makeClient({
      goal: activeGoal(),
      messages: [{ info: ASSISTANT_INFO, parts: [{ type: "text", text: "还剩最后一步。" }] }],
    })
    await queueContinuation(client as never, "sess-main")
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
  })
})

describe("autoResume — 重启双发防护", () => {
  let tmpDir: string

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true })
  })

  const makeIndexDir = async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cabbage-autoresume-"))
    return tmpDir
  }

  it("30s 内刚更新过的 flow 跳过恢复（可能刚续接过，重启会双发）", async () => {
    const dir = await makeIndexDir()
    const { client } = makeClient({
      goal: activeGoal({ continuationCount: 5 }),
      messages: [{ info: ASSISTANT_INFO, parts: [{ type: "text", text: "完成。" }] }],
    })
    await writeIndex(dir, {
      flows: { "42": { sessionID: "sess-main", status: "active", continuationCount: 5, updatedAt: Date.now() - 1000 } },
    })
    await autoResume(client as never, dir)
    expect(client.session.promptAsync).not.toHaveBeenCalled()
  })

  it("超过 30s 未更新的 active flow 正常恢复", async () => {
    const dir = await makeIndexDir()
    const { client } = makeClient({
      goal: activeGoal({ continuationCount: 5 }),
      messages: [{ info: ASSISTANT_INFO, parts: [{ type: "text", text: "完成。" }] }],
    })
    await writeIndex(dir, {
      flows: { "42": { sessionID: "sess-main", status: "active", continuationCount: 5, updatedAt: Date.now() - 60_000 } },
    })
    await autoResume(client as never, dir)
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
  })

  it("索引中 active 但会话 goal 已不 active 的 flow 置 paused 不恢复", async () => {
    const dir = await makeIndexDir()
    const { client } = makeClient({ goal: null })
    await writeIndex(dir, {
      flows: { "42": { sessionID: "sess-main", status: "active", continuationCount: 5, updatedAt: Date.now() - 60_000 } },
    })
    await autoResume(client as never, dir)
    expect(client.session.promptAsync).not.toHaveBeenCalled()
    const index = JSON.parse(await readFile(
      path.join(dir, ".opencode", "opencode-cabbage", "session-index.json"), "utf8",
    )) as { flows: Record<string, { status: string }> }
    expect(index.flows["42"]?.status).toBe("paused")
  })
})

describe("queueContinuation — token 记账与预算护栏", () => {
  const makeMessages = () => [
    // 创建前完成的轮次（baseline 候选）：10+20+5=35
    { info: { id: "msg-pre", role: "assistant", time: { completed: 500 }, tokens: { input: 10, output: 5, cache: { read: 20 } } } },
    // 最新完成轮：500+100+900=1500
    { info: { id: "msg-latest", role: "assistant", time: { completed: 2000 }, providerID: "provider", modelID: "model", agent: "dev-lifecycle", tokens: { input: 500, output: 100, cache: { read: 900 } } }, parts: [{ type: "text", text: "完成。" }] },
  ]

  it("首次 tick 初始化 baseline 并记账（排除创建前历史）", async () => {
    const { client } = makeClient({
      goal: activeGoal({ createdAt: 1000, tokenBudget: 2000 }),
      messages: makeMessages(),
    })
    await queueContinuation(client as never, "sess-main")
    expect(client.session.promptAsync).toHaveBeenCalledTimes(1)
    const update = client.session.update.mock.calls[0][0] as unknown as { metadata: { goal: { tokensBaseline: number; tokensUsed: number } } }
    expect(update.metadata.goal.tokensBaseline).toBe(35)
    expect(update.metadata.goal.tokensUsed).toBe(1500 - 35)
  })

  it("tokensUsed 达预算时暂停且不续接", async () => {
    const { client } = makeClient({
      goal: activeGoal({ createdAt: 1000, tokenBudget: 1000 }),
      messages: makeMessages(),
    })
    await queueContinuation(client as never, "sess-main")
    expect(client.session.promptAsync).not.toHaveBeenCalled()
    const update = client.session.update.mock.calls[0][0] as unknown as { metadata: { goal: { status: string } } }
    expect(update.metadata.goal.status).toBe("paused")
  })

  it("tokensUsed 单调不减（context 收缩不回退）", async () => {
    const { client } = makeClient({
      goal: activeGoal({ createdAt: 1000, tokenBudget: 99999, tokensUsed: 5000 }),
      messages: makeMessages(),
    })
    await queueContinuation(client as never, "sess-main")
    const update = client.session.update.mock.calls[0][0] as unknown as { metadata: { goal: { tokensUsed: number } } }
    expect(update.metadata.goal.tokensUsed).toBe(5000)
  })
})

describe("queueContinuation — 先写后发与失败回滚", () => {
  const messages = [{ info: ASSISTANT_INFO, parts: [{ type: "text", text: "完成。" }] }]

  it("计数先于 prompt 落盘（防崩溃窗口双发）", async () => {
    const { client } = makeClient({
      goal: activeGoal({ continuationCount: 3 }),
      messages,
    })
    await queueContinuation(client as never, "sess-main")
    const updateOrder = client.session.update.mock.invocationCallOrder[0]
    const promptOrder = client.session.promptAsync.mock.invocationCallOrder[0]
    expect(updateOrder).toBeLessThan(promptOrder)
    const update = client.session.update.mock.calls[0][0] as unknown as { metadata: { goal: { continuationCount: number } } }
    expect(update.metadata.goal.continuationCount).toBe(4)
  })

  it("prompt 发送失败时回滚计数，goal 保持 active", async () => {
    const { client } = makeClient({
      goal: activeGoal({ continuationCount: 3 }),
      messages,
      promptError: new Error("boom"),
    })
    await queueContinuation(client as never, "sess-main")
    const lastUpdate = client.session.update.mock.calls.at(-1)![0] as unknown as { metadata: { goal: { continuationCount: number; status: string } } }
    expect(lastUpdate.metadata.goal.continuationCount).toBe(3)
    expect(lastUpdate.metadata.goal.status).toBe("active")
  })

  it("消息拉取失败时跳过续接（fail-closed）", async () => {
    const { client } = makeClient({ goal: activeGoal(), messages })
    ;(client.session.messages as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"))
    await queueContinuation(client as never, "sess-main")
    expect(client.session.promptAsync).not.toHaveBeenCalled()
  })

  it("continuationCount 达 compaction 阈值时先发 compact 再发续接", async () => {
    const { client } = makeClient({
      goal: activeGoal({ continuationCount: 19 }),
      messages,
    })
    await queueContinuation(client as never, "sess-main")
    expect(client.session.promptAsync).toHaveBeenCalledTimes(2)
    const promptCalls = client.session.promptAsync.mock.calls as unknown as Array<[{ parts: Array<{ text: string }> }]>
    expect(promptCalls[0]![0].parts[0]!.text).toContain("[compact]")
    expect(promptCalls[1]![0].parts[0]!.text).toContain("#42")
  })
})

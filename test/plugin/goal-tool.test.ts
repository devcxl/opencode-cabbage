import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createGoalTool, mutateGoal, isBlockedReport, isDoneReport, snapshotTokenTotal, budgetReached } from "../../src/plugin/goal.js"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { sessionIndexPath } from "../../src/kernel/session-index.js"

/** 内存 session 存储：模拟 OpenCode SDK 的 session.get/update */
function makeClient(initial: Record<string, unknown> = {}) {
  const sessions = new Map<string, { parentID?: string; metadata: Record<string, unknown> }>()
  for (const [sid, val] of Object.entries(initial)) {
    const v = val as { parentID?: string; metadata?: Record<string, unknown>; goal?: Record<string, unknown> }
    sessions.set(sid, {
      parentID: v.parentID,
      metadata: v.metadata ?? (v.goal ? { goal: v.goal } : {}),
    })
  }
  const client = {
    session: {
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => {
        const s = sessions.get(sessionID) ?? { metadata: {} }
        return { data: { parentID: s.parentID ?? null, metadata: s.metadata } }
      }),
      update: vi.fn(async ({ sessionID, metadata }: { sessionID: string; metadata: Record<string, unknown> }) => {
        const existing = sessions.get(sessionID) ?? { metadata: {} }
        sessions.set(sessionID, { parentID: existing.parentID, metadata })
        return { data: { sessionID, metadata } }
      }),
      promptAsync: vi.fn(),
      // create 初始化 tokensBaseline 时会拉历史消息
      messages: vi.fn(async () => ({ data: [] })),
    },
  }
  return { client, sessions }
}

function makeCtx(overrides: Record<string, unknown> = {}) {
  return {
    sessionID: "sess-main",
    directory: "/tmp/project",
    agent: "dev-lifecycle",
    ...overrides,
  } as never
}

const activeGoalMeta = (issue = 42) => ({
  goal: { parentIssueNumber: issue, status: "active" as const, continuationCount: 0 },
})

let tmpDirs: string[] = []

async function makeProjectDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "goal-tool-test-"))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tmpDirs.map(dir => rm(dir, { recursive: true, force: true })))
  tmpDirs = []
})

describe("goal 工具 — create", () => {
  it("创建 goal 并写入 session metadata", async () => {
    const { client } = makeClient()
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute({ op: "create", parent_issue_number: 42 }, makeCtx())
    expect(String(out)).toContain("Goal created")
    expect(String(out)).toContain("Flow #42")
    expect(client.session.update).toHaveBeenCalledTimes(1)
  })

  it("create 时设置 tokenBudget 与 createdAt", async () => {
    const { client } = makeClient()
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute({ op: "create", parent_issue_number: 42, token_budget: 100000 }, makeCtx())
    expect(String(out)).toContain("Goal created")
    const updated = client.session.update.mock.calls[0][0] as unknown as { metadata: { goal: Record<string, unknown> } }
    expect(updated.metadata.goal.tokenBudget).toBe(100000)
    expect(typeof updated.metadata.goal.createdAt).toBe("number")
  })

  it("create 时从历史消息计算 tokensBaseline（排除创建后的轮次）", async () => {
    const { client } = makeClient()
    // 创建时刻 Date.now() 介于 1e9（旧轮）与 9.99e12（未来轮）之间
    ;(client.session.messages as ReturnType<typeof vi.fn>).mockResolvedValue({ data: [
      { info: { role: "assistant", time: { completed: 1_000_000_000 }, tokens: { input: 10, output: 5, cache: { read: 20 } } } },
      { info: { role: "user", time: {}, tokens: { input: 1, output: 1, cache: { read: 0 } } } },
      { info: { role: "assistant", time: { completed: 9_999_999_999_999 }, tokens: { input: 100, output: 50, cache: { read: 200 } } } },
    ] })
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    await tool.execute({ op: "create", parent_issue_number: 42 }, makeCtx())
    const updated = client.session.update.mock.calls[0][0] as unknown as { metadata: { goal: Record<string, unknown> } }
    // 仅创建前完成的 assistant 轮计入：10 + 20 + 5 = 35（未来轮 350 不计）
    expect(updated.metadata.goal.tokensBaseline).toBe(35)
  })

  it("消息拉取失败时 baseline 为 0，goal 仍创建", async () => {
    const { client } = makeClient()
    ;(client.session.messages as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("boom"))
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute({ op: "create", parent_issue_number: 42 }, makeCtx())
    expect(String(out)).toContain("Goal created")
    const updated = client.session.update.mock.calls[0][0] as unknown as { metadata: { goal: Record<string, unknown> } }
    expect(updated.metadata.goal.tokensBaseline).toBe(0)
  })

  it("缺少 parent_issue_number 时拒绝", async () => {
    const { client } = makeClient()
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute({ op: "create" }, makeCtx())
    expect(String(out)).toContain("parent_issue_number is required")
    expect(client.session.update).not.toHaveBeenCalled()
  })

  it("parent_issue_number 非正整数时拒绝（负数/小数/非数字）", async () => {
    const { client } = makeClient()
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    for (const bad of [-5, 1.5, "abc", 0]) {
      const out = await tool.execute({ op: "create", parent_issue_number: bad }, makeCtx())
      expect(String(out)).toContain("parent_issue_number")
      expect(client.session.update).not.toHaveBeenCalled()
    }
  })

  it("已存在 active goal 时拒绝重复创建", async () => {
    const { client, sessions } = makeClient({ "sess-main": activeGoalMeta() })
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute({ op: "create", parent_issue_number: 99 }, makeCtx())
    expect(String(out)).toContain("active goal already exists")
    // 现有 goal 必须保留：错误分支返回 null 会触发 mutateGoal 删除现有 goal
    const goal = sessions.get("sess-main")!.metadata.goal as { parentIssueNumber: number; status: string }
    expect(goal.parentIssueNumber).toBe(42)
    expect(goal.status).toBe("active")
  })

  it("子 agent 不能 create", async () => {
    const { client } = makeClient({ "sess-child": { parentID: "sess-parent" } })
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute({ op: "create", parent_issue_number: 42 }, makeCtx({ sessionID: "sess-child" }))
    expect(String(out)).toContain("sub-agents cannot call goal")
  })
})

describe("goal 工具 — get", () => {
  it("返回 active goal 状态", async () => {
    const { client } = makeClient({ "sess-main": activeGoalMeta() })
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute({ op: "get" }, makeCtx())
    expect(String(out)).toContain("Flow: #42")
    expect(String(out)).toContain("Status: active")
  })

  it("无 goal 时返回 No active goal", async () => {
    const { client } = makeClient()
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute({ op: "get" }, makeCtx())
    expect(String(out)).toContain("No active goal")
  })
})

describe("goal 工具 — pause / resume / cancel", () => {
  it("pause：active → paused", async () => {
    const { client } = makeClient({ "sess-main": activeGoalMeta() })
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute({ op: "pause" }, makeCtx())
    expect(String(out)).toContain("paused")
  })

  it("resume：paused → active 并重置 continuationCount", async () => {
    const { client } = makeClient({
      "sess-main": { goal: { parentIssueNumber: 42, status: "paused", continuationCount: 7 } },
    })
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute({ op: "resume" }, makeCtx())
    expect(String(out)).toContain("resumed")
    const updated = client.session.update.mock.calls[0][0] as unknown as { metadata: { goal: { status: string; continuationCount: number } } }
    expect(updated.metadata.goal.status).toBe("active")
    expect(updated.metadata.goal.continuationCount).toBe(0)
  })

  it("cancel：移除 goal", async () => {
    const { client } = makeClient({ "sess-main": activeGoalMeta() })
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute({ op: "cancel" }, makeCtx())
    expect(String(out)).toContain("Goal cancelled")
    const updated = client.session.update.mock.calls[0][0] as { metadata: Record<string, unknown> }
    expect(updated.metadata.goal).toBeUndefined()
  })

  it("子 agent 不能 pause/resume/cancel", async () => {
    const { client } = makeClient({ "sess-child": { parentID: "sess-parent" } })
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    for (const op of ["pause", "resume", "cancel"] as const) {
      const out = await tool.execute({ op }, makeCtx({ sessionID: "sess-child" }))
      expect(String(out)).toContain("sub-agents cannot call goal")
    }
  })
})

describe("goal 工具 — complete 授权", () => {
  it("goal-verify 可 complete（父会话 active）", async () => {
    const { client } = makeClient({
      "sess-parent": activeGoalMeta(),
      "sess-verify": { parentID: "sess-parent" },
    })
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute(
      { op: "complete" },
      makeCtx({
        sessionID: "sess-verify",
        agent: "goal-verify",
        directory: await makeProjectDir(),
      }),
    )
    expect(String(out)).toContain("Goal completed")
    // 父会话 goal 被置为 complete
    const updated = client.session.update.mock.calls[0][0] as unknown as { sessionID: string; metadata: { goal: { status: string } } }
    expect(updated.sessionID).toBe("sess-parent")
    expect(updated.metadata.goal.status).toBe("complete")
  })

  it("非 goal-verify agent 不能 complete", async () => {
    const { client } = makeClient({ "sess-parent": activeGoalMeta(), "sess-child": { parentID: "sess-parent" } })
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute({ op: "complete" }, makeCtx({ sessionID: "sess-child", agent: "reviewer" }))
    expect(String(out)).toContain("only the goal-verify agent")
  })

  it("primary（非子 agent）不能直接 complete", async () => {
    const { client } = makeClient({ "sess-main": activeGoalMeta() })
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute({ op: "complete" }, makeCtx())
    expect(String(out)).toContain("BLOCKED")
    expect(client.session.update).not.toHaveBeenCalled()
  })

  it("父会话 goal 非 active 时拒绝 complete", async () => {
    const { client } = makeClient({
      "sess-parent": { goal: { parentIssueNumber: 42, status: "paused", continuationCount: 0 } },
      "sess-verify": { parentID: "sess-parent" },
    })
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute(
      { op: "complete" },
      makeCtx({ sessionID: "sess-verify", agent: "goal-verify" }),
    )
    expect(String(out)).toContain("not active")
  })

  it("父会话无 goal 时拒绝 complete", async () => {
    const { client } = makeClient({ "sess-parent": {}, "sess-verify": { parentID: "sess-parent" } })
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute(
      { op: "complete" },
      makeCtx({ sessionID: "sess-verify", agent: "goal-verify" }),
    )
    expect(String(out)).toContain("No goal to complete")
  })
})

describe("goal 工具 — create 写 session-index 绑定", () => {
  it("create 时 bindSession 写入索引文件（供重启 autoResume）", async () => {
    const dir = await makeProjectDir()
    const { client } = makeClient()
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    await tool.execute({ op: "create", parent_issue_number: 42 }, makeCtx({ directory: dir }))
    const index = JSON.parse(await readFile(sessionIndexPath(dir), "utf8")) as {
      flows: Record<string, { sessionID: string; status: string }>
    }
    expect(index.flows["42"]?.sessionID).toBe("sess-main")
    expect(index.flows["42"]?.status).toBe("active")
  })

  it("索引写入失败不阻塞 goal 创建", async () => {
    const { client } = makeClient()
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    // directory 不可写 → bindSession 抛错被吞，goal 仍创建
    const out = await tool.execute({ op: "create", parent_issue_number: 42 }, makeCtx({ directory: "/nonexistent-dir" }))
    expect(String(out)).toContain("Goal created")
    expect(client.session.update).toHaveBeenCalledTimes(1)
  })
})

describe("isBlockedReport — 阻塞报告检测", () => {
  it("识别标准 [BLOCKED: 报告", () => {
    expect(isBlockedReport("[BLOCKED: missing API key]")).toBe(true)
  })

  it("大小写与空白容错", () => {
    expect(isBlockedReport("foo\n[blocked:  needs decision ]bar")).toBe(true)
  })

  it("普通回复不误判", () => {
    expect(isBlockedReport("继续工作中，已完成 X 和 Y。")).toBe(false)
    expect(isBlockedReport("blocked 这个词出现在正文里")).toBe(false)
    expect(isBlockedReport("")).toBe(false)
  })
})

describe("isDoneReport — 完成报告检测", () => {
  it("识别标准 [DONE: 报告", () => {
    expect(isDoneReport("[DONE: all tests pass]")).toBe(true)
    expect(isDoneReport("summary\n[DONE: 全部完成]")).toBe(true)
  })

  it("普通回复不误判", () => {
    expect(isDoneReport("继续工作中")).toBe(false)
    expect(isDoneReport("done 出现在正文里")).toBe(false)
    expect(isDoneReport("")).toBe(false)
  })
})

describe("token 记账辅助", () => {
  it("snapshotTokenTotal = input + reasoning + cache.read + output", () => {
    expect(snapshotTokenTotal({ input: 1, output: 3, cache: { read: 2 } })).toBe(6)
    expect(snapshotTokenTotal({ input: 1, output: 3, cache: { read: 2 }, reasoning: 4 })).toBe(10)
  })

  it("异常输入返回 0（防御）", () => {
    expect(snapshotTokenTotal(null)).toBe(0)
    expect(snapshotTokenTotal({})).toBe(0)
    expect(snapshotTokenTotal({ input: -5, output: "x", cache: {} })).toBe(0)
  })

  it("budgetReached：tokensUsed >= tokenBudget 才达限", () => {
    expect(budgetReached({ parentIssueNumber: 1, status: "active", continuationCount: 0, tokenBudget: 100, tokensUsed: 100 })).toBe(true)
    expect(budgetReached({ parentIssueNumber: 1, status: "active", continuationCount: 0, tokenBudget: 100, tokensUsed: 99 })).toBe(false)
    expect(budgetReached({ parentIssueNumber: 1, status: "active", continuationCount: 0 })).toBe(false)
  })
})

describe("goal 工具 — edit", () => {
  it("edit 更新 tokenBudget，保留计数与记账", async () => {
    const { client } = makeClient({
      "sess-main": { goal: { parentIssueNumber: 42, status: "paused" as const, continuationCount: 7, tokensUsed: 100, tokenBudget: 100 } },
    })
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute({ op: "edit", token_budget: 500 }, makeCtx())
    expect(String(out)).toContain("Goal updated")
    const updated = client.session.update.mock.calls[0][0] as unknown as { metadata: { goal: { tokenBudget: number; continuationCount: number; tokensUsed: number; status: string } } }
    expect(updated.metadata.goal.tokenBudget).toBe(500)
    expect(updated.metadata.goal.continuationCount).toBe(7)
    expect(updated.metadata.goal.tokensUsed).toBe(100)
    expect(updated.metadata.goal.status).toBe("paused")
  })

  it("token_budget 传 0 表示移除预算", async () => {
    const { client } = makeClient({
      "sess-main": { goal: { parentIssueNumber: 42, status: "active" as const, continuationCount: 0, tokenBudget: 100 } },
    })
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    await tool.execute({ op: "edit", token_budget: 0 }, makeCtx())
    const updated = client.session.update.mock.calls[0][0] as unknown as { metadata: { goal: { tokenBudget?: number } } }
    expect(updated.metadata.goal.tokenBudget).toBeUndefined()
  })

  it("edit 更换 parentIssueNumber（换 Flow）：重置记账并 rebind 索引", async () => {
    const dir = await makeProjectDir()
    const { client } = makeClient({
      "sess-main": { goal: { parentIssueNumber: 42, status: "active" as const, continuationCount: 3, tokensUsed: 500, tokensBaseline: 100 } },
    })
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    await tool.execute({ op: "edit", parent_issue_number: 99 }, makeCtx({ directory: dir }))
    const updated = client.session.update.mock.calls[0][0] as unknown as { metadata: { goal: { parentIssueNumber: number; tokensUsed: number; tokensBaseline: number; continuationCount: number } } }
    expect(updated.metadata.goal.parentIssueNumber).toBe(99)
    expect(updated.metadata.goal.tokensUsed).toBe(0)
    expect(updated.metadata.goal.tokensBaseline).toBeUndefined()
    expect(updated.metadata.goal.continuationCount).toBe(3)
    // 索引 rebind：新 Flow 绑定本会话，旧 Flow 解除
    const index = JSON.parse(await readFile(sessionIndexPath(dir), "utf8")) as { flows: Record<string, { sessionID: string }> }
    expect(index.flows["99"]?.sessionID).toBe("sess-main")
    expect(index.flows["42"]).toBeUndefined()
  })

  it("索引 rebind 失败不阻塞 edit（goal 本身已持久化）", async () => {
    const { client } = makeClient({
      "sess-main": { goal: { parentIssueNumber: 42, status: "active" as const, continuationCount: 0 } },
    })
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute({ op: "edit", parent_issue_number: 99 }, makeCtx({ directory: "/nonexistent-dir" }))
    expect(String(out)).toContain("Goal updated")
    const updated = client.session.update.mock.calls[0][0] as unknown as { metadata: { goal: { parentIssueNumber: number } } }
    expect(updated.metadata.goal.parentIssueNumber).toBe(99)
  })

  it("complete 状态只读，拒绝 edit（幂等写回，goal 未被修改）", async () => {
    const { client } = makeClient({
      "sess-main": { goal: { parentIssueNumber: 42, status: "complete" as const, continuationCount: 0 } },
    })
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute({ op: "edit", token_budget: 500 }, makeCtx())
    expect(String(out)).toContain("read-only")
    const updated = client.session.update.mock.calls[0][0] as unknown as { metadata: { goal: { status: string; tokenBudget?: number } } }
    expect(updated.metadata.goal.status).toBe("complete")
    expect(updated.metadata.goal.tokenBudget).toBeUndefined()
  })

  it("无 goal 时拒绝 edit", async () => {
    const { client } = makeClient()
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute({ op: "edit", token_budget: 500 }, makeCtx())
    expect(String(out)).toContain("No goal")
  })

  it("子 agent 不能 edit", async () => {
    const { client } = makeClient({ "sess-child": { parentID: "sess-parent" } })
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute({ op: "edit", token_budget: 500 }, makeCtx({ sessionID: "sess-child" }))
    expect(String(out)).toContain("sub-agents cannot call goal")
  })
})

describe("mutateGoal 并发串行化", () => {  it("两个并发递增不丢失更新（锁内读改写）", async () => {
    const { client, sessions } = makeClient({
      "sess-main": { goal: { parentIssueNumber: 42, status: "active", continuationCount: 5 } },
    })
    // 模拟两个并发续接递增：若未串行化，两者都基于旧值 5 写回 → 最终 6（丢一次更新）
    await Promise.all([
      mutateGoal(client as unknown as ReturnType<typeof createOpencodeClient>, "sess-main", async (goal) => {
        goal!.continuationCount += 1
        return { goal, value: null }
      }),
      mutateGoal(client as unknown as ReturnType<typeof createOpencodeClient>, "sess-main", async (goal) => {
        goal!.continuationCount += 1
        return { goal, value: null }
      }),
    ])
    const final = sessions.get("sess-main")!.metadata.goal as { continuationCount: number }
    expect(final.continuationCount).toBe(7) // 5 + 1 + 1，两次都生效
  })
})

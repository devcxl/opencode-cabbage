import { describe, it, expect, vi, afterEach } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildGoalTool, mutateGoal, isBlockedReport, isDoneReport, snapshotTokenTotal, budgetReached } from "../../src/plugin/goal.js"
import { createSessionGoalStore } from "../../src/plugin/goal-store.js"
import { sessionIndexPath, writeIndex } from "../../src/kernel/session-index.js"

/**
 * 内存 session API：模拟 OpenCode V2 ctx.session 域（get/update/context 返回解包值）。
 */
function makeSessionApi(initial: Record<string, {
  parentID?: string
  metadata?: Record<string, unknown>
  goal?: Record<string, unknown>
  tokens?: unknown
  agent?: string
}> = {}) {
  const sessions = new Map<string, {
    parentID?: string
    metadata: Record<string, unknown>
    tokens?: unknown
    agent?: string
  }>()
  for (const [sid, val] of Object.entries(initial)) {
    sessions.set(sid, {
      parentID: val.parentID,
      metadata: val.metadata ?? (val.goal ? { goal: val.goal } : {}),
      tokens: val.tokens,
      agent: val.agent,
    })
  }
  const session = {
    get: vi.fn(async ({ sessionID }: { sessionID: string }) => {
      const s = sessions.get(sessionID) ?? { metadata: {} }
      return { parentID: s.parentID, metadata: s.metadata, tokens: s.tokens, agent: s.agent }
    }),
    update: vi.fn(async ({ sessionID, metadata }: { sessionID: string; metadata: Record<string, unknown> }) => {
      const existing = sessions.get(sessionID) ?? { metadata: {} }
      sessions.set(sessionID, { ...existing, metadata })
    }),
    context: vi.fn(async () => []),
  }
  return { session, sessions, store: createSessionGoalStore(session as never) }
}

function makeToolCtx(overrides: Record<string, unknown> = {}) {
  return {
    sessionID: "sess-main",
    agent: "dev-lifecycle",
    ...overrides,
  }
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
    const { session, store } = makeSessionApi()
    const tool = buildGoalTool(store, await makeProjectDir())
    const out = await tool.execute({ op: "create", parent_issue_number: 42 }, makeToolCtx())
    expect(out.content).toContain("Goal created")
    expect(out.content).toContain("Flow #42")
    expect(session.update).toHaveBeenCalledTimes(1)
  })

  it("create 时设置 tokenBudget 与 createdAt", async () => {
    const { session, store } = makeSessionApi()
    const tool = buildGoalTool(store, await makeProjectDir())
    const out = await tool.execute({ op: "create", parent_issue_number: 42, token_budget: 100000 }, makeToolCtx())
    expect(out.content).toContain("Goal created")
    const updated = session.update.mock.calls[0][0] as unknown as { metadata: { goal: Record<string, unknown> } }
    expect(updated.metadata.goal.tokenBudget).toBe(100000)
    expect(typeof updated.metadata.goal.createdAt).toBe("number")
  })

  it("create 时用会话累计 tokens 作为记账基线", async () => {
    const { session, store } = makeSessionApi({
      "sess-main": { tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 20, write: 0 } } },
    })
    const tool = buildGoalTool(store, await makeProjectDir())
    await tool.execute({ op: "create", parent_issue_number: 42 }, makeToolCtx())
    const updated = session.update.mock.calls[0][0] as unknown as { metadata: { goal: Record<string, unknown> } }
    // 10 + 20 + 5 = 35
    expect(updated.metadata.goal.tokensBaseline).toBe(35)
  })

  it("会话 tokens 缺失时 baseline 为 0，goal 仍创建", async () => {
    const { session, store } = makeSessionApi()
    const tool = buildGoalTool(store, await makeProjectDir())
    const out = await tool.execute({ op: "create", parent_issue_number: 42 }, makeToolCtx())
    expect(out.content).toContain("Goal created")
    const updated = session.update.mock.calls[0][0] as unknown as { metadata: { goal: Record<string, unknown> } }
    expect(updated.metadata.goal.tokensBaseline).toBe(0)
  })

  it("缺少 parent_issue_number 时拒绝", async () => {
    const { session, store } = makeSessionApi()
    const tool = buildGoalTool(store, await makeProjectDir())
    const out = await tool.execute({ op: "create" }, makeToolCtx())
    expect(out.content).toContain("parent_issue_number is required")
    expect(session.update).not.toHaveBeenCalled()
  })

  it("parent_issue_number 非正整数时拒绝（负数/小数/非数字）", async () => {
    const { session, store } = makeSessionApi()
    const tool = buildGoalTool(store, await makeProjectDir())
    for (const bad of [-5, 1.5, "abc", 0]) {
      const out = await tool.execute({ op: "create", parent_issue_number: bad as never }, makeToolCtx())
      expect(out.content).toContain("parent_issue_number")
      expect(session.update).not.toHaveBeenCalled()
    }
  })

  it("已存在 active goal 时拒绝重复创建", async () => {
    const { sessions, store } = makeSessionApi({ "sess-main": activeGoalMeta() })
    const tool = buildGoalTool(store, await makeProjectDir())
    const out = await tool.execute({ op: "create", parent_issue_number: 99 }, makeToolCtx())
    expect(out.content).toContain("active goal already exists")
    // 现有 goal 必须保留：错误分支返回 null 会触发 mutateGoal 删除现有 goal
    const goal = sessions.get("sess-main")!.metadata.goal as { parentIssueNumber: number; status: string }
    expect(goal.parentIssueNumber).toBe(42)
    expect(goal.status).toBe("active")
  })

  it("子 agent 不能 create", async () => {
    const { store } = makeSessionApi({ "sess-child": { parentID: "sess-parent" } })
    const tool = buildGoalTool(store, await makeProjectDir())
    const out = await tool.execute({ op: "create", parent_issue_number: 42 }, makeToolCtx({ sessionID: "sess-child" }))
    expect(out.content).toContain("sub-agents cannot call goal")
  })
})

describe("goal 工具 — 工具级授权兜底", () => {
  it("非流程 agent 调用被拒绝（规则层之外的兜底）", async () => {
    const { store } = makeSessionApi({ "sess-main": activeGoalMeta() })
    const tool = buildGoalTool(store, await makeProjectDir())
    for (const agent of ["developer", "reviewer", "build", undefined]) {
      const out = await tool.execute({ op: "get" }, makeToolCtx({ agent }))
      expect(out.content).toContain("restricted to the cabbage flow agents")
    }
  })
})

describe("goal 工具 — get", () => {
  it("返回 active goal 状态", async () => {
    const { store } = makeSessionApi({ "sess-main": activeGoalMeta() })
    const tool = buildGoalTool(store, await makeProjectDir())
    const out = await tool.execute({ op: "get" }, makeToolCtx())
    expect(out.content).toContain("Flow: #42")
    expect(out.content).toContain("Status: active")
  })

  it("无 goal 时返回 No active goal", async () => {
    const { store } = makeSessionApi()
    const tool = buildGoalTool(store, await makeProjectDir())
    const out = await tool.execute({ op: "get" }, makeToolCtx())
    expect(out.content).toContain("No active goal")
  })
})

describe("goal 工具 — pause / resume / cancel", () => {
  it("pause：active → paused", async () => {
    const { store } = makeSessionApi({ "sess-main": activeGoalMeta() })
    const tool = buildGoalTool(store, await makeProjectDir())
    const out = await tool.execute({ op: "pause" }, makeToolCtx())
    expect(out.content).toContain("paused")
  })

  it("resume：paused → active 并重置 continuationCount", async () => {
    const { session, store } = makeSessionApi({
      "sess-main": { goal: { parentIssueNumber: 42, status: "paused", continuationCount: 7 } },
    })
    const tool = buildGoalTool(store, await makeProjectDir())
    const out = await tool.execute({ op: "resume" }, makeToolCtx())
    expect(out.content).toContain("resumed")
    const updated = session.update.mock.calls[0][0] as unknown as { metadata: { goal: { status: string; continuationCount: number } } }
    expect(updated.metadata.goal.status).toBe("active")
    expect(updated.metadata.goal.continuationCount).toBe(0)
  })

  it("cancel：移除 goal", async () => {
    const { session, store } = makeSessionApi({ "sess-main": activeGoalMeta() })
    const tool = buildGoalTool(store, await makeProjectDir())
    const out = await tool.execute({ op: "cancel" }, makeToolCtx())
    expect(out.content).toContain("Goal cancelled")
    const updated = session.update.mock.calls[0][0] as { metadata: Record<string, unknown> }
    expect(updated.metadata.goal).toBeUndefined()
  })

  it("子 agent 不能 pause/resume/cancel", async () => {
    const { store } = makeSessionApi({ "sess-child": { parentID: "sess-parent" } })
    const tool = buildGoalTool(store, await makeProjectDir())
    for (const op of ["pause", "resume", "cancel"] as const) {
      const out = await tool.execute({ op }, makeToolCtx({ sessionID: "sess-child" }))
      expect(out.content).toContain("sub-agents cannot call goal")
    }
  })
})

describe("goal 工具 — complete 授权", () => {
  it("goal-verify 可 complete（父会话 active）", async () => {
    const dir = await makeProjectDir()
    const { session, store } = makeSessionApi({
      "sess-parent": activeGoalMeta(),
      "sess-verify": { parentID: "sess-parent" },
    })
    // create 阶段已绑定索引；complete-flow 依赖既有 entry
    await writeIndex(dir, {
      flows: { "42": { sessionID: "sess-parent", status: "active", continuationCount: 0, updatedAt: Date.now() } },
    })
    const tool = buildGoalTool(store, dir)
    const out = await tool.execute(
      { op: "complete" },
      makeToolCtx({ sessionID: "sess-verify", agent: "goal-verify" }),
    )
    expect(out.content).toContain("Goal completed")
    // 父会话 goal 被置为 complete
    const updated = session.update.mock.calls[0][0] as unknown as { sessionID: string; metadata: { goal: { status: string } } }
    expect(updated.sessionID).toBe("sess-parent")
    expect(updated.metadata.goal.status).toBe("complete")
    // 索引标记 completed（flow 级持久化）
    const index = JSON.parse(await readFile(sessionIndexPath(dir), "utf8")) as { flows: Record<string, { goalComplete?: boolean; status?: string }> }
    expect(index.flows["42"]?.goalComplete).toBe(true)
    expect(index.flows["42"]?.status).toBe("completed")
  })

  it("子会话中非 goal-verify agent 不能 complete", async () => {
    const { store } = makeSessionApi({ "sess-parent": activeGoalMeta(), "sess-child": { parentID: "sess-parent" } })
    const tool = buildGoalTool(store, await makeProjectDir())
    const out = await tool.execute({ op: "complete" }, makeToolCtx({ sessionID: "sess-child", agent: "dev-lifecycle" }))
    expect(out.content).toContain("only the goal-verify agent")
  })

  it("primary（非子 agent）不能直接 complete", async () => {
    const { session, store } = makeSessionApi({ "sess-main": activeGoalMeta() })
    const tool = buildGoalTool(store, await makeProjectDir())
    const out = await tool.execute({ op: "complete" }, makeToolCtx())
    expect(out.content).toContain("BLOCKED")
    expect(session.update).not.toHaveBeenCalled()
  })

  it("父会话 goal 非 active 时拒绝 complete", async () => {
    const { store } = makeSessionApi({
      "sess-parent": { goal: { parentIssueNumber: 42, status: "paused", continuationCount: 0 } },
      "sess-verify": { parentID: "sess-parent" },
    })
    const tool = buildGoalTool(store, await makeProjectDir())
    const out = await tool.execute(
      { op: "complete" },
      makeToolCtx({ sessionID: "sess-verify", agent: "goal-verify" }),
    )
    expect(out.content).toContain("not active")
  })

  it("父会话无 goal 时拒绝 complete", async () => {
    const { store } = makeSessionApi({ "sess-parent": {}, "sess-verify": { parentID: "sess-parent" } })
    const tool = buildGoalTool(store, await makeProjectDir())
    const out = await tool.execute(
      { op: "complete" },
      makeToolCtx({ sessionID: "sess-verify", agent: "goal-verify" }),
    )
    expect(out.content).toContain("No goal to complete")
  })
})

describe("goal 工具 — create 写 session-index 绑定", () => {
  it("create 时 bindSession 写入索引文件（供重启 autoResume）", async () => {
    const dir = await makeProjectDir()
    const { store } = makeSessionApi()
    const tool = buildGoalTool(store, dir)
    await tool.execute({ op: "create", parent_issue_number: 42 }, makeToolCtx())
    const index = JSON.parse(await readFile(sessionIndexPath(dir), "utf8")) as {
      flows: Record<string, { sessionID: string; status: string }>
    }
    expect(index.flows["42"]?.sessionID).toBe("sess-main")
    expect(index.flows["42"]?.status).toBe("active")
  })

  it("索引写入失败不阻塞 goal 创建", async () => {
    const { session, store } = makeSessionApi()
    const tool = buildGoalTool(store, "/nonexistent-dir")
    const out = await tool.execute({ op: "create", parent_issue_number: 42 }, makeToolCtx())
    expect(out.content).toContain("Goal created")
    expect(session.update).toHaveBeenCalledTimes(1)
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
    const { session, store } = makeSessionApi({
      "sess-main": { goal: { parentIssueNumber: 42, status: "paused" as const, continuationCount: 7, tokensUsed: 100, tokenBudget: 100 } },
    })
    const tool = buildGoalTool(store, await makeProjectDir())
    const out = await tool.execute({ op: "edit", token_budget: 500 }, makeToolCtx())
    expect(out.content).toContain("Goal updated")
    const updated = session.update.mock.calls[0][0] as unknown as { metadata: { goal: { tokenBudget: number; continuationCount: number; tokensUsed: number; status: string } } }
    expect(updated.metadata.goal.tokenBudget).toBe(500)
    expect(updated.metadata.goal.continuationCount).toBe(7)
    expect(updated.metadata.goal.tokensUsed).toBe(100)
    expect(updated.metadata.goal.status).toBe("paused")
  })

  it("token_budget 传 0 表示移除预算", async () => {
    const { session, store } = makeSessionApi({
      "sess-main": { goal: { parentIssueNumber: 42, status: "active" as const, continuationCount: 0, tokenBudget: 100 } },
    })
    const tool = buildGoalTool(store, await makeProjectDir())
    await tool.execute({ op: "edit", token_budget: 0 }, makeToolCtx())
    const updated = session.update.mock.calls[0][0] as unknown as { metadata: { goal: { tokenBudget?: number } } }
    expect(updated.metadata.goal.tokenBudget).toBeUndefined()
  })

  it("edit 更换 parentIssueNumber（换 Flow）：重置记账并 rebind 索引", async () => {
    const dir = await makeProjectDir()
    const { session, store } = makeSessionApi({
      "sess-main": { goal: { parentIssueNumber: 42, status: "active" as const, continuationCount: 3, tokensUsed: 500, tokensBaseline: 100 }, tokens: { input: 7, output: 3, reasoning: 0, cache: { read: 0, write: 0 } } },
    })
    const tool = buildGoalTool(store, dir)
    await tool.execute({ op: "edit", parent_issue_number: 99 }, makeToolCtx())
    const updated = session.update.mock.calls[0][0] as unknown as { metadata: { goal: { parentIssueNumber: number; tokensUsed: number; tokensBaseline: number; continuationCount: number } } }
    expect(updated.metadata.goal.parentIssueNumber).toBe(99)
    expect(updated.metadata.goal.tokensUsed).toBe(0)
    // 新基线 = edit 时点的会话累计快照（7 + 0 + 3 = 10）
    expect(updated.metadata.goal.tokensBaseline).toBe(10)
    expect(updated.metadata.goal.continuationCount).toBe(3)
    // 索引 rebind：新 Flow 绑定本会话，旧 Flow 解除
    const index = JSON.parse(await readFile(sessionIndexPath(dir), "utf8")) as { flows: Record<string, { sessionID: string }> }
    expect(index.flows["99"]?.sessionID).toBe("sess-main")
    expect(index.flows["42"]).toBeUndefined()
  })

  it("索引 rebind 失败不阻塞 edit（goal 本身已持久化）", async () => {
    const { session, store } = makeSessionApi({
      "sess-main": { goal: { parentIssueNumber: 42, status: "active" as const, continuationCount: 0 } },
    })
    const tool = buildGoalTool(store, "/nonexistent-dir")
    const out = await tool.execute({ op: "edit", parent_issue_number: 99 }, makeToolCtx())
    expect(out.content).toContain("Goal updated")
    const updated = session.update.mock.calls[0][0] as unknown as { metadata: { goal: { parentIssueNumber: number } } }
    expect(updated.metadata.goal.parentIssueNumber).toBe(99)
  })

  it("complete 状态只读，拒绝 edit（幂等写回，goal 未被修改）", async () => {
    const { session, store } = makeSessionApi({
      "sess-main": { goal: { parentIssueNumber: 42, status: "complete" as const, continuationCount: 0 } },
    })
    const tool = buildGoalTool(store, await makeProjectDir())
    const out = await tool.execute({ op: "edit", token_budget: 500 }, makeToolCtx())
    expect(out.content).toContain("read-only")
    const updated = session.update.mock.calls[0][0] as unknown as { metadata: { goal: { status: string; tokenBudget?: number } } }
    expect(updated.metadata.goal.status).toBe("complete")
    expect(updated.metadata.goal.tokenBudget).toBeUndefined()
  })

  it("无 goal 时拒绝 edit", async () => {
    const { store } = makeSessionApi()
    const tool = buildGoalTool(store, await makeProjectDir())
    const out = await tool.execute({ op: "edit", token_budget: 500 }, makeToolCtx())
    expect(out.content).toContain("No goal")
  })

  it("子 agent 不能 edit", async () => {
    const { store } = makeSessionApi({ "sess-child": { parentID: "sess-parent" } })
    const tool = buildGoalTool(store, await makeProjectDir())
    const out = await tool.execute({ op: "edit", token_budget: 500 }, makeToolCtx({ sessionID: "sess-child" }))
    expect(out.content).toContain("sub-agents cannot call goal")
  })
})

describe("mutateGoal 并发串行化", () => {
  it("两个并发递增不丢失更新（锁内读改写）", async () => {
    const { sessions, store } = makeSessionApi({
      "sess-main": { goal: { parentIssueNumber: 42, status: "active", continuationCount: 5 } },
    })
    // 模拟两个并发续接递增：若未串行化，两者都基于旧值 5 写回 → 最终 6（丢一次更新）
    await Promise.all([
      mutateGoal(store, "sess-main", async (goal) => {
        goal!.continuationCount += 1
        return { goal, value: null }
      }),
      mutateGoal(store, "sess-main", async (goal) => {
        goal!.continuationCount += 1
        return { goal, value: null }
      }),
    ])
    const final = sessions.get("sess-main")!.metadata.goal as { continuationCount: number }
    expect(final.continuationCount).toBe(7) // 5 + 1 + 1，两次都生效
  })
})

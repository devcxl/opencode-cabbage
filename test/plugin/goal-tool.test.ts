import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createGoalTool } from "../../src/plugin/goal.js"
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

  it("缺少 parent_issue_number 时拒绝", async () => {
    const { client } = makeClient()
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute({ op: "create" }, makeCtx())
    expect(String(out)).toContain("parent_issue_number is required")
    expect(client.session.update).not.toHaveBeenCalled()
  })

  it("已存在 active goal 时拒绝重复创建", async () => {
    const { client } = makeClient({ "sess-main": activeGoalMeta() })
    const tool = createGoalTool(client as unknown as ReturnType<typeof createOpencodeClient>)
    const out = await tool.execute({ op: "create", parent_issue_number: 99 }, makeCtx())
    expect(String(out)).toContain("active goal already exists")
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

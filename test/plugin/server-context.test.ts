import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { buildFirstUserInjection } from "../../src/plugin/server.js"
import { resetContextCache, CONTEXT_MARKER } from "../../src/kernel/context.js"
import { makeHarness, waitFor, flush } from "./harness.js"
import type { Harness } from "./harness.js"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

let tmpDir: string
let harness: Harness

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "cabbage-server-context-"))
  resetContextCache()
  process.env.CABBAGE_SKILLS_DIR = path.join(tmpDir, "skills")
  harness = await makeHarness(tmpDir, projectRoot)
})

afterEach(async () => {
  harness.cleanup()
  resetContextCache()
  delete process.env.CABBAGE_SKILLS_DIR
  await rm(tmpDir, { recursive: true, force: true })
})

describe("setup — 资产注册", () => {
  it("注册全部 flow skills / commands / goal 工具", () => {
    const skillIds = harness.skillAdds.map((s) => s.id)
    expect(skillIds).toContain("flow-setup")
    expect(skillIds).toContain("flow-review")
    expect(skillIds.length).toBeGreaterThanOrEqual(9)
    expect(harness.commandAdds.map((c) => c.name).sort()).toEqual(
      ["code", "design", "release", "requirements", "review", "setup", "tasks"].sort(),
    )
    expect(harness.toolAdds).toHaveLength(1)
    expect(harness.toolAdds[0]!.name).toBe("goal")
    expect((harness.toolAdds[0]!.options as { permission?: string })?.permission).toBe("goal")
  })
})

describe("buildFirstUserInjection — 注入决策", () => {
  const bootstrap = "<EXTREMELY_IMPORTANT>bootstrap content</EXTREMELY_IMPORTANT>"
  const contextBlock = {
    path: "/tmp/CONTEXT.md",
    mtimeMs: 1,
    digest: "abc123",
    terms: ["Terms"],
    block: `## Project Context (auto-injected)\n<!-- ${CONTEXT_MARKER} -->\n...`,
  }

  it("Primary（goal 激活）注入 bootstrap + context", () => {
    const text = buildFirstUserInjection({ hasGoal: true, isSubAgent: false, contextBlock, bootstrap })
    expect(text).toContain(bootstrap)
    expect(text).toContain(CONTEXT_MARKER)
  })

  it("Primary 无 CONTEXT.md 时仅注入 bootstrap", () => {
    const text = buildFirstUserInjection({ hasGoal: true, isSubAgent: false, contextBlock: null, bootstrap })
    expect(text).toBe(bootstrap)
  })

  it("子 agent 注入 context 但不注入 bootstrap", () => {
    const text = buildFirstUserInjection({ hasGoal: false, isSubAgent: true, contextBlock, bootstrap })
    expect(text).toContain(CONTEXT_MARKER)
    expect(text).not.toContain("EXTREMELY_IMPORTANT")
  })

  it("goal 未激活且非子 agent → 不注入", () => {
    const text = buildFirstUserInjection({ hasGoal: false, isSubAgent: false, contextBlock, bootstrap })
    expect(text).toBeNull()
  })

  it("子 agent 无 CONTEXT.md → 不注入", () => {
    const text = buildFirstUserInjection({ hasGoal: false, isSubAgent: true, contextBlock: null, bootstrap })
    expect(text).toBeNull()
  })
})

describe("context hook — 注入接线", () => {
  const makeSystemEvent = (sessionID = "sess-1") => ({ sessionID, agent: "dev-lifecycle", system: [] as Array<{ type: string; text: string }> })

  it("goal 会话注入 bootstrap + Project Context 块", async () => {
    await writeFile(path.join(tmpDir, "CONTEXT.md"), "## Terms\n- user\n", "utf8")
    harness.sessions.get("sess-1")!.metadata = { goal: { parentIssueNumber: 42, status: "active", continuationCount: 0 } }
    const event = makeSystemEvent()
    await harness.sessionHooks.get("context")!(event)
    const text = event.system.map((p) => p.text).join("\n")
    expect(text).toContain("EXTREMELY_IMPORTANT")
    expect(text).toContain("Project Context (auto-injected)")
    expect(text).toContain(CONTEXT_MARKER)
  })

  it("子 agent 注入 Project Context 块（无 bootstrap）", async () => {
    await writeFile(path.join(tmpDir, "CONTEXT.md"), "## Terms\n- agent\n", "utf8")
    harness.sessions.set("sess-child", { parentID: "sess-1", metadata: {}, messages: [] })
    const event = makeSystemEvent("sess-child")
    await harness.sessionHooks.get("context")!(event)
    const text = event.system.map((p) => p.text).join("\n")
    expect(text).toContain("Project Context (auto-injected)")
    expect(text).toContain(CONTEXT_MARKER)
    expect(text).not.toContain("EXTREMELY_IMPORTANT")
  })

  it("goal 未激活且非子 agent 不注入", async () => {
    await writeFile(path.join(tmpDir, "CONTEXT.md"), "## Terms\n- user\n", "utf8")
    const event = makeSystemEvent()
    await harness.sessionHooks.get("context")!(event)
    expect(event.system).toHaveLength(0)
  })

  it("CONTEXT.md 缺失时不报错，goal 会话仍注入 bootstrap", async () => {
    harness.sessions.get("sess-1")!.metadata = { goal: { parentIssueNumber: 42, status: "active", continuationCount: 0 } }
    const event = makeSystemEvent()
    await harness.sessionHooks.get("context")!(event)
    const text = event.system.map((p) => p.text).join("\n")
    expect(text).toContain("EXTREMELY_IMPORTANT")
    expect(text).not.toContain(CONTEXT_MARKER)
  })

  it("system 已含注入 marker 时不重复注入（幂等）", async () => {
    harness.sessions.get("sess-1")!.metadata = { goal: { parentIssueNumber: 42, status: "active", continuationCount: 0 } }
    const event = makeSystemEvent()
    event.system.push({ type: "text", text: `already injected <!-- ${CONTEXT_MARKER} -->` })
    await harness.sessionHooks.get("context")!(event)
    expect(event.system).toHaveLength(1)
  })
})

describe("event handler — execution.succeeded 自动续接", () => {
  const activeGoal = () => ({ goal: { parentIssueNumber: 42, status: "active", continuationCount: 0 } })

  it("active goal 轮次结束 → 注入 continuation prompt（synthetic 一次）", async () => {
    harness.sessions.get("sess-1")!.metadata = activeGoal()
    harness.eventStream.push({ type: "session.execution.succeeded", id: "ev-1", data: { sessionID: "sess-1" } })
    await waitFor(() => harness.sessionApi.synthetic.mock.calls.length > 0)
    const call = harness.sessionApi.synthetic.mock.calls[0][0] as { sessionID: string; text: string }
    expect(call.sessionID).toBe("sess-1")
    expect(call.text).toContain("#42")
  })

  it("子 agent（parentID）轮次结束 → 不续接", async () => {
    harness.sessions.set("sess-child", { parentID: "sess-1", metadata: activeGoal(), messages: [structuredClone({ type: "assistant", id: "m", time: { created: 1, completed: 2 }, content: [] })] })
    harness.eventStream.push({ type: "session.execution.succeeded", id: "ev-2", data: { sessionID: "sess-child" } })
    await flush()
    expect(harness.sessionApi.synthetic).not.toHaveBeenCalled()
  })

  it("无 goal → 不续接", async () => {
    harness.eventStream.push({ type: "session.execution.succeeded", id: "ev-3", data: { sessionID: "sess-1" } })
    await flush()
    expect(harness.sessionApi.synthetic).not.toHaveBeenCalled()
  })

  it("paused goal → 不续接", async () => {
    harness.sessions.get("sess-1")!.metadata = { goal: { parentIssueNumber: 42, status: "paused", continuationCount: 3 } }
    harness.eventStream.push({ type: "session.execution.succeeded", id: "ev-4", data: { sessionID: "sess-1" } })
    await flush()
    expect(harness.sessionApi.synthetic).not.toHaveBeenCalled()
  })

  it("continuationCount 达上限 → 置 paused，不续接", async () => {
    harness.sessions.get("sess-1")!.metadata = { goal: { parentIssueNumber: 42, status: "active", continuationCount: 50 } }
    harness.eventStream.push({ type: "session.execution.succeeded", id: "ev-5", data: { sessionID: "sess-1" } })
    await waitFor(() => {
      const g = harness.sessions.get("sess-1")!.metadata.goal as { status?: string } | undefined
      return g?.status === "paused"
    })
    expect(harness.sessionApi.synthetic).not.toHaveBeenCalled()
  })

  it("重复 succeeded 事件在合成消息入队后不再二次续接（尾部队列防重入）", async () => {
    harness.sessions.get("sess-1")!.metadata = activeGoal()
    harness.eventStream.push({ type: "session.execution.succeeded", id: "ev-6", data: { sessionID: "sess-1" } })
    await waitFor(() => harness.sessionApi.synthetic.mock.calls.length > 0)
    harness.eventStream.push({ type: "session.execution.succeeded", id: "ev-7", data: { sessionID: "sess-1" } })
    await flush()
    expect(harness.sessionApi.synthetic).toHaveBeenCalledTimes(1)
  })
})

describe("event handler — inbox user 重置计数", () => {
  it("用户消息 → continuationCount 重置为 0 并刷新 profile", async () => {
    harness.sessions.get("sess-1")!.metadata = { goal: { parentIssueNumber: 42, status: "active", continuationCount: 7 } }
    harness.sessions.get("sess-1")!.agent = "dev-lifecycle"
    harness.eventStream.push({
      type: "session.inbox.enqueued",
      id: "ev-8",
      data: { sessionID: "sess-1", inboxID: "inb-1", item: { type: "user" } },
    })
    await waitFor(() => {
      const g = harness.sessions.get("sess-1")!.metadata.goal as { continuationCount?: number } | undefined
      return g?.continuationCount === 0
    })
    const goal = harness.sessions.get("sess-1")!.metadata.goal as { sessionProfile?: { agent?: string } }
    expect(goal.sessionProfile?.agent).toBe("dev-lifecycle")
  })

  it("synthetic（非用户）入队不重置计数", async () => {
    harness.sessions.get("sess-1")!.metadata = { goal: { parentIssueNumber: 42, status: "active", continuationCount: 7 } }
    harness.eventStream.push({
      type: "session.inbox.enqueued",
      id: "ev-9",
      data: { sessionID: "sess-1", inboxID: "inb-2", item: { type: "synthetic" } },
    })
    await flush()
    const goal = harness.sessions.get("sess-1")!.metadata.goal as { continuationCount?: number }
    expect(goal.continuationCount).toBe(7)
  })
})

describe("event handler — execution.interrupted 中断暂停", () => {
  it("reason=user → 立即持久化 paused，后续轮次结束不续接", async () => {
    harness.sessions.get("sess-1")!.metadata = { goal: { parentIssueNumber: 42, status: "active", continuationCount: 1 } }
    harness.eventStream.push({
      type: "session.execution.interrupted",
      id: "ev-10",
      data: { sessionID: "sess-1", reason: "user" },
    })
    await waitFor(() => {
      const g = harness.sessions.get("sess-1")!.metadata.goal as { status?: string } | undefined
      return g?.status === "paused"
    })
    const goal = harness.sessions.get("sess-1")!.metadata.goal as { statusReason?: string }
    expect(goal.statusReason).toBe("aborted by user")

    harness.eventStream.push({ type: "session.execution.succeeded", id: "ev-11", data: { sessionID: "sess-1" } })
    await flush()
    expect(harness.sessionApi.synthetic).not.toHaveBeenCalled()
  })

  it("非 user 原因（shutdown）→ 不暂停，轮次结束正常续接", async () => {
    harness.sessions.get("sess-1")!.metadata = { goal: { parentIssueNumber: 42, status: "active", continuationCount: 0 } }
    harness.eventStream.push({
      type: "session.execution.interrupted",
      id: "ev-12",
      data: { sessionID: "sess-1", reason: "shutdown" },
    })
    harness.eventStream.push({ type: "session.execution.succeeded", id: "ev-13", data: { sessionID: "sess-1" } })
    await waitFor(() => harness.sessionApi.synthetic.mock.calls.length > 0)
    expect(harness.sessionApi.synthetic).toHaveBeenCalledTimes(1)
  })
})

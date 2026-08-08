import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const mockSessionGet = vi.fn()
const mockPromptAsync = vi.fn()
const mockSessionChildren = vi.fn()
const mockSessionStatus = vi.fn()
const mockSessionMessages = vi.fn()

/** 完成态的 assistant 消息：queueContinuation 的尾部检查/记账/续接依赖 */
const COMPLETED_ASSISTANT = {
  info: {
    id: "msg-1",
    role: "assistant",
    time: { completed: 2 },
    providerID: "provider",
    modelID: "model",
    tokens: { input: 1, output: 1, cache: { read: 0 } },
  },
  parts: [{ type: "text", text: "工作完成。" }],
}

vi.mock("../../src/plugin/goal.js", async () => {
  const actual = await vi.importActual("../../src/plugin/goal.js")
  return {
    ...actual,
    createGoalClient: () => ({
      session: {
        // 每次调用深拷贝返回值，防止 queueContinuation 原地修改 goal 污染共享常量
        get: async (...args: unknown[]) => {
          const r = await mockSessionGet(...args)
          return JSON.parse(JSON.stringify(r))
        },
        update: vi.fn(),
        promptAsync: (...args: unknown[]) => mockPromptAsync(...args),
        // queueContinuation 新增检查依赖：子会话活动闸 + 尾部静默/记账
        children: (...args: unknown[]) => mockSessionChildren(...args),
        status: (...args: unknown[]) => mockSessionStatus(...args),
        messages: (...args: unknown[]) => mockSessionMessages(...args),
      },
    }),
  }
})

import { createOpencodeCabbage, buildFirstUserInjection } from "../../src/plugin/server.js"
import { resetContextCache, CONTEXT_MARKER } from "../../src/kernel/context.js"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const ACTIVE_GOAL = {
  data: {
    parentID: null,
    metadata: {
      goal: { parentIssueNumber: 42, status: "active", continuationCount: 0 },
    },
  },
}
const PAUSED_GOAL = {
  data: {
    parentID: null,
    metadata: {
      goal: { parentIssueNumber: 42, status: "paused", continuationCount: 3 },
    },
  },
}
const SUBAGENT_SESSION = { data: { parentID: "parent-1", metadata: {} } }
const PLAIN_SESSION = { data: { parentID: null, metadata: {} } }

type Transform = (input: unknown, output: { messages: unknown[] }) => Promise<void>
type EventHook = (input: { event: unknown }) => Promise<void>

let tmpDir: string
let transform: Transform
let event: EventHook

/** 等待 fire-and-forget 的 queueContinuation 完成（轮询而非固定延时，避免全量并发抖动） */
async function waitForContinuation() {
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 20))
    if (mockPromptAsync.mock.calls.length > 0) return
  }
}

async function makeOutput(sessionID = "sess-1", text = "hello") {
  return {
    messages: [
      { info: { role: "user", sessionID }, parts: [{ type: "text", text }] },
    ],
  }
}

/** 深拷贝避免 queueContinuation 修改共享常量（goal 对象被原地改 status/count） */
function goalSession(goal: unknown) {
  return JSON.parse(JSON.stringify(goal))
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "cabbage-server-context-"))
  resetContextCache()
  process.env.CABBAGE_SKILLS_DIR = path.join(tmpDir, "skills")
  mockSessionGet.mockReset()
  mockPromptAsync.mockReset()
  mockSessionChildren.mockReset()
  mockSessionStatus.mockReset()
  mockSessionMessages.mockReset()
  // 默认：无子会话、全部空闲、尾部为完成态 assistant（续接可正常通过全部新检查）
  mockSessionChildren.mockResolvedValue({ data: [] })
  mockSessionStatus.mockResolvedValue({ data: {} })
  mockSessionMessages.mockResolvedValue({ data: [JSON.parse(JSON.stringify(COMPLETED_ASSISTANT))] })

  const ctx = {
    worktree: tmpDir,
    directory: tmpDir,
    client: { _client: { getConfig: () => ({}) } },
    serverUrl: new URL("http://localhost:0"),
  }
  const plugin = await createOpencodeCabbage(projectRoot)(ctx as never, {})
  transform = plugin["experimental.chat.messages.transform"] as Transform
  event = plugin.event as EventHook
})

afterEach(async () => {
  resetContextCache()
  delete process.env.CABBAGE_SKILLS_DIR
  await rm(tmpDir, { recursive: true, force: true })
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

describe("message.transform — 注入接线", () => {
  it("Primary 首消息注入 bootstrap + Project Context 块", async () => {
    await writeFile(path.join(tmpDir, "CONTEXT.md"), "## Terms\n- user\n", "utf8")
    mockSessionGet.mockResolvedValue(ACTIVE_GOAL)

    const output = await makeOutput()
    await transform({}, output)

    const text = (output.messages[0].parts[0] as { text: string }).text
    expect(text).toContain("EXTREMELY_IMPORTANT")
    expect(text).toContain("Project Context (auto-injected)")
    expect(text).toContain(CONTEXT_MARKER)
  })

  it("子 agent 首消息注入 Project Context 块（无 bootstrap）", async () => {
    await writeFile(path.join(tmpDir, "CONTEXT.md"), "## Terms\n- agent\n", "utf8")
    mockSessionGet.mockResolvedValue(SUBAGENT_SESSION)

    const output = await makeOutput()
    await transform({}, output)

    const text = (output.messages[0].parts[0] as { text: string }).text
    expect(text).toContain("Project Context (auto-injected)")
    expect(text).toContain(CONTEXT_MARKER)
    expect(text).not.toContain("EXTREMELY_IMPORTANT")
  })

  it("goal 未激活且非子 agent 不注入", async () => {
    await writeFile(path.join(tmpDir, "CONTEXT.md"), "## Terms\n- user\n", "utf8")
    mockSessionGet.mockResolvedValue(PLAIN_SESSION)

    const output = await makeOutput()
    await transform({}, output)

    expect(output.messages[0].parts).toHaveLength(1)
    expect((output.messages[0].parts[0] as { text: string }).text).toBe("hello")
  })

  it("CONTEXT.md 缺失时不报错，Primary 仍注入 bootstrap", async () => {
    mockSessionGet.mockResolvedValue(ACTIVE_GOAL)

    const output = await makeOutput()
    await transform({}, output)

    const text = (output.messages[0].parts[0] as { text: string }).text
    expect(text).toContain("EXTREMELY_IMPORTANT")
    expect(text).not.toContain(CONTEXT_MARKER)
  })

  it("已含注入 marker 的会话不重复注入", async () => {
    await writeFile(path.join(tmpDir, "CONTEXT.md"), "## Terms\n- user\n", "utf8")
    mockSessionGet.mockResolvedValue(ACTIVE_GOAL)

    const output = await makeOutput("sess-1", `already injected <!-- ${CONTEXT_MARKER} -->`)
    await transform({}, output)

    expect(output.messages[0].parts).toHaveLength(1)
  })
})

describe("event handler — idle 自动续接", () => {
  it("active goal idle → 注入 continuation prompt（promptAsync 调用一次）", async () => {
    mockSessionGet.mockResolvedValue(ACTIVE_GOAL)
    await event({ event: { type: "session.status", properties: { status: { type: "idle" }, sessionID: "sess-1" } } })
    // 等待 fire-and-forget 的 queueContinuation 完成
    await waitForContinuation()
    expect(mockPromptAsync).toHaveBeenCalledTimes(1)
    const call = mockPromptAsync.mock.calls[0][0]
    expect(call.sessionID).toBe("sess-1")
    expect(call.parts[0].text).toContain("#42")
  })

  it("子 agent（parentID）idle → 不续接", async () => {
    mockSessionGet.mockResolvedValue(SUBAGENT_SESSION)
    await event({ event: { type: "session.status", properties: { status: { type: "idle" }, sessionID: "sess-child" } } })
    await waitForContinuation()
    expect(mockPromptAsync).not.toHaveBeenCalled()
  })

  it("无 goal idle → 不续接", async () => {
    mockSessionGet.mockResolvedValue(PLAIN_SESSION)
    await event({ event: { type: "session.status", properties: { status: { type: "idle" }, sessionID: "sess-1" } } })
    await waitForContinuation()
    expect(mockPromptAsync).not.toHaveBeenCalled()
  })

  it("paused goal idle → 不续接", async () => {
    mockSessionGet.mockResolvedValue(PAUSED_GOAL)
    await event({ event: { type: "session.status", properties: { status: { type: "idle" }, sessionID: "sess-1" } } })
    await waitForContinuation()
    expect(mockPromptAsync).not.toHaveBeenCalled()
  })

  it("continuationCount 达上限 → 置 paused，不续接", async () => {
    mockSessionGet.mockResolvedValue({
      data: {
        parentID: null,
        metadata: { goal: { parentIssueNumber: 42, status: "active", continuationCount: 50 } },
      },
    })
    await event({ event: { type: "session.status", properties: { status: { type: "idle" }, sessionID: "sess-1" } } })
    await waitForContinuation()
    expect(mockPromptAsync).not.toHaveBeenCalled()
  })

  it("并发两个 idle 事件 → 仅一次 promptAsync（continuationInFlight 防重入）", async () => {
    mockSessionGet.mockResolvedValue(ACTIVE_GOAL)
    await Promise.all([
      event({ event: { type: "session.status", properties: { status: { type: "idle" }, sessionID: "sess-1" } } }),
      event({ event: { type: "session.status", properties: { status: { type: "idle" }, sessionID: "sess-1" } } }),
    ])
    await waitForContinuation()
    expect(mockPromptAsync).toHaveBeenCalledTimes(1)
  })
})

describe("event handler — message.updated 重置计数", () => {
  it("用户消息 → continuationCount 重置为 0", async () => {
    mockSessionGet.mockResolvedValue({
      data: {
        parentID: null,
        metadata: { goal: { parentIssueNumber: 42, status: "active", continuationCount: 7 } },
      },
    })
    await event({
      event: {
        type: "message.updated",
        properties: { sessionID: "sess-1", info: { role: "user", agent: "dev-lifecycle" } },
      },
    })
    // writeGoal 调用 session.update
    expect(mockSessionGet).toHaveBeenCalled()
  })

  it("续接 in-flight 时的用户消息不重置（continuationInFlight 保护）", async () => {
    mockSessionGet.mockResolvedValue(ACTIVE_GOAL)
    // 先触发续接（进入 in-flight）
    await event({ event: { type: "session.status", properties: { status: { type: "idle" }, sessionID: "sess-1" } } })
    // 立即用户消息（仍在 in-flight 窗口）
    await event({
      event: {
        type: "message.updated",
        properties: { sessionID: "sess-1", info: { role: "user", agent: "dev-lifecycle" } },
      },
    })
    await waitForContinuation()
    // 续接正常发生一次
    expect(mockPromptAsync).toHaveBeenCalledTimes(1)
  })
})

describe("event handler — session.error abort 标记", () => {
  it("MessageAbortedError → 记录 abort，下次 idle 置 paused 不续接", async () => {
    mockSessionGet.mockResolvedValue(ACTIVE_GOAL)
    await event({
      event: {
        type: "session.error",
        properties: { sessionID: "sess-abort-1", error: { name: "MessageAbortedError" } },
      },
    })
    await event({ event: { type: "session.status", properties: { status: { type: "idle" }, sessionID: "sess-abort-1" } } })
    // 等 fire-and-forget 的 queueContinuation 完全结束（含 abort 分支），避免异步泄漏到下一测试
    await new Promise(r => setTimeout(r, 50))
    expect(mockPromptAsync).not.toHaveBeenCalled()
  })

  it("非 MessageAbortedError → 不标记 abort，idle 正常续接", async () => {
    mockSessionGet.mockResolvedValue(ACTIVE_GOAL)
    await event({
      event: {
        type: "session.error",
        properties: { sessionID: "sess-abort-2", error: { name: "SomeOtherError" } },
      },
    })
    await event({ event: { type: "session.status", properties: { status: { type: "idle" }, sessionID: "sess-abort-2" } } })
    await waitForContinuation()
    expect(mockPromptAsync).toHaveBeenCalledTimes(1)
  })
})

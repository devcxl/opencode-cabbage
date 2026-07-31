import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const mockSessionGet = vi.fn()
const mockPromptAsync = vi.fn()

vi.mock("../../src/plugin/goal.js", async () => {
  const actual = await vi.importActual("../../src/plugin/goal.js")
  return {
    ...actual,
    createGoalClient: () => ({
      session: {
        get: (...args: unknown[]) => mockSessionGet(...args),
        update: vi.fn(),
        promptAsync: (...args: unknown[]) => mockPromptAsync(...args),
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
      goal: { objective: "test", completionCriterion: "pass", status: "active", continuationCount: 0 },
    },
  },
}
const SUBAGENT_SESSION = { data: { parentID: "parent-1", metadata: {} } }
const PLAIN_SESSION = { data: { parentID: null, metadata: {} } }

type Transform = (input: unknown, output: { messages: unknown[] }) => Promise<void>

let tmpDir: string
let transform: Transform

async function makeOutput(sessionID = "sess-1", text = "hello") {
  return {
    messages: [
      { info: { role: "user", sessionID }, parts: [{ type: "text", text }] },
    ],
  }
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "cabbage-server-context-"))
  resetContextCache()
  process.env.CABBAGE_SKILLS_DIR = path.join(tmpDir, "skills")
  mockSessionGet.mockReset()
  mockPromptAsync.mockReset()

  const ctx = {
    worktree: tmpDir,
    directory: tmpDir,
    client: { _client: { getConfig: () => ({}) } },
    serverUrl: new URL("http://localhost:0"),
  }
  const plugin = await createOpencodeCabbage(projectRoot)(ctx as never, {})
  transform = plugin["experimental.chat.messages.transform"] as Transform
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

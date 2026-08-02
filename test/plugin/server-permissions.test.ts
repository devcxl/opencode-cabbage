import { describe, expect, it, vi, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { configureGoalTools } from "../../src/plugin/server.js"
import type { AgentEntry } from "../../src/plugin/agents.js"

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

interface TestConfig {
  tools?: Record<string, boolean>
  agent: Record<string, { tools?: Record<string, boolean> }>
}

describe("configureGoalTools", () => {
  it("denies goal globally and allows only the lifecycle agents", () => {
    const config: TestConfig = {
      tools: { read: true, goal: true },
      agent: {
        "dev-lifecycle": { tools: { read: true } },
        "goal-verify": { tools: { read: true, write: false } },
        developer: { tools: { read: true, goal: true } },
      },
    }

    configureGoalTools(config)

    expect(config.tools).toEqual({ read: true, goal: false })
    expect(config.agent["dev-lifecycle"].tools).toEqual({ read: true, goal: true })
    expect(config.agent["goal-verify"].tools).toEqual({ read: true, write: false, goal: true })
    expect(config.agent.developer.tools).toEqual({ read: true, goal: false })
  })

  it("configures agents that do not already declare tools", () => {
    const config: TestConfig = {
      agent: {
        "dev-lifecycle": {},
        "goal-verify": {},
        reviewer: {},
      },
    }

    configureGoalTools(config)

    expect(config.tools).toEqual({ goal: false })
    expect(config.agent["dev-lifecycle"].tools).toEqual({ goal: true })
    expect(config.agent["goal-verify"].tools).toEqual({ goal: true })
    expect(config.agent.reviewer.tools).toEqual({ goal: false })
  })

  it("denies goal when no agents are configured", () => {
    const config: { tools?: Record<string, boolean> } = {}

    configureGoalTools(config)

    expect(config.tools).toEqual({ goal: false })
  })
})

describe("reviewer permission enforcement", () => {
  it("reviewer is denied goal tool access", () => {
    const config: TestConfig = {
      agent: {
        reviewer: { tools: { read: true, bash: false, write: false, edit: false } },
      },
    }

    configureGoalTools(config)

    // Reviewer should never get goal: true
    expect(config.agent.reviewer.tools).toEqual({
      read: true,
      bash: false,
      write: false,
      edit: false,
      goal: false,
    })
  })

  it("reviewer stays denied even if goal was previously set", () => {
    const config: TestConfig = {
      agent: {
        reviewer: { tools: { read: true, goal: true } },
      },
    }

    configureGoalTools(config)

    // configureGoalTools should override any previous goal: true for reviewer
    expect(config.agent.reviewer.tools?.goal).toBe(false)
  })

  it("only dev-lifecycle and goal-verify get goal access", () => {
    const config: TestConfig = {
      agent: {
        "dev-lifecycle": {},
        "goal-verify": {},
        developer: {},
        reviewer: {},
        architect: {},
      },
    }

    configureGoalTools(config)

    // Only these two should have goal: true
    expect(config.agent["dev-lifecycle"].tools?.goal).toBe(true)
    expect(config.agent["goal-verify"].tools?.goal).toBe(true)

    // All others should be denied
    expect(config.agent.developer.tools?.goal).toBe(false)
    expect(config.agent.reviewer.tools?.goal).toBe(false)
    expect(config.agent.architect.tools?.goal).toBe(false)
  })
})

describe("server config hook — agent 注入（permission 规则，无 tools 布尔）", () => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

  let tmpDir: string
  let plugin: {
    config: (config: unknown) => Promise<void>
    tool: Record<string, unknown>
  }

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cabbage-server-perm-"))
    process.env.CABBAGE_SKILLS_DIR = path.join(tmpDir, "skills")
    mockSessionGet.mockReset()
    mockPromptAsync.mockReset()

    const ctx = {
      worktree: tmpDir,
      directory: tmpDir,
      client: { _client: { getConfig: () => ({}) } },
      serverUrl: new URL("http://localhost:0"),
    }
    const hooks = await createOpencodeCabbage(projectRoot)(ctx as never, {})
    plugin = hooks as unknown as { config: (config: unknown) => Promise<void>; tool: Record<string, unknown> }
  })

  afterEach(async () => {
    delete process.env.CABBAGE_SKILLS_DIR
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("只注册 goal 工具（生命周期工具已移除）", async () => {
    const toolKeys = Object.keys(plugin.tool).sort()
    expect(toolKeys).toEqual(["goal"])
    // 旧 FlowRun 工具（run-* 版）已删除
    expect(plugin.tool).not.toHaveProperty("flowrun")
  })

  it("注入的 agent 保留 permission 规则，不再注入 tools 布尔", async () => {
    const config: Record<string, any> = { agent: {} }
    await plugin.config(config)

    const agent = config.agent["architect"]
    expect(agent).toBeDefined()
    expect(agent.permission).toBeDefined()
    expect(agent.permission.bash).toBeDefined()
    // agent frontmatter 的 tools 布尔已废弃：不注入 read/bash/write/edit
    // （goal 布尔由 configureGoalTools 作为 config 层工具开关注入，属预期）
    expect(agent.tools?.read).toBeUndefined()
    expect(agent.tools?.bash).toBeUndefined()
    expect(agent.tools?.write).toBeUndefined()
    expect(agent.tools?.edit).toBeUndefined()
  })

  it("注入的 agent shell env 使用 createAgentShellEnv（保留 GH 凭据、禁交互提示）", async () => {
    const config: Record<string, any> = { agent: {} }
    await plugin.config(config)

    const agent = config.agent["dev-lifecycle"]
    expect(agent.shell.env).toEqual({
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    })
  })

  it("用户 config 已定义的 agent 不被覆盖", async () => {
    const config: Record<string, any> = {
      agent: {
        "dev-lifecycle": { permission: { bash: { "*": "allow" } } },
      },
    }
    await plugin.config(config)

    expect(config.agent["dev-lifecycle"].permission).toEqual({ bash: { "*": "allow" } })
    expect(config.agent["dev-lifecycle"].description).toBeUndefined()
  })
})

// 由 createOpencodeCabbage 的返回类型推断（避免显式 import 插件类型）
import { createOpencodeCabbage } from "../../src/plugin/server.js"

export type { AgentEntry }

import { describe, expect, it } from "vitest"
import { configureGoalTools } from "../../src/plugin/server.js"
import type { AgentEntry } from "../../src/plugin/agents.js"

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
        backend: { tools: { read: true, goal: true } },
      },
    }

    configureGoalTools(config)

    expect(config.tools).toEqual({ read: true, goal: false })
    expect(config.agent["dev-lifecycle"].tools).toEqual({ read: true, goal: true })
    expect(config.agent["goal-verify"].tools).toEqual({ read: true, write: false, goal: true })
    expect(config.agent.backend.tools).toEqual({ read: true, goal: false })
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
        backend: {},
        frontend: {},
        reviewer: {},
        architect: {},
      },
    }

    configureGoalTools(config)

    // Only these two should have goal: true
    expect(config.agent["dev-lifecycle"].tools?.goal).toBe(true)
    expect(config.agent["goal-verify"].tools?.goal).toBe(true)

    // All others should be denied
    expect(config.agent.backend.tools?.goal).toBe(false)
    expect(config.agent.frontend.tools?.goal).toBe(false)
    expect(config.agent.reviewer.tools?.goal).toBe(false)
    expect(config.agent.architect.tools?.goal).toBe(false)
  })
})

import { describe, expect, it } from "vitest"
import { configureGoalTools } from "../../src/plugin/server.js"

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

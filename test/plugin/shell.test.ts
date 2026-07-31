import { describe, it, expect } from "vitest"
import { createAgentShellEnv } from "../../src/plugin/shell.js"
import type { AgentEntry } from "../../src/plugin/agents.js"

function makeAgent(overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    key: "test-agent",
    mode: "subagent",
    prompt: "You are a test agent.",
    permission: {
      bash: {
        "*": "deny",
        "npm *": "allow",
        "git status*": "allow",
      },
    },
    ...overrides,
  }
}

describe("createAgentShellEnv", () => {
  it("保留宿主 GitHub 凭据环境：不再清空 GH_TOKEN / GITHUB_TOKEN / GH_ENTERPRISE_TOKEN", () => {
    const env = createAgentShellEnv(makeAgent())

    expect(env.GH_TOKEN).toBeUndefined()
    expect(env.GITHUB_TOKEN).toBeUndefined()
    expect(env.GH_ENTERPRISE_TOKEN).toBeUndefined()
  })

  it("不再替换 HOME / GH_CONFIG_DIR，复用宿主 gh auth", () => {
    const env = createAgentShellEnv(makeAgent())

    expect(env.HOME).toBeUndefined()
    expect(env.GH_CONFIG_DIR).toBeUndefined()
  })

  it("保留防系统 gitconfig 干扰的 GIT_CONFIG_NOSYSTEM=1", () => {
    const env = createAgentShellEnv(makeAgent())

    expect(env.GIT_CONFIG_NOSYSTEM).toBe("1")
  })

  it("设置 GIT_TERMINAL_PROMPT=0 禁止交互式凭据提示", () => {
    const env = createAgentShellEnv(makeAgent())

    expect(env.GIT_TERMINAL_PROMPT).toBe("0")
  })
})

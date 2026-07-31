/**
 * 对抗测试 #8 — 工具 caller 越权：
 * developer 调 task_control / reviewer 调写 op 等 → requireToolCaller 必须拒绝
 * （CALLER_NOT_AUTHORIZED）；config 层第二道门（configureLifecycleTools）同步收紧。
 */
import { describe, it, expect } from "vitest"
import { requireToolCaller, resolveCaller, CALLER_NOT_AUTHORIZED, type CallerContext } from "../../src/kernel/caller.js"
import { configureLifecycleTools } from "../../src/plugin/server.js"

function sessionClient(role: "primary" | "developer" | "reviewer" | "architect" | "goal-verify") {
  const parentID = role === "primary" ? null : "parent"
  return {
    session: {
      get() {
        return Promise.resolve({ data: { parentID } })
      },
    },
  }
}

const ctx = (agent: string, sessionID = "sess_x"): CallerContext => ({ agent, sessionID })

const childOf = (role: "developer" | "reviewer" | "architect" | "goal-verify"): CallerContext => ctx(role)

describe("adversarial #8 — caller 越权必须被拒（CALLER_NOT_AUTHORIZED）", () => {
  it("developer 调 task_control → 拒绝", async () => {
    const denied = await requireToolCaller(childOf("developer"), "task_control", "create-task", sessionClient("developer"))
    expect(denied).not.toBeNull()
    expect(denied).toContain(CALLER_NOT_AUTHORIZED)
  })

  it("developer 调 flow_control / release_control / setup_control → 拒绝", async () => {
    for (const tool of ["flow_control", "release_control", "setup_control"]) {
      const denied = await requireToolCaller(childOf("developer"), tool, "create-flow", sessionClient("developer"))
      expect(denied).not.toBeNull()
      expect(denied).toContain(CALLER_NOT_AUTHORIZED)
    }
  })

  it("developer 调 tdd_checkpoint 允许（矩阵唯一放行），但 not-applicable 拒绝", async () => {
    const allowed = await requireToolCaller(childOf("developer"), "tdd_checkpoint", "red", sessionClient("developer"))
    expect(allowed).toBeNull()
    const denied = await requireToolCaller(childOf("developer"), "tdd_checkpoint", "not-applicable", sessionClient("developer"))
    expect(denied).toContain(CALLER_NOT_AUTHORIZED)
  })

  it("reviewer 无任何生命周期工具 → 全部拒绝", async () => {
    for (const tool of ["setup_control", "flow_control", "task_control", "tdd_checkpoint", "release_control"]) {
      const denied = await requireToolCaller(childOf("reviewer"), tool, "probe", sessionClient("reviewer"))
      expect(denied).not.toBeNull()
      expect(denied).toContain(CALLER_NOT_AUTHORIZED)
    }
  })

  it("architect 仅 flow_control.status 只读；调 task_control 拒绝", async () => {
    const status = await requireToolCaller(childOf("architect"), "flow_control", "status", sessionClient("architect"))
    expect(status).toBeNull()
    const denied = await requireToolCaller(childOf("architect"), "task_control", "merge-task", sessionClient("architect"))
    expect(denied).toContain(CALLER_NOT_AUTHORIZED)
  })

  it("未知 agent 保守视为 reviewer（fail-closed）", async () => {
    await expect(resolveCaller(ctx("ghost"), sessionClient("reviewer"))).resolves.toBe("reviewer")
    const denied = await requireToolCaller(ctx("ghost"), "task_control", "create-task", sessionClient("reviewer"))
    expect(denied).toContain(CALLER_NOT_AUTHORIZED)
  })

  it("config 层第二道门：developer 仅获得 tdd_checkpoint，reviewer 无任何工具", () => {
    const config: { agent: Record<string, { tools: Record<string, boolean> }> } = {
      agent: {
        "dev-lifecycle": { tools: {} },
        developer: { tools: {} },
        reviewer: { tools: {} },
        architect: { tools: {} },
        "goal-verify": { tools: {} },
      },
    }
    configureLifecycleTools(config)
    expect(config.agent["developer"].tools.task_control).toBe(false)
    expect(config.agent["developer"].tools.flow_control).toBe(false)
    expect(config.agent["developer"].tools.tdd_checkpoint).toBe(true)
    for (const tool of ["setup_control", "flow_control", "task_control", "tdd_checkpoint", "release_control"]) {
      expect(config.agent["reviewer"].tools[tool]).toBe(false)
    }
    expect(config.agent["dev-lifecycle"].tools.task_control).toBe(true)
  })
})

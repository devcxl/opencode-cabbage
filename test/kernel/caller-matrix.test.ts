import { describe, it, expect } from "vitest"
import {
  rolesForTool,
  requireToolCaller,
  LIFECYCLE_TOOLS,
  type CallerRole,
  type CallerContext,
  type CallerSessionClient,
} from "../../src/kernel/caller.js"

/** 构造最小 session client：按 sessionID 返回预设 parentID */
function sessionClient(parentBySession: Record<string, string | null | undefined>): CallerSessionClient {
  return {
    session: {
      async get({ sessionID }) {
        return { data: { parentID: parentBySession[sessionID] ?? null } }
      },
    },
  }
}

/** 子会话 ctx：agent 名已知，parentID 存在 */
function childCtx(agent: string): CallerContext {
  return { agent, sessionID: "sess_child" }
}

/** 无 parentID → primary（无论 agent 名） */
const primaryCtx: CallerContext = { agent: "dev-lifecycle", sessionID: "sess_root" }

const ALL_ROLES: CallerRole[] = ["primary", "developer", "architect", "reviewer", "goal-verify"]

describe("rolesForTool — 工具×角色矩阵（spec §2.2 / PRD R4）", () => {
  it("枚举 5 个生命周期工具", () => {
    expect(LIFECYCLE_TOOLS).toEqual([
      "setup_control",
      "flow_control",
      "task_control",
      "tdd_checkpoint",
      "release_control",
    ])
  })

  it("primary 全通过：5 个工具全部允许", () => {
    for (const tool of LIFECYCLE_TOOLS) {
      expect(rolesForTool(tool)).toContain("primary")
    }
  })

  it("developer 仅 tdd_checkpoint", () => {
    for (const tool of LIFECYCLE_TOOLS) {
      const allowed = rolesForTool(tool).includes("developer")
      expect(allowed).toBe(tool === "tdd_checkpoint")
    }
  })

  it("reviewer 无任何工具", () => {
    for (const tool of LIFECYCLE_TOOLS) {
      expect(rolesForTool(tool)).not.toContain("reviewer")
    }
  })

  it("goal-verify 无默认工具权限（仅通过 op 覆盖获得 complete-flow）", () => {
    for (const tool of LIFECYCLE_TOOLS) {
      expect(rolesForTool(tool)).not.toContain("goal-verify")
    }
  })

  it("architect 无默认工具权限（仅通过 op 覆盖获得 status 只读）", () => {
    for (const tool of LIFECYCLE_TOOLS) {
      expect(rolesForTool(tool)).not.toContain("architect")
    }
  })

  it("flow_control.complete-flow 仅 goal-verify", () => {
    expect(rolesForTool("flow_control", "complete-flow")).toEqual(["goal-verify"])
  })

  it("flow_control.status 允许 primary + architect（architect 只读）", () => {
    expect(rolesForTool("flow_control", "status")).toEqual(["primary", "architect"])
  })

  it("未知工具保守拒绝：返回空角色集", () => {
    expect(rolesForTool("unknown_tool")).toEqual([])
  })
})

describe("requireToolCaller — 5 工具 × 5 角色全组合", () => {
  const client = sessionClient({ sess_child: "parent", sess_root: null })

  it.each(ALL_ROLES)("primary 角色调用全部工具通过", async role => {
    // primary 由无 parentID 的 session 解析
    const ctx: CallerContext = { agent: "dev-lifecycle", sessionID: "sess_root" }
    for (const tool of LIFECYCLE_TOOLS) {
      await expect(requireToolCaller(ctx, tool, undefined, client)).resolves.toBeNull()
    }
  })

  it.each(ALL_ROLES.filter(r => r !== "primary"))("非 primary 角色 %s 仅按矩阵放行", async role => {
    const agentByRole: Record<string, string> = {
      developer: "developer",
      architect: "architect",
      reviewer: "reviewer",
      "goal-verify": "goal-verify",
    }
    const ctx = childCtx(agentByRole[role])
    for (const tool of LIFECYCLE_TOOLS) {
      const expectedAllow = rolesForTool(tool).includes(role)
      const result = await requireToolCaller(ctx, tool, undefined, client)
      if (expectedAllow) {
        expect(result).toBeNull()
      } else {
        expect(result).not.toBeNull()
        expect(result).toContain("CALLER_NOT_AUTHORIZED")
      }
    }
  })

  it("goal-verify 仅 flow_control.complete-flow 通过", async () => {
    const ctx = childCtx("goal-verify")
    await expect(requireToolCaller(ctx, "flow_control", "complete-flow", client)).resolves.toBeNull()
    await expect(requireToolCaller(ctx, "flow_control", "stage-start", client)).resolves.not.toBeNull()
    await expect(requireToolCaller(ctx, "task_control", "create-task", client)).resolves.not.toBeNull()
  })

  it("architect 仅 flow_control.status 通过（其余工具与 op 拒绝）", async () => {
    const ctx = childCtx("architect")
    await expect(requireToolCaller(ctx, "flow_control", "status", client)).resolves.toBeNull()
    await expect(requireToolCaller(ctx, "flow_control", "create-flow", client)).resolves.not.toBeNull()
    await expect(requireToolCaller(ctx, "task_control", "create-task", client)).resolves.not.toBeNull()
    await expect(requireToolCaller(ctx, "tdd_checkpoint", "red", client)).resolves.not.toBeNull()
  })

  it("developer 仅 tdd_checkpoint 通过", async () => {
    const ctx = childCtx("developer")
    await expect(requireToolCaller(ctx, "tdd_checkpoint", "red", client)).resolves.toBeNull()
    await expect(requireToolCaller(ctx, "task_control", "create-task", client)).resolves.not.toBeNull()
    await expect(requireToolCaller(ctx, "setup_control", "probe", client)).resolves.not.toBeNull()
  })

  it("reviewer 全部拒绝（无工具）", async () => {
    const ctx = childCtx("reviewer")
    for (const tool of LIFECYCLE_TOOLS) {
      await expect(requireToolCaller(ctx, tool, undefined, client)).resolves.not.toBeNull()
    }
  })
})

import { describe, it, expect, vi } from "vitest"
import {
  OPENCODE_GOAL_RPC,
  createBuiltinGoalReader,
  handleExperimentalIdle,
} from "../../src/plugin/builtin-goal.js"

describe("builtin-goal (OpenCode v2.3 opencode.goal RPC)", () => {
  it("exposes the opencode.goal RPC definition matching OpenCode v2.3 schema", () => {
    expect(OPENCODE_GOAL_RPC.id).toBe("opencode.goal")
    expect(OPENCODE_GOAL_RPC.methods).toHaveProperty("get")
    expect(OPENCODE_GOAL_RPC.events).toHaveProperty("changed")
  })

  it("queries opencode.goal.get and caches active/paused/null state", async () => {
    const getMock = vi.fn(async ({ sessionID }: { sessionID: string }) =>
      sessionID === "s1" ? { id: "g1", objective: "Finish flow", status: "active", rounds: 1, maxRounds: 20, boot: "b1", updatedAt: 1 } : null,
    )
    const ctx = {
      rpc: vi.fn(() => ({
        get: getMock,
        events: { subscribe: vi.fn(async function* () {}) },
      })),
    }

    const reader = createBuiltinGoalReader(ctx as never)
    expect(await reader.isGoalActive("s1")).toBe(true)
    // Cached on second read
    expect(await reader.isGoalActive("s1")).toBe(true)
    expect(getMock).toHaveBeenCalledTimes(1)

    expect(await reader.isGoalActive("s2")).toBe(false)
  })

  it("updates cache live when opencode.goal changed events arrive", async () => {
    async function* fakeEvents() {
      yield { type: "rpc.opencode.goal.changed", data: { sessionID: "s1", goal: { status: "active" } } }
      yield { type: "rpc.opencode.goal.changed", data: { sessionID: "s1", goal: { status: "paused" } } }
    }
    const getMock = vi.fn(async () => null)
    const ctx = {
      rpc: vi.fn(() => ({
        get: getMock,
        events: { subscribe: () => fakeEvents() },
      })),
    }

    const reader = createBuiltinGoalReader(ctx as never)
    const ac = new AbortController()
    await reader.watchEvents(ac.signal)

    expect(await reader.isGoalActive("s1")).toBe(false)
    expect(getMock).not.toHaveBeenCalled()
  })

  it("fails safe (returns false) when host does not expose opencode.goal RPC", async () => {
    const ctx = {
      rpc: vi.fn(() => ({
        get: vi.fn(async () => {
          throw new Error("RPC plugin opencode.goal not found")
        }),
        events: { subscribe: vi.fn(async function* () {}) },
      })),
    }

    const reader = createBuiltinGoalReader(ctx as never)
    expect(await reader.isGoalActive("s1")).toBe(false)
  })

  it("handleExperimentalIdle skips when background jobs exist or built-in goal is active", async () => {
    const reader = {
      isGoalActive: vi.fn(async (id: string) => id === "s-active"),
    }

    const bg = await handleExperimentalIdle(reader, {
      sessionID: "s-idle",
      background: [{ kind: "subagent", sessionID: "s-idle", childSessionID: "c1", agent: "developer", description: "coding" }],
    })
    expect(bg).toEqual({ skipped: true, reason: "background-running" })
    expect(reader.isGoalActive).not.toHaveBeenCalled()

    const active = await handleExperimentalIdle(reader, {
      sessionID: "s-active",
      background: [],
    })
    expect(active).toEqual({ skipped: true, reason: "builtin-goal-active" })

    const idle = await handleExperimentalIdle(reader, {
      sessionID: "s-none",
      background: [],
    })
    expect(idle).toEqual({ skipped: false, reason: "idle" })
  })
})

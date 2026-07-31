import { describe, it, expect } from "vitest"
import {
  resolveCaller,
  requireCaller,
  CALLER_NOT_AUTHORIZED,
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

const ctx = (agent: string, sessionID = "sess_x"): CallerContext => ({ agent, sessionID })

describe("resolveCaller", () => {
  it("resolves a session without parentID as primary regardless of agent name", async () => {
    const client = sessionClient({ sess_x: null })
    await expect(resolveCaller(ctx("dev-lifecycle"), client)).resolves.toBe("primary")
    await expect(resolveCaller(ctx("developer"), client)).resolves.toBe("primary")
  })

  it("resolves child sessions by agent name", async () => {
    const client = sessionClient({ sess_x: "parent" })
    await expect(resolveCaller(ctx("developer"), client)).resolves.toBe("developer")
    await expect(resolveCaller(ctx("architect"), client)).resolves.toBe("architect")
    await expect(resolveCaller(ctx("reviewer"), client)).resolves.toBe("reviewer")
    await expect(resolveCaller(ctx("goal-verify"), client)).resolves.toBe("goal-verify")
  })

  it("treats an unknown child agent conservatively as reviewer", async () => {
    const client = sessionClient({ sess_x: "parent" })
    await expect(resolveCaller(ctx("some-unknown-agent"), client)).resolves.toBe("reviewer")
  })

  it("fails closed to reviewer when session query throws", async () => {
    const client: CallerSessionClient = {
      session: {
        async get() {
          throw new Error("session.get failed")
        },
      },
    }
    await expect(resolveCaller(ctx("dev-lifecycle"), client)).resolves.toBe("reviewer")
  })

  it("fails closed to reviewer when session query returns no data", async () => {
    const client: CallerSessionClient = {
      session: {
        async get() {
          return {} as { data?: { parentID?: string | null } }
        },
      },
    }
    await expect(resolveCaller(ctx("dev-lifecycle"), client)).resolves.toBe("reviewer")
  })

  it("fails closed to reviewer when session query returns an error payload", async () => {
    const client: CallerSessionClient = {
      session: {
        async get() {
          return { error: "not found" } as unknown as { data?: { parentID?: string | null } }
        },
      },
    }
    await expect(resolveCaller(ctx("dev-lifecycle"), client)).resolves.toBe("reviewer")
  })
})

describe("requireCaller", () => {
  it("returns null when the resolved role is allowed", async () => {
    const client = sessionClient({ sess_x: null })
    await expect(requireCaller(ctx("dev-lifecycle"), ["primary"], "probe", client)).resolves.toBeNull()
  })

  it("returns a CALLER_NOT_AUTHORIZED message when the role is not allowed", async () => {
    const client = sessionClient({ sess_x: "parent" })
    const denied = await requireCaller(ctx("developer"), ["primary"], "probe", client)
    expect(denied).not.toBeNull()
    expect(denied).toContain(CALLER_NOT_AUTHORIZED)
    expect(denied).toContain("probe")
    expect(denied).toContain("primary")
  })

  it("denies when the agent name is unknown even in a primary session scope check", async () => {
    const client = sessionClient({ sess_x: "parent" })
    const denied = await requireCaller(ctx("ghost"), ["primary"], "generate-workflows", client)
    expect(denied).toContain(CALLER_NOT_AUTHORIZED)
  })
})

/**
 * 对抗测试 #9 — 双 session 抢占同一 Flow：
 * 一个 Flow 已被 active session 绑定时，另一 session 调用 bindSession 必须拒绝
 * （FLOW_SESSION_CONFLICT）；takeover 必须显式确认（TAKEOVER_NOT_CONFIRMED）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { bindSession, takeoverSession, writeIndex, readIndex, type SessionIndex } from "../../src/kernel/session-index.js"

let projectDir: string

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "cabbage-adv-session-"))
})

afterEach(async () => {
  await rm(projectDir, { recursive: true, force: true })
})

const activeIndex = (sessionID: string): SessionIndex => ({
  flows: { "12": { sessionID, status: "active", continuationCount: 0, updatedAt: 0 } },
})

describe("adversarial #9 — 双 session 抢占必须被拒", () => {
  it("另一 active session 已绑定 → FLOW_SESSION_CONFLICT，绑定不变", async () => {
    await writeIndex(projectDir, activeIndex("sess-A"))
    const result = await bindSession(projectDir, 12, "sess-B")
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("FLOW_SESSION_CONFLICT")

    const index = await readIndex(projectDir)
    expect(index.flows["12"].sessionID).toBe("sess-A")
  })

  it("同一 session 重复绑定幂等通过（自续绑不视为冲突）", async () => {
    await writeIndex(projectDir, activeIndex("sess-A"))
    const result = await bindSession(projectDir, 12, "sess-A")
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.entry.sessionID).toBe("sess-A")
  })

  it("takeover 未确认 → TAKEOVER_NOT_CONFIRMED，旧绑定保持 active", async () => {
    await writeIndex(projectDir, activeIndex("sess-A"))
    const result = await takeoverSession(projectDir, 12, "sess-B", false)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe("TAKEOVER_NOT_CONFIRMED")

    const index = await readIndex(projectDir)
    expect(index.flows["12"]).toMatchObject({ sessionID: "sess-A", status: "active" })
  })

  it("takeover 确认后旧 session 置 paused、新 session 绑定", async () => {
    await writeIndex(projectDir, activeIndex("sess-A"))
    const result = await takeoverSession(projectDir, 12, "sess-B", true)
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.entry.sessionID).toBe("sess-B")

    const index = await readIndex(projectDir)
    expect(index.flows["12"]).toMatchObject({ sessionID: "sess-B", status: "active" })
    expect(index.flows["12"].status).toBe("active")
  })
})

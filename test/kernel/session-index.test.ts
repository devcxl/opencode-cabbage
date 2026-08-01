import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, readFile, rm, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  bindSession,
  getFlowSession,
  readIndex,
  sessionIndexPath,
  takeoverSession,
  unbindSession,
  updateFlowSession,
  writeIndex,
  type SessionIndex,
} from "../../src/kernel/session-index.js"

let tmpDirs: string[] = []

async function makeProjectDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "session-index-test-"))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tmpDirs.map(dir => rm(dir, { recursive: true, force: true })))
  tmpDirs = []
})

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

function entry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    sessionID: "sess_abc",
    status: "active",
    continuationCount: 0,
    updatedAt: 1754000000000,
    ...overrides,
  }
}

describe("sessionIndexPath", () => {
  it("指向 .opencode/opencode-cabbage/session-index.json", () => {
    expect(sessionIndexPath("/proj")).toBe(path.join("/proj", ".opencode", "opencode-cabbage", "session-index.json"))
  })
})

describe("并发安全（KeyedMutex 串行化 read-modify-write）", () => {
  it("并发绑定不同 flow：两条绑定都不丢失", async () => {
    const dir = await makeProjectDir()
    await Promise.all([
      bindSession(dir, 1, "sess_a"),
      bindSession(dir, 2, "sess_b"),
      bindSession(dir, 3, "sess_c"),
    ])
    const index = await readIndex(dir)
    expect(Object.keys(index.flows).sort()).toEqual(["1", "2", "3"])
    expect(getFlowSession(index, 1)?.sessionID).toBe("sess_a")
    expect(getFlowSession(index, 2)?.sessionID).toBe("sess_b")
    expect(getFlowSession(index, 3)?.sessionID).toBe("sess_c")
  })

  it("并发绑定 + 更新同一 flow：最终状态一致且不丢失 entry", async () => {
    const dir = await makeProjectDir()
    await bindSession(dir, 7, "sess_x")
    await Promise.all([
      updateFlowSession(dir, 7, { continuationCount: 1 }),
      updateFlowSession(dir, 7, { continuationCount: 2 }),
      updateFlowSession(dir, 7, { continuationCount: 3 }),
    ])
    const index = await readIndex(dir)
    const flow = getFlowSession(index, 7)
    expect(flow).not.toBeNull()
    expect(flow?.continuationCount).toBe(3)
  })

  it("updateFlowSession 拒绝非法 status", async () => {
    const dir = await makeProjectDir()
    await bindSession(dir, 7, "sess_x")
    const result = await updateFlowSession(dir, 7, { status: "bogus" as never })
    expect(result).toBeNull()
    const index = await readIndex(dir)
    expect(getFlowSession(index, 7)?.status).toBe("active")
  })
})

describe("readIndex", () => {
  it("索引文件不存在时返回空索引", async () => {
    const dir = await makeProjectDir()
    expect(await readIndex(dir)).toEqual({ flows: {} })
  })

  it("索引文件内容损坏时返回空索引", async () => {
    const dir = await makeProjectDir()
    const p = sessionIndexPath(dir)
    const { mkdir, writeFile } = await import("node:fs/promises")
    await mkdir(path.dirname(p), { recursive: true })
    await writeFile(p, "not json{{{", "utf8")
    expect(await readIndex(dir)).toEqual({ flows: {} })
  })

  it("索引文件结构不合法（flows 缺失）时返回空索引", async () => {
    const dir = await makeProjectDir()
    const p = sessionIndexPath(dir)
    const { mkdir, writeFile } = await import("node:fs/promises")
    await mkdir(path.dirname(p), { recursive: true })
    await writeFile(p, JSON.stringify({ other: true }), "utf8")
    expect(await readIndex(dir)).toEqual({ flows: {} })
  })
})

describe("writeIndex / readIndex 往返", () => {
  it("写入后可读回相同内容", async () => {
    const dir = await makeProjectDir()
    const index: SessionIndex = {
      flows: { "12": entry() as never },
    }
    await writeIndex(dir, index)
    expect(await readIndex(dir)).toEqual(index)
  })

  it("原子写：不残留 .tmp 临时文件", async () => {
    const dir = await makeProjectDir()
    await writeIndex(dir, { flows: { "1": entry() as never } })
    expect(await fileExists(sessionIndexPath(dir))).toBe(true)
    expect(await fileExists(`${sessionIndexPath(dir)}.tmp`)).toBe(false)
  })

  it("重复写入覆盖旧索引", async () => {
    const dir = await makeProjectDir()
    await writeIndex(dir, { flows: { "1": entry() as never } })
    await writeIndex(dir, { flows: { "2": entry({ sessionID: "sess_2" }) as never } })
    const index = await readIndex(dir)
    expect(index.flows["1"]).toBeUndefined()
    expect(index.flows["2"]?.sessionID).toBe("sess_2")
  })
})

describe("getFlowSession", () => {
  it("返回已绑定 flow 的 entry", () => {
    const index: SessionIndex = { flows: { "12": entry() as never } }
    expect(getFlowSession(index, 12)?.sessionID).toBe("sess_abc")
  })

  it("未绑定 flow 返回 null", () => {
    expect(getFlowSession({ flows: {} }, 12)).toBeNull()
  })
})

describe("bindSession", () => {
  it("未绑定 flow：绑定成功，status=active", async () => {
    const dir = await makeProjectDir()
    const result = await bindSession(dir, 12, "sess_new")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry.sessionID).toBe("sess_new")
    expect(result.entry.status).toBe("active")
    expect(result.entry.continuationCount).toBe(0)
    const index = await readIndex(dir)
    expect(index.flows["12"]?.sessionID).toBe("sess_new")
  })

  it("同一 session 重复绑定：幂等成功并保留 continuationCount", async () => {
    const dir = await makeProjectDir()
    await bindSession(dir, 12, "sess_a")
    await updateFlowSession(dir, 12, { continuationCount: 5 })
    const result = await bindSession(dir, 12, "sess_a")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry.continuationCount).toBe(5)
  })

  it("另一 active session 绑定同一 flow：拒绝 FLOW_SESSION_CONFLICT", async () => {
    const dir = await makeProjectDir()
    await bindSession(dir, 12, "sess_active")
    const result = await bindSession(dir, 12, "sess_other")
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("FLOW_SESSION_CONFLICT")
    expect(result.message).toContain("sess_active")
  })

  it("旧 session 非 active（paused/completed/cancelled）：允许覆盖绑定", async () => {
    const dir = await makeProjectDir()
    await bindSession(dir, 12, "sess_old")
    await updateFlowSession(dir, 12, { status: "paused" })
    const result = await bindSession(dir, 12, "sess_new")
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry.sessionID).toBe("sess_new")
    expect(result.entry.continuationCount).toBe(0)
  })
})

describe("takeoverSession", () => {
  it("另一 active session 且未确认：拒绝 TAKEOVER_NOT_CONFIRMED", async () => {
    const dir = await makeProjectDir()
    await bindSession(dir, 12, "sess_old")
    const result = await takeoverSession(dir, 12, "sess_new", false)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe("TAKEOVER_NOT_CONFIRMED")
    expect(result.message).toContain("sess_old")
  })

  it("另一 active session 且已确认：新 session 接管绑定（索引只保留当前绑定），旧 sessionID 被替换", async () => {
    const dir = await makeProjectDir()
    await bindSession(dir, 12, "sess_old")
    const result = await takeoverSession(dir, 12, "sess_new", true)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry.sessionID).toBe("sess_new")
    expect(result.entry.status).toBe("active")
    const index = await readIndex(dir)
    expect(index.flows["12"]?.sessionID).toBe("sess_new")
    expect(index.flows["12"]?.status).toBe("active")
    // 旧 session 置 paused 由 flow_control 写入旧 session goal metadata，索引不再保留旧 sessionID
    expect(index.flows["12"]?.sessionID).not.toBe("sess_old")
  })

  it("新 session 已是绑定 session：幂等成功（无需确认）", async () => {
    const dir = await makeProjectDir()
    await bindSession(dir, 12, "sess_a")
    const result = await takeoverSession(dir, 12, "sess_a", false)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry.sessionID).toBe("sess_a")
    expect(result.entry.status).toBe("active")
  })

  it("未绑定 flow：直接绑定成功（无需确认）", async () => {
    const dir = await makeProjectDir()
    const result = await takeoverSession(dir, 12, "sess_new", false)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry.sessionID).toBe("sess_new")
  })

  it("旧 session 非 active：接管无需确认", async () => {
    const dir = await makeProjectDir()
    await bindSession(dir, 12, "sess_old")
    await updateFlowSession(dir, 12, { status: "paused" })
    const result = await takeoverSession(dir, 12, "sess_new", false)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.entry.sessionID).toBe("sess_new")
  })
})

describe("updateFlowSession", () => {
  it("更新 status 与 continuationCount 并刷新 updatedAt", async () => {
    const dir = await makeProjectDir()
    await bindSession(dir, 12, "sess_a")
    const updated = await updateFlowSession(dir, 12, { status: "paused", continuationCount: 3 })
    expect(updated?.status).toBe("paused")
    expect(updated?.continuationCount).toBe(3)
    const index = await readIndex(dir)
    expect(index.flows["12"]?.status).toBe("paused")
    expect(index.flows["12"]?.continuationCount).toBe(3)
  })

  it("flow 未绑定时返回 null 且不创建 entry", async () => {
    const dir = await makeProjectDir()
    expect(await updateFlowSession(dir, 99, { status: "paused" })).toBeNull()
    expect((await readIndex(dir)).flows["99"]).toBeUndefined()
  })
})

describe("unbindSession", () => {
  it("sessionID 匹配：删除 entry 返回 true", async () => {
    const dir = await makeProjectDir()
    await bindSession(dir, 12, "sess_a")
    expect(await unbindSession(dir, 12, "sess_a")).toBe(true)
    expect((await readIndex(dir)).flows["12"]).toBeUndefined()
  })

  it("sessionID 不匹配：不动索引返回 false", async () => {
    const dir = await makeProjectDir()
    await bindSession(dir, 12, "sess_a")
    expect(await unbindSession(dir, 12, "sess_other")).toBe(false)
    expect((await readIndex(dir)).flows["12"]?.sessionID).toBe("sess_a")
  })
})

import { afterEach, describe, expect, it } from "vitest"
import { mkdtemp, readdir, rm, access } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  bindSession,
  readIndex,
  sessionIndexPath,
  updateFlowSession,
  writeIndex,
  type FlowSessionEntry,
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

function entry(overrides: Partial<FlowSessionEntry> = {}): FlowSessionEntry {
  return {
    sessionID: "sess_abc",
    ...overrides,
  }
}

describe("sessionIndexPath", () => {
  it("指向 .opencode/opencode-cabbage/session-index.json", () => {
    expect(sessionIndexPath("/proj")).toBe(path.join("/proj", ".opencode", "opencode-cabbage", "session-index.json"))
  })
})

describe("并发安全（KeyedMutex 串行化 read-modify-write）", () => {
  it("并发绑定不同 flow：三条绑定都不丢失", async () => {
    const dir = await makeProjectDir()
    await Promise.all([
      bindSession(dir, 1, "sess_a"),
      bindSession(dir, 2, "sess_b"),
      bindSession(dir, 3, "sess_c"),
    ])
    const index = await readIndex(dir)
    expect(Object.keys(index.flows).sort()).toEqual(["1", "2", "3"])
    expect(index.flows["1"]?.sessionID).toBe("sess_a")
    expect(index.flows["2"]?.sessionID).toBe("sess_b")
    expect(index.flows["3"]?.sessionID).toBe("sess_c")
  })

  it("并发更新同一 flow：串行落盘，不丢失 entry", async () => {
    const dir = await makeProjectDir()
    await bindSession(dir, 7, "sess_x")
    await Promise.all([
      updateFlowSession(dir, 7, { lastContinuedAt: 1 }),
      updateFlowSession(dir, 7, { lastContinuedAt: 2 }),
      updateFlowSession(dir, 7, { lastContinuedAt: 3 }),
    ])
    const index = await readIndex(dir)
    const flow = index.flows["7"]
    expect(flow).toBeDefined()
    expect(flow?.sessionID).toBe("sess_x")
    // 三次更新串行执行，最后一次写入的值生效
    expect(flow?.lastContinuedAt).toBe(3)
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

  it("旧格式 entry 的多余字段（status/continuationCount/updatedAt）被读取忽略，无需迁移", async () => {
    const dir = await makeProjectDir()
    const p = sessionIndexPath(dir)
    const { mkdir, writeFile } = await import("node:fs/promises")
    await mkdir(path.dirname(p), { recursive: true })
    await writeFile(p, JSON.stringify({
      flows: {
        "42": {
          sessionID: "sess_legacy",
          status: "paused",
          continuationCount: 5,
          updatedAt: 1754000000000,
          lastContinuedAt: 1754000000000,
        },
      },
    }), "utf8")
    const index = await readIndex(dir)
    expect(index.flows["42"]?.sessionID).toBe("sess_legacy")
    expect(index.flows["42"]?.lastContinuedAt).toBe(1754000000000)
  })
})

describe("writeIndex / readIndex 往返", () => {
  it("写入后可读回相同内容", async () => {
    const dir = await makeProjectDir()
    const index: SessionIndex = {
      flows: { "12": entry({ lastContinuedAt: 1754000000000 }) },
    }
    await writeIndex(dir, index)
    expect(await readIndex(dir)).toEqual(index)
  })

  it("原子写：不残留 .tmp 临时文件", async () => {
    const dir = await makeProjectDir()
    await writeIndex(dir, { flows: { "1": entry() } })
    expect(await fileExists(sessionIndexPath(dir))).toBe(true)
    // 实现写入 `${target}.${pid}.tmp` 后 rename；扫描目录确认无任何 *.tmp 残留
    const files = await readdir(path.dirname(sessionIndexPath(dir)))
    expect(files.filter(f => f.endsWith(".tmp"))).toEqual([])
  })

  it("重复写入覆盖旧索引", async () => {
    const dir = await makeProjectDir()
    await writeIndex(dir, { flows: { "1": entry() } })
    await writeIndex(dir, { flows: { "2": entry({ sessionID: "sess_2" }) } })
    const index = await readIndex(dir)
    expect(index.flows["1"]).toBeUndefined()
    expect(index.flows["2"]?.sessionID).toBe("sess_2")
  })
})

describe("bindSession", () => {
  it("绑定成功：只写入 sessionID", async () => {
    const dir = await makeProjectDir()
    await bindSession(dir, 12, "sess_new")
    const index = await readIndex(dir)
    expect(index.flows["12"]).toEqual({ sessionID: "sess_new" })
  })

  it("同一 session 重复绑定：幂等", async () => {
    const dir = await makeProjectDir()
    await bindSession(dir, 12, "sess_a")
    await bindSession(dir, 12, "sess_a")
    const index = await readIndex(dir)
    expect(index.flows["12"]).toEqual({ sessionID: "sess_a" })
  })

  it("另一 session 绑定同一 flow：覆盖旧绑定（无双 session 强制）", async () => {
    const dir = await makeProjectDir()
    await bindSession(dir, 12, "sess_active")
    await bindSession(dir, 12, "sess_other")
    const index = await readIndex(dir)
    expect(index.flows["12"]).toEqual({ sessionID: "sess_other" })
  })
})

describe("updateFlowSession", () => {
  it("更新 lastContinuedAt 且保留绑定", async () => {
    const dir = await makeProjectDir()
    await bindSession(dir, 12, "sess_a")
    const updated = await updateFlowSession(dir, 12, { lastContinuedAt: 1754000000000 })
    expect(updated?.sessionID).toBe("sess_a")
    expect(updated?.lastContinuedAt).toBe(1754000000000)
    const index = await readIndex(dir)
    expect(index.flows["12"]).toEqual({ sessionID: "sess_a", lastContinuedAt: 1754000000000 })
  })

  it("flow 未绑定时返回 null 且不创建 entry", async () => {
    const dir = await makeProjectDir()
    expect(await updateFlowSession(dir, 99, { lastContinuedAt: Date.now() })).toBeNull()
    expect((await readIndex(dir)).flows["99"]).toBeUndefined()
  })
})

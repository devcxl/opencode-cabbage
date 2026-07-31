/**
 * 对抗测试 #1 — 坏 slug（低质量模型典型输入）：
 * `Task 001` / `task-1` / `implement-task` / 纯序号等必须被 validateTitle 拒绝，
 * 且 create-flow / create-task 工具不得继续创建（返回对应错误码，不做任何 gh 写调用）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validateTitle, deriveSlug } from "../../src/kernel/slug.js"
import { createFlow } from "../../src/kernel/flow.js"
import { createFlowControlTool } from "../../src/plugin/flow-control.js"
import { createTaskControlTool } from "../../src/plugin/task-control.js"
import { setFlowGhExecutor } from "../../src/kernel/flow.js"
import { setRecordsGhExecutor } from "../../src/kernel/records.js"
import { setTaskGhExecutor, setTaskGitExecutor } from "../../src/kernel/task.js"

const BAD_TITLES: Array<{ title: string; code: string }> = [
  { title: "Task 001", code: "INVALID_FORMAT" },
  { title: "task-1", code: "GENERIC_TITLE" },
  { title: "implement-task", code: "GENERIC_TITLE" },
  { title: "fix-bug", code: "GENERIC_TITLE" },
  { title: "123", code: "GENERIC_TITLE" },
  { title: "Validate-execution-binding", code: "INVALID_FORMAT" },
]

const primaryClient = {
  session: {
    get: async () => ({ data: { parentID: null } }),
    update: async () => {},
  },
}

function makeCtx(agent: string, sessionID: string) {
  return { agent, sessionID, messageID: "m1", directory: ".", worktree: "." }
}

describe("adversarial #1 — 坏 slug 必须被拒绝", () => {
  beforeEach(() => {
    // 所有 gh/git 写调用都必须抛错：若校验失效会走到真实写路径 → 测试失败
    setFlowGhExecutor(() => {
      throw new Error("unexpected flow gh: gate should reject before any call")
    })
    setRecordsGhExecutor(() => {
      throw new Error("unexpected records gh: gate should reject before any call")
    })
    setTaskGhExecutor(() => {
      throw new Error("unexpected task gh: gate should reject before any call")
    })
    setTaskGitExecutor(() => {
      throw new Error("unexpected task git: gate should reject before any call")
    })
  })

  afterEach(() => {
    setFlowGhExecutor(null)
    setRecordsGhExecutor(null)
    setTaskGhExecutor(null)
    setTaskGitExecutor(null)
  })

  it.each(BAD_TITLES)("validateTitle 拒绝 %s → %s", ({ title, code }) => {
    const result = validateTitle(title)
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(code)
    }
  })

  it("deriveSlug 对无意义输入返回空串（调用方据此判定，不做兜底）", () => {
    expect(deriveSlug("Task 001")).toBe("task-001")
    expect(deriveSlug("!!!")).toBe("")
  })

  it("createFlow（kernel 层）对坏标题返回对应错误码且不写任何 gh", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cabbage-adv-slug-"))
    try {
      const result = await createFlow({ projectDir: dir, title: "Task 001", sessionID: "s" })
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe("INVALID_FORMAT")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("create-flow 工具拒绝坏标题（INVALID_FORMAT）", async () => {
    const t = createFlowControlTool({ projectDir: ".", sessionClient: primaryClient })
    const out = await t.execute({ op: "create-flow", title: "implement-task" }, makeCtx("dev-lifecycle", "sess-1") as never)
    const resp = JSON.parse(String(out)) as { ok: boolean; error?: { code: string } }
    expect(resp.ok).toBe(false)
    expect(resp.error?.code).toBe("GENERIC_TITLE")
  })

  it("create-task 工具拒绝坏标题（INVALID_FORMAT）且不做任何 gh 写调用", async () => {
    const t = createTaskControlTool({ projectDir: ".", sessionClient: primaryClient })
    const out = await t.execute(
      { op: "create-task", parent_issue_number: 12, title: "Task 001" },
      makeCtx("dev-lifecycle", "sess-1") as never,
    )
    const resp = JSON.parse(String(out)) as { ok: boolean; error?: { code: string } }
    expect(resp.ok).toBe(false)
    expect(resp.error?.code).toBe("INVALID_FORMAT")
  })
})

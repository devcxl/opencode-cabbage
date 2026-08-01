/**
 * 对抗测试 #4 — RED 阶段改实现文件：
 * 低质量模型在 RED 阶段提前动实现（相对 cycle 基线）→ tdd_checkpoint red 必须拒绝
 * （IMPL_CHANGED_IN_RED），不落任何 evidence。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createTddCheckpointTool, setTddCheckpointGhExecutor } from "../../src/plugin/tdd-checkpoint.js"
import { setRecordsGhExecutor } from "../../src/kernel/records.js"
import { executeRedCheck } from "../../src/kernel/tdd/adapter.js"
import { computeWorkspaceDigest } from "../../src/kernel/tdd/digest.js"
import {
  BASELINE_IMPL,
  CHANGED_IMPL,
  INPUT_DIGEST,
  makeRun,
  makeRecordsState,
  makeTaskBody,
  makeSessionClient,
  makeCtx,
  resetDigestMocks,
} from "./tdd-helpers.js"

vi.mock("../../src/kernel/tdd/adapter.js", () => ({ executeRedCheck: vi.fn() }))
vi.mock("../../src/kernel/tdd/digest.js", () => ({ computeWorkspaceDigest: vi.fn() }))

let projectDir: string
let recordsState: ReturnType<typeof makeRecordsState>

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "cabbage-adv-tdd-red-"))
  recordsState = makeRecordsState()
  setRecordsGhExecutor(recordsState.ghFn)
  setTddCheckpointGhExecutor(async (args: string) => {
    if (args.startsWith("issue list --state all --limit 100 --json number,title,parent")) return { stdout: "77", stderr: "" }
    if (args.startsWith("issue view 77")) return { stdout: makeTaskBody(), stderr: "" }
    throw new Error(`unexpected tdd gh: ${args}`)
  })
  resetDigestMocks()
})

afterEach(async () => {
  setRecordsGhExecutor(null)
  setTddCheckpointGhExecutor(null)
  await rm(projectDir, { recursive: true, force: true })
})

async function runTool(args: Record<string, unknown>, role: "developer" | "primary" = "developer") {
  const t = createTddCheckpointTool({ projectDir, sessionClient: makeSessionClient(role) })
  const agent = role === "primary" ? "dev-lifecycle" : "developer"
  const out = await t.execute(args as never, makeCtx(agent) as never)
  return JSON.parse(String(out)) as Record<string, any>
}

async function setupCycle() {
  vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(BASELINE_IMPL)
  const start = await runTool({
    op: "cycle-start",
    parent_issue_number: 12,
    task_id: "tdd-checkpoint-tool",
    cycle_id: "cycle-1",
    criterion_id: "AC-1",
    test_paths: ["test/foo.test.ts"],
    test_selector: "test/foo.test.ts",
  })
  expect(start.ok).toBe(true)
}

describe("adversarial #4 — RED 阶段改实现文件必须被拒", () => {
  it("实现 digest 相对基线变化 → IMPL_CHANGED_IN_RED，且不写入 evidence", async () => {
    await setupCycle()

    vi.mocked(executeRedCheck).mockResolvedValueOnce(makeRun())
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(INPUT_DIGEST).mockResolvedValueOnce(CHANGED_IMPL)
    const resp = await runTool({
      op: "red",
      parent_issue_number: 12,
      task_id: "tdd-checkpoint-tool",
      cycle_id: "cycle-1",
      test_selector: "test/foo.test.ts",
    })

    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("IMPL_CHANGED_IN_RED")
    // 拒绝时不追加 RED evidence：仅 cycle-start 写入的一条 comment，且不含 red 块
    expect(recordsState.comments).toHaveLength(1)
    expect(recordsState.comments[0].body).not.toContain("stage: red")
  })

  it("模型谎报 RED 也无法掩盖实现文件变化（digest 由工具亲自计算）", async () => {
    await setupCycle()
    vi.mocked(executeRedCheck).mockResolvedValueOnce(makeRun())
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(INPUT_DIGEST).mockResolvedValueOnce(CHANGED_IMPL)
    const resp = await runTool({
      op: "red",
      parent_issue_number: 12,
      task_id: "tdd-checkpoint-tool",
      cycle_id: "cycle-1",
      test_selector: "test/foo.test.ts",
    })
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("IMPL_CHANGED_IN_RED")
  })
})

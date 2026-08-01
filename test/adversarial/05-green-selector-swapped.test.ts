/**
 * 对抗测试 #5 — RED 后偷换测试 selector：
 * 低质量模型 RED 用一个测试、GREEN 换另一个测试/改配置（executionInputDigest 变化）
 * → tdd_checkpoint green 必须拒绝（SELECTOR_SWAPPED），不写入 GREEN evidence。
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
  OTHER_INPUT,
  makeRun,
  passingRun,
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
  projectDir = await mkdtemp(join(tmpdir(), "cabbage-adv-tdd-green-"))
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

/** 完成 cycle-start → red（RED 证据以 INPUT_DIGEST 落盘） */
async function setupRedCycle() {
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
  if (!start.ok) throw new Error(`cycle-start failed: ${start.error?.message}`)

  vi.mocked(executeRedCheck).mockResolvedValueOnce(makeRun())
  vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(INPUT_DIGEST).mockResolvedValueOnce(BASELINE_IMPL)
  return runTool({ op: "red", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", cycle_id: "cycle-1", test_selector: "test/foo.test.ts" })
}

describe("adversarial #5 — GREEN 偷换测试 selector 必须被拒", () => {
  it("执行输入 digest 与 RED 不一致 → SELECTOR_SWAPPED，不写入 GREEN evidence", async () => {
    const redResp = await setupRedCycle()
    expect(redResp.ok).toBe(true)

    // 换一个测试文件/配置（digest 不同），即便测试通过也拒绝
    vi.mocked(executeRedCheck).mockResolvedValueOnce(passingRun())
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(OTHER_INPUT).mockResolvedValueOnce(CHANGED_IMPL)
    const resp = await runTool({
      op: "green",
      parent_issue_number: 12,
      task_id: "tdd-checkpoint-tool",
      cycle_id: "cycle-1",
      test_selector: "test/bar.test.ts",
    })

    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("SELECTOR_SWAPPED")
    // 仅 RED evidence 存在，无 GREEN 追加
    expect(recordsState.comments).toHaveLength(1)
    expect(recordsState.comments[0].body).not.toContain("stage: green")
  })

  it("模型在 GREEN 谎报通过但实现未变化 → IMPLEMENTATION_CHANGE_REQUIRED（防空转）", async () => {
    const redResp = await setupRedCycle()
    expect(redResp.ok).toBe(true)

    vi.mocked(executeRedCheck).mockResolvedValueOnce(passingRun())
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(INPUT_DIGEST).mockResolvedValueOnce(BASELINE_IMPL)
    const resp = await runTool({
      op: "green",
      parent_issue_number: 12,
      task_id: "tdd-checkpoint-tool",
      cycle_id: "cycle-1",
      test_selector: "test/foo.test.ts",
    })
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("IMPLEMENTATION_CHANGE_REQUIRED")
  })
})

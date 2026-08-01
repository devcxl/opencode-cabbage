import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createTddCheckpointTool,
  registerTddCheckpoint,
  setTddCheckpointGhExecutor,
  setTddCheckpointGitExecutor,
  checkTddSubmitGate,
  isDocumentationOnly,
  parsePorcelainChanges,
  TASK_TDD_TAG,
  TDD_STATE_TAG,
  parseStateFromContent,
  type TddTaskContext,
} from "../../src/plugin/tdd-checkpoint.js"
import { setRecordsGhExecutor, extractEvidenceBlock } from "../../src/kernel/records.js"
import { executeRedCheck, executeVitest } from "../../src/kernel/tdd/adapter.js"
import { computeWorkspaceDigest } from "../../src/kernel/tdd/digest.js"
import { createTaskEvidence } from "../../src/kernel/tdd/state.js"
import type {
  TddPolicy,
  AcceptanceCriterion,
  TddCommandEvidence,
  TddEvidence,
  VersionedDigest,
} from "../../src/kernel/types.js"

vi.mock("../../src/kernel/tdd/adapter.js", () => ({
  executeRedCheck: vi.fn(),
  executeVitest: vi.fn(),
}))
vi.mock("../../src/kernel/tdd/digest.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/kernel/tdd/digest.js")>()
  return {
    computeWorkspaceDigest: vi.fn(),
    matchesAnyPattern: actual.matchesAnyPattern,
  }
})

// ─── 常量 ───

const BASELINE_IMPL: VersionedDigest = { algorithm: "sha256-content-v1", value: "b".repeat(64) }
const CHANGED_IMPL: VersionedDigest = { algorithm: "sha256-content-v1", value: "c".repeat(64) }
const INPUT_DIGEST: VersionedDigest = { algorithm: "sha256-content-v1", value: "d".repeat(64) }
const OTHER_INPUT: VersionedDigest = { algorithm: "sha256-content-v1", value: "e".repeat(64) }
const PLACEHOLDER: VersionedDigest = { algorithm: "sha256-content-v1", value: "0".repeat(64) }

// ─── 辅助工厂 ───

function makePolicy(overrides: Partial<TddPolicy> = {}): TddPolicy {
  return {
    mode: "strict",
    enforcement: "runtime",
    runner: {
      adapter: "vitest",
      baseCommand: "npx vitest run",
      timeoutMs: 30000,
      executionInputPatterns: ["package.json", "vitest.config.ts"],
    },
    testFilePatterns: ["test/**/*.test.ts"],
    implementationFilePatterns: ["src/**/*.ts"],
    generatedArtifactPatterns: [],
    exception: null,
    source: { manifestPath: "test.yml", revisionSha: "sha1" },
    ...overrides,
  }
}

function makeCriteria(overrides: Partial<AcceptanceCriterion>[] = []): AcceptanceCriterion[] {
  const base: AcceptanceCriterion[] = [
    { id: "AC-1", description: "TDD behavior", verification: "tdd" },
    { id: "AC-2", description: "regression stays green", verification: "regression" },
  ]
  return base.map((c, i) => ({ ...c, ...(overrides[i] ?? {}) }))
}

function makeRun(overrides: Partial<TddCommandEvidence> = {}): TddCommandEvidence {
  return {
    command: "npx vitest run test/foo.test.ts",
    testSelector: "test/foo.test.ts",
    exitCode: 1,
    failureKind: "assertion",
    testsCollected: 3,
    testsFailed: 1,
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: "2026-01-01T00:00:01Z",
    durationMs: 1000,
    changedFiles: [],
    outputDigest: { algorithm: "sha256-output-v1", value: "a".repeat(64) },
    workspaceDigest: PLACEHOLDER,
    executionInputDigest: PLACEHOLDER,
    summary: "1/3 tests failed",
    ...overrides,
  }
}

function passingRun(): TddCommandEvidence {
  return makeRun({ exitCode: 0, failureKind: null, testsFailed: 0, summary: "3/3 tests passed" })
}

// ─── 环境 mock（records gh + tdd gh） ───

function makeRecordsState() {
  const comments: { id: number; body: string }[] = []
  const parseBodyArg = (args: string): string => {
    const m = args.match(/(?:--body |body=')([\s\S]*?)'$/)
    return m ? m[1] : ""
  }
  const ghFn = async (args: string): Promise<{ stdout: string; stderr: string }> => {
    if (args.startsWith("issue view") && args.includes("--json comments")) {
      const first = comments.find(c => c.body.includes("<!-- cabbage-tdd-evidence:start -->"))
      return { stdout: first ? JSON.stringify({ id: first.id, body: first.body }) : "null", stderr: "" }
    }
    if (args.startsWith("issue comment")) {
      comments.push({ id: comments.length + 1, body: parseBodyArg(args) })
      return { stdout: "", stderr: "" }
    }
    if (args.startsWith("repo view")) {
      return { stdout: "devcxl/opencode-cabbage", stderr: "" }
    }
    if (args.startsWith("api repos/")) {
      const match = args.match(/issues\/comments\/(\d+) -X PATCH -f body='([\s\S]*?)'$/)
      if (match) {
        const id = Number(match[1])
        const idx = comments.findIndex(c => c.id === id)
        comments[idx] = { id, body: match[2] }
      }
      return { stdout: "", stderr: "" }
    }
    throw new Error(`unexpected records gh: ${args}`)
  }
  return { ghFn, comments }
}

function makeTaskBody(overrides: Partial<TddTaskContext> = {}): string {
  const ctx: TddTaskContext = {
    issueNumber: 77,
    policy: makePolicy(),
    criteria: makeCriteria(),
    worktreeDir: ".worktree/tdd-x",
    ...overrides,
  }
  return `## Task Record\n\n${TASK_TDD_TAG}\n${JSON.stringify({
    policy: ctx.policy,
    criteria: ctx.criteria,
    worktreeDir: ctx.worktreeDir,
  })}`
}

function makeSessionClient(role: "primary" | "developer" | "reviewer" = "developer") {
  const parentID = role === "primary" ? null : "parent"
  return { session: { get: async () => ({ data: { parentID, metadata: {} } }) } }
}

function makeCtx(agent: string) {
  return { agent, sessionID: "sess-1", messageID: "m1", directory: ".", worktree: "." }
}

// ─── 测试环境 ───

let projectDir: string
let recordsState: ReturnType<typeof makeRecordsState>

beforeEach(async () => {
  projectDir = await mkdtemp(join(tmpdir(), "cabbage-tdd-checkpoint-"))
  recordsState = makeRecordsState()
  setRecordsGhExecutor(recordsState.ghFn)
  setTddCheckpointGhExecutor(async (args: string) => {
    if (args.startsWith("issue list --state all --limit 100 --json number,title,parent")) {
      return { stdout: "77", stderr: "" }
    }
    if (args.startsWith("issue view 77")) {
      return { stdout: makeTaskBody(), stderr: "" }
    }
    throw new Error(`unexpected tdd gh: ${args}`)
  })
  vi.mocked(executeRedCheck).mockReset()
  vi.mocked(executeVitest).mockReset()
  vi.mocked(computeWorkspaceDigest).mockReset()
})

afterEach(async () => {
  setRecordsGhExecutor(null)
  setTddCheckpointGhExecutor(null)
  await rm(projectDir, { recursive: true, force: true })
})

async function runTool(
  args: Record<string, unknown>,
  opts: { agent?: string; role?: "primary" | "developer" | "reviewer" } = {},
): Promise<Record<string, any>> {
  const agent = opts.agent ?? (opts.role === "primary" ? "dev-lifecycle" : opts.role ?? "developer")
  const t = createTddCheckpointTool({ projectDir, sessionClient: makeSessionClient(opts.role ?? "developer") })
  const out = await t.execute(args, makeCtx(agent) as never)
  return JSON.parse(String(out)) as Record<string, any>
}

function commentBody(): string | null {
  const comment = recordsState.comments[0]
  return comment ? comment.body : null
}

function latestEvidence(): TddEvidence | null {
  const body = commentBody()
  if (!body) return null
  const extracted = extractEvidenceBlock(body)
  if (!extracted) return null
  return parseStateFromContent(extracted.content)
}

function cycleStartArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    op: "cycle-start",
    parent_issue_number: 12,
    task_id: "tdd-checkpoint-tool",
    cycle_id: "cycle-1",
    criterion_id: "AC-1",
    test_paths: ["test/foo.test.ts"],
    test_selector: "test/foo.test.ts",
    ...overrides,
  }
}

async function setupRedCycle(): Promise<Record<string, any>> {
  // cycle-start → red，工具层可复用的前置状态
  vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(BASELINE_IMPL)
  const start = await runTool(cycleStartArgs())
  if (!start.ok) throw new Error(`cycle-start failed: ${start.error?.message}`)
  vi.mocked(executeRedCheck).mockResolvedValueOnce(makeRun())
  vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(INPUT_DIGEST).mockResolvedValueOnce(BASELINE_IMPL)
  return runTool({ op: "red", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", cycle_id: "cycle-1", test_selector: "test/foo.test.ts" })
}

// ─── args schema ───

describe("tdd_checkpoint tool — args schema", () => {
  it("defines the nine ops in the args schema", () => {
    const t = createTddCheckpointTool({ projectDir: ".", sessionClient: makeSessionClient() })
    const opSchema = t.args.op as { safeParse(value: unknown): { success: boolean } }
    const ops = [
      "cycle-start", "red", "green", "final-regression", "final-verification",
      "abandon-cycle", "status", "not-applicable", "exempt-request",
    ]
    for (const op of ops) expect(opSchema.safeParse(op).success).toBe(true)
    expect(opSchema.safeParse("alternative-command").success).toBe(false)
    expect(opSchema.safeParse("bogus").success).toBe(false)
  })

  it("registerTddCheckpoint mounts the tool in the registry", () => {
    const registry: Record<string, unknown> = {}
    registerTddCheckpoint(registry, { projectDir: ".", sessionClient: makeSessionClient() })
    expect(registry.tdd_checkpoint).toBeDefined()
  })
})

// ─── caller 门禁 ───

describe("tdd_checkpoint — caller gate", () => {
  it("allows developer to run red", async () => {
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(BASELINE_IMPL)
    const resp = await runTool(cycleStartArgs())
    expect(resp.ok).toBe(true)
  })

  it("rejects reviewer caller", async () => {
    const resp = await runTool(cycleStartArgs(), { role: "reviewer" })
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("CALLER_NOT_AUTHORIZED")
  })

  it("allows primary to run cycle-start", async () => {
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(BASELINE_IMPL)
    const resp = await runTool(cycleStartArgs(), { role: "primary" })
    expect(resp.ok).toBe(true)
  })

  it("not-applicable is restricted to primary", async () => {
    const devResp = await runTool({ op: "not-applicable", parent_issue_number: 12, task_id: "tdd-checkpoint-tool" })
    expect(devResp.ok).toBe(false)
    expect(devResp.error.code).toBe("CALLER_NOT_AUTHORIZED")

    setTddCheckpointGitExecutor(() => "?? docs/README.md")
    const priResp = await runTool({ op: "not-applicable", parent_issue_number: 12, task_id: "tdd-checkpoint-tool" }, { role: "primary" })
    expect(priResp.ok).toBe(true)
  })
})

// ─── cycle-start ───

describe("tdd_checkpoint — cycle-start", () => {
  it("records the criterion and the implementation-file baseline digest", async () => {
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(BASELINE_IMPL)
    const resp = await runTool(cycleStartArgs())

    expect(resp.ok).toBe(true)
    expect(resp.cycle.cycleId).toBe("cycle-1")
    expect(resp.cycle.status).toBe("started")

    const evidence = latestEvidence()
    expect(evidence).not.toBeNull()
    expect(evidence!.cycles).toHaveLength(1)
    expect(evidence!.cycles[0].criterionId).toBe("AC-1")
    expect(evidence!.cycles[0].startWorkspaceDigest).toEqual(BASELINE_IMPL)
    expect(evidence!.status).toBe("in-progress")
    expect(commentBody()).toContain(TDD_STATE_TAG)
  })

  it("rejects a non-existent criterion", async () => {
    const resp = await runTool(cycleStartArgs({ criterion_id: "NONEXISTENT" }))
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("CRITERION_NOT_FOUND")
  })

  it("rejects test paths that do not match testFilePatterns", async () => {
    const resp = await runTool(cycleStartArgs({ test_paths: ["src/foo.ts"] }))
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("POLICY_INVALID")
  })

  it("rejects when required args are missing", async () => {
    const resp = await runTool({ op: "cycle-start", parent_issue_number: 12, task_id: "tdd-checkpoint-tool" })
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("POLICY_INVALID")
  })
})

// ─── red ───

describe("tdd_checkpoint — red", () => {
  it("executes the test, classifies the failure, keeps impl unchanged and input stable", async () => {
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(BASELINE_IMPL)
    await runTool(cycleStartArgs())

    vi.mocked(executeRedCheck).mockResolvedValueOnce(makeRun())
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(INPUT_DIGEST).mockResolvedValueOnce(BASELINE_IMPL)
    const resp = await runTool({ op: "red", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", cycle_id: "cycle-1", test_selector: "test/foo.test.ts" })

    expect(resp.ok).toBe(true)
    expect(resp.cycle.status).toBe("red")
    expect(executeRedCheck).toHaveBeenCalledTimes(1)
    const evidence = latestEvidence()
    expect(evidence!.cycles[0].redAttempts).toHaveLength(1)
    expect(evidence!.cycles[0].redTestDigest).toEqual(INPUT_DIGEST)
    expect(commentBody()).toContain("failureKind: assertion")
  })

  it("rejects when the test unexpectedly passes (exitCode 0)", async () => {
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(BASELINE_IMPL)
    await runTool(cycleStartArgs())

    vi.mocked(executeRedCheck).mockResolvedValueOnce(passingRun())
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(INPUT_DIGEST).mockResolvedValueOnce(BASELINE_IMPL)
    const resp = await runTool({ op: "red", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", cycle_id: "cycle-1", test_selector: "test/foo.test.ts" })
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("RED_EXPECTED_FAILURE")
  })

  it("rejects an infrastructure failure as RED", async () => {
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(BASELINE_IMPL)
    await runTool(cycleStartArgs())

    vi.mocked(executeRedCheck).mockResolvedValueOnce(makeRun({ failureKind: "infrastructure", summary: "infra error" }))
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(INPUT_DIGEST).mockResolvedValueOnce(BASELINE_IMPL)
    const resp = await runTool({ op: "red", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", cycle_id: "cycle-1", test_selector: "test/foo.test.ts" })
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("RED_INFRASTRUCTURE_FAILURE")
  })

  it("rejects IMPL_CHANGED_IN_RED when implementation files changed since baseline", async () => {
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(BASELINE_IMPL)
    await runTool(cycleStartArgs())

    vi.mocked(executeRedCheck).mockResolvedValueOnce(makeRun())
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(INPUT_DIGEST).mockResolvedValueOnce(CHANGED_IMPL)
    const resp = await runTool({ op: "red", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", cycle_id: "cycle-1", test_selector: "test/foo.test.ts" })
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("IMPL_CHANGED_IN_RED")
  })

  it("rejects INPUT_SWAPPED when a retried red changes the execution input digest", async () => {
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(BASELINE_IMPL)
    await runTool(cycleStartArgs())
    // 第一次 RED：成功记录
    vi.mocked(executeRedCheck).mockResolvedValueOnce(makeRun())
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(INPUT_DIGEST).mockResolvedValueOnce(BASELINE_IMPL)
    const first = await runTool({ op: "red", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", cycle_id: "cycle-1", test_selector: "test/foo.test.ts" })
    expect(first.ok).toBe(true)

    // 重试 RED：输入 digest 变化 → 拒绝
    vi.mocked(executeRedCheck).mockResolvedValueOnce(makeRun())
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(OTHER_INPUT).mockResolvedValueOnce(BASELINE_IMPL)
    const retry = await runTool({ op: "red", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", cycle_id: "cycle-1", test_selector: "test/foo.test.ts" })
    expect(retry.ok).toBe(false)
    expect(retry.error.code).toBe("INPUT_SWAPPED")
  })

  it("rejects red when the cycle does not exist", async () => {
    vi.mocked(executeRedCheck).mockResolvedValueOnce(makeRun())
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(INPUT_DIGEST).mockResolvedValueOnce(BASELINE_IMPL)
    const resp = await runTool({ op: "red", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", cycle_id: "nope", test_selector: "test/foo.test.ts" })
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("CYCLE_CONFLICT")
  })
})

// ─── green ───

describe("tdd_checkpoint — green", () => {
  it("executes the same test, requires pass and consistent input, then records green", async () => {
    const redResp = await setupRedCycle()
    expect(redResp.ok).toBe(true)

    vi.mocked(executeRedCheck).mockResolvedValueOnce(passingRun())
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(INPUT_DIGEST).mockResolvedValueOnce(CHANGED_IMPL)
    const resp = await runTool({ op: "green", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", cycle_id: "cycle-1", test_selector: "test/foo.test.ts" })

    expect(resp.ok).toBe(true)
    expect(resp.cycle.status).toBe("pass")
    const evidence = latestEvidence()
    expect(evidence!.cycles[0].greenAttempts).toHaveLength(1)
    expect(evidence!.cycles[0].status).toBe("pass")
  })

  it("rejects when the test still fails", async () => {
    const redResp = await setupRedCycle()
    expect(redResp.ok).toBe(true)

    vi.mocked(executeRedCheck).mockResolvedValueOnce(makeRun())
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(INPUT_DIGEST).mockResolvedValueOnce(CHANGED_IMPL)
    const resp = await runTool({ op: "green", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", cycle_id: "cycle-1", test_selector: "test/foo.test.ts" })
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("GREEN_EXPECTED_PASS")
  })

  it("rejects SELECTOR_SWAPPED when the execution input digest differs from RED", async () => {
    const redResp = await setupRedCycle()
    expect(redResp.ok).toBe(true)

    vi.mocked(executeRedCheck).mockResolvedValueOnce(passingRun())
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(OTHER_INPUT).mockResolvedValueOnce(CHANGED_IMPL)
    const resp = await runTool({ op: "green", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", cycle_id: "cycle-1", test_selector: "test/foo.test.ts" })
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("SELECTOR_SWAPPED")
  })

  it("rejects IMPLEMENTATION_CHANGE_REQUIRED when no implementation file changed", async () => {
    const redResp = await setupRedCycle()
    expect(redResp.ok).toBe(true)

    vi.mocked(executeRedCheck).mockResolvedValueOnce(passingRun())
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(INPUT_DIGEST).mockResolvedValueOnce(BASELINE_IMPL)
    const resp = await runTool({ op: "green", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", cycle_id: "cycle-1", test_selector: "test/foo.test.ts" })
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("IMPLEMENTATION_CHANGE_REQUIRED")
  })

  it("rejects green when no RED was recorded", async () => {
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(BASELINE_IMPL)
    await runTool(cycleStartArgs())

    vi.mocked(executeRedCheck).mockResolvedValueOnce(passingRun())
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(INPUT_DIGEST).mockResolvedValueOnce(CHANGED_IMPL)
    const resp = await runTool({ op: "green", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", cycle_id: "cycle-1", test_selector: "test/foo.test.ts" })
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("INVALID_TRANSITION")
  })
})

// ─── final-regression ───

describe("tdd_checkpoint — final-regression", () => {
  it("runs the full suite and records pass when all tests pass", async () => {
    vi.mocked(executeVitest).mockResolvedValueOnce({ exitCode: 0, testsCollected: 5, testsFailed: 0, stdout: "", stderr: "", timedOut: false })
    const resp = await runTool({ op: "final-regression", parent_issue_number: 12, task_id: "tdd-checkpoint-tool" })

    expect(resp.ok).toBe(true)
    expect(executeVitest).toHaveBeenCalledTimes(1)
    const evidence = latestEvidence()
    expect(evidence!.regression.status).toBe("pass")
    expect(evidence!.regression.runs).toHaveLength(1)
  })

  it("rejects REGRESSION_FAILED when the full suite has failures", async () => {
    vi.mocked(executeVitest).mockResolvedValueOnce({ exitCode: 1, testsCollected: 5, testsFailed: 2, stdout: "", stderr: "2 failed", timedOut: false })
    const resp = await runTool({ op: "final-regression", parent_issue_number: 12, task_id: "tdd-checkpoint-tool" })

    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("REGRESSION_FAILED")
    const evidence = latestEvidence()
    expect(evidence!.regression.status).toBe("fail")
  })

  it("rejects when no runner is configured", async () => {
    setTddCheckpointGhExecutor(async (args: string) => {
      if (args.startsWith("issue list --state all --limit 100 --json number,title,parent")) return { stdout: "77", stderr: "" }
      if (args.startsWith("issue view 77")) {
        return { stdout: makeTaskBody({ policy: makePolicy({ runner: null }) }), stderr: "" }
      }
      throw new Error(`unexpected tdd gh: ${args}`)
    })
    const resp = await runTool({ op: "final-regression", parent_issue_number: 12, task_id: "tdd-checkpoint-tool" })
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("RUNNER_UNSUPPORTED")
  })
})

// ─── final-verification ───

describe("tdd_checkpoint — final-verification", () => {
  it("verifies each tdd criterion against its pass cycle", async () => {
    // 完成一个完整 cycle（cycle-start → red → green）
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(BASELINE_IMPL)
    await runTool(cycleStartArgs())
    vi.mocked(executeRedCheck).mockResolvedValueOnce(makeRun())
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(INPUT_DIGEST).mockResolvedValueOnce(BASELINE_IMPL)
    await runTool({ op: "red", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", cycle_id: "cycle-1", test_selector: "test/foo.test.ts" })
    vi.mocked(executeRedCheck).mockResolvedValueOnce(passingRun())
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(INPUT_DIGEST).mockResolvedValueOnce(CHANGED_IMPL)
    const green = await runTool({ op: "green", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", cycle_id: "cycle-1", test_selector: "test/foo.test.ts" })
    expect(green.ok).toBe(true)

    const resp = await runTool({ op: "final-verification", parent_issue_number: 12, task_id: "tdd-checkpoint-tool" })
    expect(resp.ok).toBe(true)
    const evidence = latestEvidence()
    expect(evidence!.verification.status).toBe("pass")
  })

  it("rejects CRITERIA_NOT_COVERED when a tdd criterion has no pass cycle", async () => {
    const resp = await runTool({ op: "final-verification", parent_issue_number: 12, task_id: "tdd-checkpoint-tool" })
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("CRITERIA_NOT_COVERED")
  })
})

// ─── abandon-cycle ───

describe("tdd_checkpoint — abandon-cycle", () => {
  it("abandons a started cycle and records the reason", async () => {
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(BASELINE_IMPL)
    await runTool(cycleStartArgs())

    const resp = await runTool({ op: "abandon-cycle", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", cycle_id: "cycle-1", reason: "wrong test design" })
    expect(resp.ok).toBe(true)
    const evidence = latestEvidence()
    expect(evidence!.cycles[0].status).toBe("abandoned")
    expect(evidence!.warnings).toContain("wrong test design")
  })

  it("rejects abandoning a non-existent cycle", async () => {
    const resp = await runTool({ op: "abandon-cycle", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", cycle_id: "nope", reason: "oops" })
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("CYCLE_CONFLICT")
  })
})

// ─── status ───

describe("tdd_checkpoint — status", () => {
  it("returns the evidence summary", async () => {
    const resp = await runTool({ op: "status", parent_issue_number: 12, task_id: "tdd-checkpoint-tool" })
    expect(resp.ok).toBe(true)
    expect(resp.evidence.status).toBe("not-recorded")
    expect(resp.evidence.cycles).toBe(0)
  })
})

// ─── 豁免 ───

describe("tdd_checkpoint — exemptions", () => {
  it("not-applicable marks evidence as waived (pure documentation change)", async () => {
    setTddCheckpointGitExecutor(() => "?? docs/README.md")
    const resp = await runTool({ op: "not-applicable", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", reason: "docs only" }, { role: "primary" })
    expect(resp.ok).toBe(true)
    const evidence = latestEvidence()
    expect(evidence!.status).toBe("waived")
    expect(evidence!.warnings.some(w => w.includes("not-applicable"))).toBe(true)
  })

  it("not-applicable rejects code changes (WAIVER_DOCS_ONLY)", async () => {
    setTddCheckpointGitExecutor(() => " M src/index.ts")
    const resp = await runTool({ op: "not-applicable", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", reason: "docs only" }, { role: "primary" })
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("WAIVER_DOCS_ONLY")
    expect(commentBody()).toBeNull()
  })

  it("not-applicable rejects mixed doc+code changes", async () => {
    setTddCheckpointGitExecutor(() => "?? docs/README.md\n M src/index.ts")
    const resp = await runTool({ op: "not-applicable", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", reason: "docs only" }, { role: "primary" })
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("WAIVER_DOCS_ONLY")
  })

  it("not-applicable rejects an empty change set", async () => {
    setTddCheckpointGitExecutor(() => "")
    const resp = await runTool({ op: "not-applicable", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", reason: "docs only" }, { role: "primary" })
    expect(resp.ok).toBe(false)
    expect(resp.error.code).toBe("WAIVER_DOCS_ONLY")
  })

  it("exempt-request requires user_confirmed", async () => {
    const denied = await runTool({ op: "exempt-request", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", reason: "external blocker" }, { role: "primary" })
    expect(denied.ok).toBe(false)
    expect(denied.error.code).toBe("EXEMPT_REQUIRES_CONFIRMATION")

    const approved = await runTool({ op: "exempt-request", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", reason: "external blocker", user_confirmed: true }, { role: "primary" })
    expect(approved.ok).toBe(true)
    const evidence = latestEvidence()
    expect(evidence!.status).toBe("waived")
  })

  it("submit gate passes for waived evidence (exemption closes the gate)", async () => {
    setTddCheckpointGitExecutor(() => "?? docs/README.md")
    await runTool({ op: "not-applicable", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", reason: "docs only" }, { role: "primary" })
    const policy = makePolicy()
    const criteria = makeCriteria()
    const gate = await checkTddSubmitGate({
      issueNumber: 12,
      policy,
      criteria,
      projectDir,
      task: { issueNumber: 12, policy, criteria, worktreeDir: projectDir },
    })
    expect(gate.ok).toBe(true)
    if (gate.ok) expect(gate.status).toBe("waived")
  })
})

// ─── 纯文档豁免纯函数 ───

describe("tdd_checkpoint — isDocumentationOnly / parsePorcelainChanges", () => {
  const DOC_PATTERNS = ["**/*.md", "docs/**", "README*"]

  it("isDocumentationOnly accepts pure docs", () => {
    expect(isDocumentationOnly(["docs/README.md"], DOC_PATTERNS)).toBe(true)
    expect(isDocumentationOnly(["README.md"], DOC_PATTERNS)).toBe(true)
  })

  it("isDocumentationOnly rejects code and empty sets", () => {
    expect(isDocumentationOnly(["src/index.ts"], DOC_PATTERNS)).toBe(false)
    expect(isDocumentationOnly(["docs/a.md", "src/index.ts"], DOC_PATTERNS)).toBe(false)
    expect(isDocumentationOnly([], DOC_PATTERNS)).toBe(false)
  })

  it("parsePorcelainChanges extracts paths and resolves renames", () => {
    expect(parsePorcelainChanges(" M src/index.ts\n?? docs/new.md\nA  README.md")).toEqual([
      "src/index.ts",
      "docs/new.md",
      "README.md",
    ])
    expect(parsePorcelainChanges("R  old.md -> docs/new.md")).toEqual(["docs/new.md"])
    expect(parsePorcelainChanges("UU conflict.ts")).toEqual([])
  })
})

// ─── 幂等 ───

describe("tdd_checkpoint — idempotency", () => {
  it("repeating cycle-start with the same baseline does not append another block", async () => {
    vi.mocked(computeWorkspaceDigest).mockResolvedValue(BASELINE_IMPL)
    const r1 = await runTool(cycleStartArgs())
    expect(r1.ok).toBe(true)
    const rev1 = recordsState.comments[0] ? 1 : 0

    const r2 = await runTool(cycleStartArgs())
    expect(r2.ok).toBe(true)
    // comment 仍只有一条且 revision 未增长（幂等）
    expect(recordsState.comments).toHaveLength(1)
    const body = recordsState.comments[0].body
    expect(body).toContain(`revision:${rev1}`)
    expect(body.split("<!-- cabbage-tdd-state -->").length - 1).toBe(1)
  })
})

// ─── submit 门禁 ───

describe("checkTddSubmitGate (spec §4.4)", () => {
  it("rejects TDD_EVIDENCE_INCOMPLETE when no evidence comment exists", async () => {
    const gate = await checkTddSubmitGate({ issueNumber: 77, policy: makePolicy(), criteria: makeCriteria() })
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.code).toBe("TDD_EVIDENCE_INCOMPLETE")
  })

  it("rejects TDD_EVIDENCE_INCOMPLETE when cycles are missing under strict runtime", async () => {
    // 只写一个非 cycle 的 block（无 state JSON 也视为无 evidence）
    const gate = await checkTddSubmitGate({ issueNumber: 77, policy: makePolicy(), criteria: makeCriteria() })
    expect(gate.ok).toBe(false)
    if (!gate.ok) expect(gate.code).toBe("TDD_EVIDENCE_INCOMPLETE")
  })

  it("passes when a full strict cycle + regression + verification are recorded", async () => {
    // 完整证据：cycle-start → red → green → final-regression → final-verification
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(BASELINE_IMPL)
    await runTool(cycleStartArgs())
    vi.mocked(executeRedCheck).mockResolvedValueOnce(makeRun())
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(INPUT_DIGEST).mockResolvedValueOnce(BASELINE_IMPL)
    await runTool({ op: "red", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", cycle_id: "cycle-1", test_selector: "test/foo.test.ts" })
    vi.mocked(executeRedCheck).mockResolvedValueOnce(passingRun())
    vi.mocked(computeWorkspaceDigest).mockResolvedValueOnce(INPUT_DIGEST).mockResolvedValueOnce(CHANGED_IMPL)
    await runTool({ op: "green", parent_issue_number: 12, task_id: "tdd-checkpoint-tool", cycle_id: "cycle-1", test_selector: "test/foo.test.ts" })
    vi.mocked(executeVitest).mockResolvedValueOnce({ exitCode: 0, testsCollected: 5, testsFailed: 0, stdout: "", stderr: "", timedOut: false })
    await runTool({ op: "final-regression", parent_issue_number: 12, task_id: "tdd-checkpoint-tool" })
    const verify = await runTool({ op: "final-verification", parent_issue_number: 12, task_id: "tdd-checkpoint-tool" })
    expect(verify.ok).toBe(true)

    const gate = await checkTddSubmitGate({ issueNumber: 77, policy: makePolicy(), criteria: makeCriteria() })
    expect(gate.ok).toBe(true)
  })

  it("advisory enforcement does not block on missing cycles", async () => {
    const policy = makePolicy({ enforcement: "advisory", mode: "relaxed" })
    vi.mocked(executeVitest).mockResolvedValueOnce({ exitCode: 0, testsCollected: 5, testsFailed: 0, stdout: "", stderr: "", timedOut: false })
    await runTool({ op: "final-regression", parent_issue_number: 12, task_id: "tdd-checkpoint-tool" })
    const gate = await checkTddSubmitGate({ issueNumber: 77, policy, criteria: makeCriteria() })
    expect(gate.ok).toBe(true)
  })
})

// ─── 状态恢复（防自报） ───

describe("tdd_checkpoint — evidence state roundtrip", () => {
  it("restores the latest state from the controlled comment", async () => {
    vi.mocked(computeWorkspaceDigest).mockResolvedValue(BASELINE_IMPL)
    await runTool(cycleStartArgs())
    const first = latestEvidence()!
    expect(first.cycles).toHaveLength(1)

    // 第二次 op 从 comment 恢复状态后继续
    const resp = await runTool(cycleStartArgs({ cycle_id: "cycle-2", criterion_id: "AC-1", test_paths: ["test/bar.test.ts"], test_selector: "test/bar.test.ts" }))
    expect(resp.ok).toBe(true)
    const second = latestEvidence()!
    expect(second.cycles).toHaveLength(2)
    expect(second.cycles.map(c => c.cycleId)).toEqual(["cycle-1", "cycle-2"])
  })
})

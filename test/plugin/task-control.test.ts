import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildTaskBody,
  parseAcceptanceCriteria,
  parseCriteriaFromBody,
  parseDependenciesFromBody,
  escalateRisk,
  matchRiskPattern,
  freezeTddPolicy,
  parseEvidenceComment,
  evidenceCommentToTddEvidence,
  mapCheckRollup,
  BUILTIN_RISK_PATTERNS,
  startTask,
  submitTask,
  submitReview,
  mergeTask,
  cancelTask,
  destroyTaskWorktree,
  readTaskStatus,
  setTaskGhExecutor,
  setTaskGitExecutor,
  type TaskRuntimeState,
} from "../../src/kernel/task.js"
import type { ProjectProfile } from "../../src/kernel/profile.js"
import { createTaskControlTool, registerTaskControl } from "../../src/plugin/task-control.js"
import { setRecordsGhExecutor } from "../../src/kernel/records.js"
import { setWorktreeGitExecutor } from "../../src/kernel/worktree.js"
import { setMergeGhExecutor } from "../../src/kernel/review.js"
import type { CallerSessionClient } from "../../src/kernel/caller.js"

const primaryClient: CallerSessionClient = {
  session: { get: async () => ({ data: { parentID: null } }) },
}
const childClient: CallerSessionClient = {
  session: { get: async () => ({ data: { parentID: "parent" } }) },
}

function makeCtx(agent: string, sessionID: string) {
  return {
    agent,
    sessionID,
    messageID: "m1",
    directory: ".",
    worktree: ".",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }
}

async function executeOp(
  dir: string,
  op: string,
  args: Record<string, unknown> = {},
  client: CallerSessionClient = primaryClient,
  agent = "dev-lifecycle",
): Promise<Record<string, any>> {
  const t = createTaskControlTool({ projectDir: dir, sessionClient: client })
  const out = await t.execute({ op, ...args }, makeCtx(agent, "sess-1") as never)
  return JSON.parse(String(out)) as Record<string, any>
}

async function withProjectDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "cabbage-task-"))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function writeProfile(dir: string) {
  await writeFile(
    join(dir, "AGENTS.md"),
    "## Project Profile\n\n- test command: `cabbage-test-tool run`\n- test file patterns: `test/**/*.test.ts`\n- implementation file patterns: `src/**/*.ts`\n- tdd default mode: `strict`\n",
  )
}

function expectAllExecutorsThrow() {
  setTaskGhExecutor(() => {
    throw new Error("unexpected task gh")
  })
  setTaskGitExecutor(() => {
    throw new Error("unexpected task git")
  })
  setRecordsGhExecutor(() => {
    throw new Error("unexpected records gh")
  })
  setWorktreeGitExecutor(() => {
    throw new Error("unexpected worktree git")
  })
  setMergeGhExecutor(() => {
    throw new Error("unexpected merge gh")
  })
}

function resetAllExecutors() {
  setTaskGhExecutor(null)
  setTaskGitExecutor(null)
  setRecordsGhExecutor(null)
  setWorktreeGitExecutor(null)
  // kernel/review.ts 的 setMergeGhExecutor 接受 null，用恒抛错的 stub 兜底
  setMergeGhExecutor(() => {
    throw new Error("unexpected merge gh")
  })
}

describe("task kernel pure functions", () => {
  describe("buildTaskBody", () => {
    it("renders criteria, dependencies, status checklist, and the Closes convention", () => {
      const body = buildTaskBody("flow-control-tool", [{ id: "c1", description: "registers ops", verification: "tdd" }], [12])
      expect(body).toContain("# Task: flow-control-tool")
      expect(body).toContain("- [ ] c1: registers ops [tdd]")
      expect(body).toContain("- #12")
      expect(body).toContain("- [ ] running")
      expect(body).toContain("- [ ] merged")
      expect(body).toContain("Closes #<issueNumber>")
    })
  })

  describe("parseAcceptanceCriteria", () => {
    it("parses a valid JSON array", () => {
      expect(parseAcceptanceCriteria('[{"id":"c1","description":"x","verification":"tdd"}]')).toEqual([
        { id: "c1", description: "x", verification: "tdd" },
      ])
    })
    it("rejects malformed JSON or invalid verification", () => {
      expect(parseAcceptanceCriteria("not json")).toBeNull()
      expect(parseAcceptanceCriteria('[{"id":"c1","description":"x","verification":"bogus"}]')).toBeNull()
    })
  })

  describe("parseCriteriaFromBody", () => {
    it("round-trips criteria written by buildTaskBody", () => {
      const body = buildTaskBody("slug", [{ id: "c1", description: "x", verification: "tdd" }], [])
      expect(parseCriteriaFromBody(body)).toEqual([{ id: "c1", description: "x", verification: "tdd" }])
    })
    it("ignores unchecked TBD lines", () => {
      expect(parseCriteriaFromBody("- [ ] TBD")).toEqual([])
    })
  })

  describe("parseDependenciesFromBody", () => {
    it("extracts dependency issue numbers", () => {
      const body = buildTaskBody("slug", [], [12, 13])
      expect(parseDependenciesFromBody(body)).toEqual([12, 13])
    })
  })

  describe("mapCheckRollup", () => {
    it("maps GitHub Actions CheckRuns (name + conclusion)", () => {
      expect(mapCheckRollup([{ name: "verify", status: "COMPLETED", conclusion: "SUCCESS" }]))
        .toEqual([{ name: "verify", state: "SUCCESS" }])
    })
    it("maps StatusContext (context + state)", () => {
      expect(mapCheckRollup([{ context: "continuous-integration", state: "SUCCESS" }]))
        .toEqual([{ name: "continuous-integration", state: "SUCCESS" }])
    })
    it("falls back to check/PENDING for missing fields", () => {
      expect(mapCheckRollup([{ status: "IN_PROGRESS" }]))
        .toEqual([{ name: "check", state: "PENDING" }])
    })
  })

  describe("escalateRisk / matchRiskPattern", () => {
    it("matches builtin risk patterns", () => {
      expect(matchRiskPattern("src/db/migrations/001.sql", "**/migrations/**")).toBe(true)
      expect(matchRiskPattern("src/service/auth/login.ts", "**/auth/**")).toBe(true)
      expect(matchRiskPattern(".github/workflows/release.yml", ".github/workflows/**")).toBe(true)
      expect(matchRiskPattern("src/util/fs.ts", "**/migrations/**")).toBe(false)
    })
    it("upgrades low to high when the diff hits a risk pattern", () => {
      expect(escalateRisk("low", ["src/db/migrations/001.sql"], BUILTIN_RISK_PATTERNS)).toBe("high")
    })
    it("never downgrades a model high risk", () => {
      expect(escalateRisk("high", ["README.md"], BUILTIN_RISK_PATTERNS)).toBe("high")
    })
    it("keeps low when the diff is clean", () => {
      expect(escalateRisk("low", ["src/util/fs.ts"], BUILTIN_RISK_PATTERNS)).toBe("low")
    })
    it("respects profile risk patterns appended to builtins", () => {
      expect(escalateRisk("low", ["src/money/calc.ts"], ["**/money/**"])).toBe("high")
    })
  })

  describe("freezeTddPolicy", () => {
    it("defaults to strict runtime mode and carries profile patterns", () => {
      const profile: ProjectProfile = {
        testCommand: "npm test",
        regressionCommand: null,
        testFilePatterns: ["test/**/*.test.ts"],
        implementationFilePatterns: ["src/**/*.ts"],
        tddDefaultMode: null,
        versionBumpRule: null,
        versionFile: null,
        tagFormat: null,
        releaseWorkflowPath: null,
        riskPatterns: [],
      }
      const policy = freezeTddPolicy(profile)
      expect(policy.mode).toBe("strict")
      expect(policy.enforcement).toBe("runtime")
      expect(policy.runner?.baseCommand).toBe("npm test")
      expect(policy.testFilePatterns).toEqual(["test/**/*.test.ts"])
    })
  })

  describe("evidence parsing", () => {
    it("parseEvidenceComment extracts structured blocks", () => {
      const body =
        "<!-- cabbage-tdd-evidence:start --> revision:3\n### stage: red\n- criterion: c1\n- status: red\n### stage: final-regression\n- status: pass\n<!-- cabbage-tdd-evidence:end -->"
      const blocks = parseEvidenceComment(body)
      expect(blocks).toHaveLength(2)
      expect(blocks?.[0]).toMatchObject({ stage: "red", fields: { criterion: "c1", status: "red" } })
    })

    it("evidenceCommentToTddEvidence builds pass evidence for complete blocks", () => {
      const body =
        "<!-- cabbage-tdd-evidence:start --> revision:3\n### stage: green\n- criterion: c1\n- cycle: cyc-1\n- status: pass\n### stage: final-regression\n- status: pass\n### stage: final-verification\n- status: pass\n<!-- cabbage-tdd-evidence:end -->"
      const evidence = evidenceCommentToTddEvidence({ id: 5, body, revision: 3 })
      expect(evidence).not.toBeNull()
      expect(evidence?.cycles).toHaveLength(1)
      expect(evidence?.cycles[0].status).toBe("pass")
      expect(evidence?.regression.status).toBe("pass")
      expect(evidence?.verification.status).toBe("pass")
      expect(evidence?.status).toBe("pass")
    })

    it("returns null for a body without the evidence marker", () => {
      expect(evidenceCommentToTddEvidence({ id: 5, body: "no marker", revision: 1 })).toBeNull()
    })
  })
})

describe("createTaskControlTool (spec §2.3 task_control)", () => {
  beforeEach(() => {
    expectAllExecutorsThrow()
  })

  afterEach(() => {
    resetAllExecutors()
  })

  it("defines the eight ops in the args schema", () => {
    const t = createTaskControlTool({ projectDir: ".", sessionClient: primaryClient })
    const opSchema = t.args.op as { safeParse(value: unknown): { success: boolean } }
    const ops = [
      "create-task", "start-task", "submit-task", "submit-review",
      "merge-task", "cancel-task", "destroy-worktree", "status-task",
    ]
    for (const op of ops) expect(opSchema.safeParse(op).success).toBe(true)
    expect(opSchema.safeParse("bogus").success).toBe(false)
  })

  it("rejects a developer caller with CALLER_NOT_AUTHORIZED", async () => {
    await withProjectDir(async dir => {
      const resp = await executeOp(dir, "start-task", { parent_issue_number: 12, task_id: "x" }, childClient, "developer")
      expect(resp.ok).toBe(false)
      expect(resp.error.code).toBe("CALLER_NOT_AUTHORIZED")
    })
  })

  it("returns UNKNOWN_OP for an unknown op", async () => {
    await withProjectDir(async dir => {
      const resp = await executeOp(dir, "bogus" as string)
      expect(resp.ok).toBe(false)
      expect(resp.error.code).toBe("UNKNOWN_OP")
    })
  })

  describe("create-task", () => {
    it("validates the title, derives the slug, and creates the sub issue linked to the parent", async () => {
      await withProjectDir(async dir => {
        setRecordsGhExecutor(async args => {
          if (args.includes("issue create")) return { stdout: "13", stderr: "" }
          throw new Error(`unexpected records gh: ${args}`)
        })
        setTaskGitExecutor(async args => {
          if (args.includes("refs/heads/")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected task git: ${args}`)
        })

        const resp = await executeOp(dir, "create-task", {
          parent_issue_number: 12,
          title: "flow-control-tool",
          acceptance_criteria: JSON.stringify([{ id: "c1", description: "registers ops", verification: "tdd" }]),
          depends_on: "12",
        })
        expect(resp.ok).toBe(true)
        expect(resp.task).toMatchObject({ parentIssueNumber: 12, taskId: "flow-control-tool", issueNumber: 13 })
      })
    })

    it("rejects a generic or malformed title", async () => {
      await withProjectDir(async dir => {
        const resp = await executeOp(dir, "create-task", { parent_issue_number: 12, title: "Task 001" })
        expect(resp.ok).toBe(false)
        expect(resp.error.code).toBe("INVALID_FORMAT")
      })
    })

    it("rejects a slug conflict when the feat branch already exists", async () => {
      await withProjectDir(async dir => {
        setTaskGitExecutor(async args => {
          if (args.includes("refs/heads/feat/")) return { stdout: "abc123", stderr: "" }
          throw new Error(`unexpected task git: ${args}`)
        })
        const resp = await executeOp(dir, "create-task", { parent_issue_number: 12, title: "flow-control-tool" })
        expect(resp.ok).toBe(false)
        expect(resp.error.code).toBe("TASK_SLUG_CONFLICT")
      })
    })
  })

  describe("start-task", () => {
    it("runs the gates, creates the worktree, captures the baseline, and freezes the policy", async () => {
      await withProjectDir(async dir => {
        await writeProfile(dir)
        await mkdir(join(dir, ".worktree", "user-auth-login"), { recursive: true })
        const taskBody = buildTaskBody("user-auth-login", [{ id: "c1", description: "x", verification: "tdd" }], [14])
        const parentBody = "## Stages\n\n- [x] requirements\n- [x] design\n- [ ] tasks"
        const patchCalls: string[] = []
        setTaskGhExecutor(async args => {
          if (args.includes("--json number,labels")) {
            return { stdout: JSON.stringify([{ number: 20, labels: ["cabbage:task:running"] }]), stderr: "" }
          }
          if (args.includes("issue list")) return { stdout: "13", stderr: "" } // resolveTaskIssue
          if (args.includes("issue view 13 --json body")) return { stdout: taskBody, stderr: "" }
          if (args.includes("issue view 13 --json labels")) return { stdout: "", stderr: "" }
          if (args.includes("issue edit 13")) return { stdout: "", stderr: "" }
          if (args.includes("issues/13 -X PATCH")) {
            patchCalls.push(args)
            return { stdout: "", stderr: "" }
          }
          if (args.includes("issue view 14")) return { stdout: '{"state":"CLOSED","labels":["cabbage:task:merged"]}', stderr: "" }
          if (args.includes("repo view")) return { stdout: "main", stderr: "" }
          throw new Error(`unexpected task gh: ${args}`)
        })
        setRecordsGhExecutor(async args => {
          if (args.includes("issue view 12")) return { stdout: parentBody, stderr: "" }
          throw new Error(`unexpected records gh: ${args}`)
        })
        setWorktreeGitExecutor(async args => {
          if (args.includes("rev-parse --abbrev-ref HEAD")) return { stdout: "feat/user-auth-login", stderr: "" }
          throw new Error(`unexpected worktree git: ${args}`)
        })

        const result = await startTask(dir, 12, "user-auth-login")
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.branch).toBe("feat/user-auth-login")
          expect(result.issueNumber).toBe(13)
          expect(result.policy.mode).toBe("strict")
          expect(result.policy.enforcement).toBe("runtime")
          expect(result.baseline.digest.algorithm).toBe("sha256-content-v1")
        }
        // 跨批协议：Task Record body 必须写入 cabbage-task-tdd 块（含 policy/criteria/worktreeDir）
        expect(patchCalls.length).toBeGreaterThanOrEqual(1)
        const patchBody = patchCalls.join("")
        expect(patchBody).toContain("<!-- cabbage-task-tdd -->")
        expect(patchBody).toContain('"policy"')
        expect(patchBody).toContain("user-auth-login")
      })
    })

    it("rejects when the planning baseline is not merged (design incomplete)", async () => {
      await withProjectDir(async dir => {
        await writeProfile(dir)
        const parentBody = "## Stages\n\n- [x] requirements\n- [ ] design"
        setTaskGhExecutor(async args => {
          if (args.includes("issue list")) return { stdout: "13", stderr: "" }
          if (args.includes("issue view 13")) return { stdout: buildTaskBody("x", [], []), stderr: "" }
          throw new Error(`unexpected task gh: ${args}`)
        })
        setRecordsGhExecutor(async args => {
          if (args.includes("issue view 12")) return { stdout: parentBody, stderr: "" }
          throw new Error(`unexpected records gh: ${args}`)
        })

        const result = await startTask(dir, 12, "user-auth-login")
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe("PLANNING_BASELINE_NOT_MERGED")
      })
    })

    it("rejects when a dependency task is not merged", async () => {
      await withProjectDir(async dir => {
        await writeProfile(dir)
        const taskBody = buildTaskBody("user-auth-login", [], [14])
        setTaskGhExecutor(async args => {
          if (args.includes("issue list")) return { stdout: "13", stderr: "" }
          if (args.includes("issue view 13")) return { stdout: taskBody, stderr: "" }
          if (args.includes("issue view 14")) return { stdout: '{"state":"OPEN","labels":[]}', stderr: "" }
          throw new Error(`unexpected task gh: ${args}`)
        })
        setRecordsGhExecutor(async args => {
          if (args.includes("issue view 12")) return { stdout: "## Stages\n\n- [x] requirements\n- [x] design", stderr: "" }
          throw new Error(`unexpected records gh: ${args}`)
        })

        const result = await startTask(dir, 12, "user-auth-login")
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe("DEPENDENCY_NOT_MERGED")
      })
    })

    it("rejects a CLOSED dependency without the merged label (cancelled task must not pass)", async () => {
      await withProjectDir(async dir => {
        await writeProfile(dir)
        const taskBody = buildTaskBody("user-auth-login", [], [14])
        setTaskGhExecutor(async args => {
          if (args.includes("issue list")) return { stdout: "13", stderr: "" }
          if (args.includes("issue view 13")) return { stdout: taskBody, stderr: "" }
          if (args.includes("issue view 14")) return { stdout: '{"state":"CLOSED","labels":["cabbage:task:cancelled"]}', stderr: "" }
          throw new Error(`unexpected task gh: ${args}`)
        })
        setRecordsGhExecutor(async args => {
          if (args.includes("issue view 12")) return { stdout: "## Stages\n\n- [x] requirements\n- [x] design", stderr: "" }
          throw new Error(`unexpected records gh: ${args}`)
        })

        const result = await startTask(dir, 12, "user-auth-login")
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe("DEPENDENCY_NOT_MERGED")
      })
    })

    it("rejects when the parallel limit is reached", async () => {
      await withProjectDir(async dir => {
        await writeProfile(dir)
        setTaskGhExecutor(async args => {
          if (args.includes("--json number,labels")) {
            return {
              stdout: JSON.stringify([
                { number: 1, labels: ["cabbage:task:running"] },
                { number: 2, labels: ["cabbage:task:running"] },
                { number: 3, labels: ["cabbage:task:reviewing"] },
                { number: 4, labels: ["cabbage:task:running"] },
                { number: 5, labels: ["cabbage:task:running"] },
              ]),
              stderr: "",
            }
          }
          if (args.includes("issue list")) return { stdout: "13", stderr: "" }
          if (args.includes("issue view 13")) return { stdout: buildTaskBody("x", [], []), stderr: "" }
          throw new Error(`unexpected task gh: ${args}`)
        })
        setRecordsGhExecutor(async args => {
          if (args.includes("issue view 12")) return { stdout: "## Stages\n\n- [x] requirements\n- [x] design", stderr: "" }
          throw new Error(`unexpected records gh: ${args}`)
        })

        const result = await startTask(dir, 12, "user-auth-login")
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe("PARALLEL_LIMIT_REACHED")
      })
    })
  })

  describe("submit-task", () => {
    it("rejects when no evidence comment exists", async () => {
      await withProjectDir(async dir => {
        await writeTaskStateForTest(dir)
        setTaskGhExecutor(async args => {
          if (args.includes("issue list")) return { stdout: "13", stderr: "" }
          if (args.includes("issue view 13 --json body")) return { stdout: buildTaskBody("x", [], []), stderr: "" }
          throw new Error(`unexpected task gh: ${args}`)
        })
        setRecordsGhExecutor(async args => {
          if (args.includes("--json comments")) return { stdout: "null", stderr: "" }
          throw new Error(`unexpected records gh: ${args}`)
        })

        const result = await submitTask(dir, 12, "user-auth-login")
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe("TDD_EVIDENCE_INCOMPLETE")
      })
    })

    it("rejects when final regression is not pass", async () => {
      await withProjectDir(async dir => {
        await writeTaskStateForTest(dir)
        setTaskGhExecutor(async args => {
          if (args.includes("issue list")) return { stdout: "13", stderr: "" }
          if (args.includes("issue view 13 --json body")) {
            return { stdout: buildTaskBody("x", [{ id: "c1", description: "x", verification: "tdd" }], []), stderr: "" }
          }
          throw new Error(`unexpected task gh: ${args}`)
        })
        const regressionFailComment =
          "<!-- cabbage-tdd-evidence:start --> revision:2\n### stage: red\n- criterion: c1\n- status: red\n### stage: final-regression\n- status: fail\n<!-- cabbage-tdd-evidence:end -->"
        setRecordsGhExecutor(async args => {
          if (args.includes("--json comments")) {
            return { stdout: JSON.stringify({ id: 5, body: regressionFailComment }), stderr: "" }
          }
          throw new Error(`unexpected records gh: ${args}`)
        })

        const result = await submitTask(dir, 12, "user-auth-login")
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe("TDD_EVIDENCE_INCOMPLETE")
      })
    })

    it("pushes the branch, creates the PR referencing the task record, and marks reviewing", async () => {
      await withProjectDir(async dir => {
        await writeTaskStateForTest(dir)
        const calls: string[] = []
        setTaskGhExecutor(async args => {
          calls.push(args)
          if (args.includes("issue list")) return { stdout: "13", stderr: "" }
          if (args.includes("issue view 13 --json body")) {
            return { stdout: buildTaskBody("user-auth-login", [{ id: "c1", description: "x", verification: "tdd" }], []), stderr: "" }
          }
          if (args.includes("repo view")) return { stdout: "acme/repo", stderr: "" }
          if (args.includes("pr create")) return { stdout: "42", stderr: "" }
          if (args.includes("issue view 13 --json labels")) return { stdout: "", stderr: "" }
          if (args.includes("issue edit 13")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected task gh: ${args}`)
        })
        setTaskGitExecutor(async args => {
          if (args.includes("push -u origin")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected task git: ${args}`)
        })
        const completeComment =
          "<!-- cabbage-tdd-evidence:start --> revision:3\n### stage: green\n- criterion: c1\n- cycle: cyc-1\n- status: pass\n### stage: final-regression\n- status: pass\n### stage: final-verification\n- status: pass\n<!-- cabbage-tdd-evidence:end -->"
        setRecordsGhExecutor(async args => {
          if (args.includes("--json comments")) {
            return { stdout: JSON.stringify({ id: 5, body: completeComment }), stderr: "" }
          }
          throw new Error(`unexpected records gh: ${args}`)
        })

        const result = await submitTask(dir, 12, "user-auth-login")
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.prNumber).toBe(42)
          expect(result.evidenceRevision).toBe(3)
        }
        const createCall = calls.find(c => c.includes("pr create"))
        expect(createCall).toBeDefined()
        if (createCall) {
          expect(createCall).toContain("--head 'feat/user-auth-login'")
          expect(createCall).toContain("Closes #13")
          expect(createCall).toContain("#13")
        }
        expect(calls.some(c => c.includes("issue edit 13"))).toBe(true)
      })
    })

    it("parses JSON TDD state block (cabbage-tdd-state) taking the last block", async () => {
      await withProjectDir(async dir => {
        await writeTaskStateForTest(dir)
        setTaskGhExecutor(async args => {
          if (args.includes("issue list")) return { stdout: "13", stderr: "" }
          if (args.includes("issue view 13 --json body")) {
            return { stdout: buildTaskBody("user-auth-login", [{ id: "c1", description: "x", verification: "tdd" }], []), stderr: "" }
          }
          if (args.includes("repo view")) return { stdout: "acme/repo", stderr: "" }
          if (args.includes("pr create")) return { stdout: "42", stderr: "" }
          if (args.includes("issue view 13 --json labels")) return { stdout: "", stderr: "" }
          if (args.includes("issue edit 13")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected task gh: ${args}`)
        })
        setTaskGitExecutor(async args => {
          if (args.includes("push -u origin")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected task git: ${args}`)
        })
        const state = {
          schema: 1,
          evidence: {
            revision: 4,
            status: "pass",
            reworkRevision: 0,
            taskStart: { status: "pass", headSha: null, treeSha: null, startedAt: null },
            cycles: [{
              cycleId: "cyc-1",
              criterionId: "c1",
              status: "pass",
              startWorkspaceDigest: { algorithm: "sha256-content-v1", value: "0".repeat(64) },
              redAttempts: [],
              greenEvidence: null,
              redEvidence: null,
            }],
            regression: { status: "pass", headSha: null, treeSha: null, reworkRevision: 0, runs: [] },
            verification: { status: "pass", headSha: null, treeSha: null, runs: [] },
            alternativeValidation: [],
            reworks: [],
            warnings: [],
            updatedAt: null,
          },
        }
        const jsonComment =
          `<!-- cabbage-tdd-evidence:start --> revision:1\n### stage: green\n- status: pass\n<!-- cabbage-tdd-state -->\n${JSON.stringify(state)}\n<!-- cabbage-tdd-evidence:end -->`
        setRecordsGhExecutor(async args => {
          if (args.includes("--json comments")) {
            return { stdout: JSON.stringify({ id: 6, body: jsonComment }), stderr: "" }
          }
          throw new Error(`unexpected records gh: ${args}`)
        })

        const result = await submitTask(dir, 12, "user-auth-login")
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.evidenceRevision).toBe(4)
      })
    })

    it("passes the gate for waived evidence (not-applicable / exempt)", async () => {
      await withProjectDir(async dir => {
        await writeTaskStateForTest(dir)
        setTaskGhExecutor(async args => {
          if (args.includes("issue list")) return { stdout: "13", stderr: "" }
          if (args.includes("issue view 13 --json body")) {
            return { stdout: buildTaskBody("user-auth-login", [{ id: "c1", description: "x", verification: "tdd" }], []), stderr: "" }
          }
          if (args.includes("repo view")) return { stdout: "acme/repo", stderr: "" }
          if (args.includes("pr create")) return { stdout: "42", stderr: "" }
          if (args.includes("issue view 13 --json labels")) return { stdout: "", stderr: "" }
          if (args.includes("issue edit 13")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected task gh: ${args}`)
        })
        setTaskGitExecutor(async args => {
          if (args.includes("push -u origin")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected task git: ${args}`)
        })
        const waivedState = {
          schema: 1,
          evidence: {
            revision: 1,
            status: "waived",
            reworkRevision: 0,
            taskStart: { status: "pass", headSha: null, treeSha: null, startedAt: null },
            cycles: [],
            regression: { status: "pending", headSha: null, treeSha: null, reworkRevision: 0, runs: [] },
            verification: { status: "pending", headSha: null, treeSha: null, runs: [] },
            alternativeValidation: [],
            reworks: [],
            warnings: ["not-applicable"],
            updatedAt: null,
          },
        }
        const waivedComment = `<!-- cabbage-tdd-evidence:start --> revision:1\n### stage: waived\n- status: waived\n<!-- cabbage-tdd-state -->\n${JSON.stringify(waivedState)}\n<!-- cabbage-tdd-evidence:end -->`
        setRecordsGhExecutor(async args => {
          if (args.includes("--json comments")) {
            return { stdout: JSON.stringify({ id: 7, body: waivedComment }), stderr: "" }
          }
          throw new Error(`unexpected records gh: ${args}`)
        })

        const result = await submitTask(dir, 12, "user-auth-login")
        expect(result.ok).toBe(true)
      })
    })
  })

  describe("submit-review", () => {
    it("submits an approve review", async () => {
      await withProjectDir(async dir => {
        const calls: string[] = []
        setTaskGhExecutor(async args => {
          calls.push(args)
          if (args.includes("pr review 42 --approve")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected task gh: ${args}`)
        })
        const resp = await executeOp(dir, "submit-review", { pr_number: 42, verdict: "approve" })
        expect(resp.ok).toBe(true)
        expect(calls.some(c => c.includes("pr review 42 --approve"))).toBe(true)
      })
    })

    it("submits a request-changes review with a comment", async () => {
      await withProjectDir(async dir => {
        const calls: string[] = []
        setTaskGhExecutor(async args => {
          calls.push(args)
          if (args.includes("pr review 42 --request-changes")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected task gh: ${args}`)
        })
        const resp = await executeOp(dir, "submit-review", { pr_number: 42, verdict: "request-changes", comment: "fix X" })
        expect(resp.ok).toBe(true)
        expect(calls.some(c => c.includes("pr review 42 --request-changes") && c.includes("fix X"))).toBe(true)
      })
    })
  })

  describe("merge-task", () => {
    const state = (dir: string, overrides: Partial<TaskRuntimeState> = {}): TaskRuntimeState => ({
      slug: "user-auth-login",
      parentIssueNumber: 12,
      issueNumber: 13,
      branch: "feat/user-auth-login",
      worktreePath: join(dir, ".worktree", "user-auth-login"),
      policy: freezeTddPolicy({
        testCommand: "cabbage-test-tool run",
        regressionCommand: null,
        testFilePatterns: [],
        implementationFilePatterns: [],
        tddDefaultMode: "strict",
        versionBumpRule: null,
        versionFile: null,
        tagFormat: null,
        releaseWorkflowPath: null,
        riskPatterns: [],
      }),
      baseline: {
        digest: { algorithm: "sha256-content-v1", value: "abc" },
        capturedAt: new Date().toISOString(),
        testFilePatterns: [],
        implementationFilePatterns: [],
      },
      startedAt: new Date().toISOString(),
      ...overrides,
    })

    async function writeStateFor(dir: string, overrides: Partial<TaskRuntimeState> = {}) {
      await mkdir(join(dir, ".opencode", "opencode-cabbage", "task-state"), { recursive: true })
      const { writeFile: wf } = await import("node:fs/promises")
      await wf(join(dir, ".opencode", "opencode-cabbage", "task-state", "user-auth-login.json"), JSON.stringify(state(dir, overrides), null, 2), "utf8")
    }

    it("rejects when CI checks are not all passing", async () => {
      await withProjectDir(async dir => {
        await writeStateFor(dir)
        setTaskGhExecutor(async args => {
          if (args.includes("issue list")) return { stdout: "13", stderr: "" }
          if (args.includes("pr list --head")) {
            return { stdout: JSON.stringify({ number: 42, headRefOid: "sha1", author: { login: "dev" } }), stderr: "" }
          }
          if (args.includes("pr view 42 --json statusCheckRollup")) {
            return { stdout: JSON.stringify([{ name: "CI", state: "PENDING" }]), stderr: "" }
          }
          throw new Error(`unexpected task gh: ${args}`)
        })
        const result = await mergeTask(dir, 12, "user-auth-login", "low")
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe("CI_CHECKS_NOT_PASSED")
      })
    })

    it("rejects when branch protection is not enabled", async () => {
      await withProjectDir(async dir => {
        await writeStateFor(dir)
        setTaskGhExecutor(async args => {
          if (args.includes("issue list")) return { stdout: "13", stderr: "" }
          if (args.includes("pr list --head")) {
            return { stdout: JSON.stringify({ number: 42, headRefOid: "sha1", author: { login: "dev" } }), stderr: "" }
          }
          if (args.includes("pr view 42 --json statusCheckRollup")) return { stdout: "[]", stderr: "" }
          if (args.includes("repo view")) return { stdout: "acme/repo", stderr: "" }
          if (args.includes("pr view 42 --json files")) return { stdout: "[]", stderr: "" }
          throw new Error(`unexpected task gh: ${args}`)
        })
        setMergeGhExecutor(async args => {
          if (args.includes("branches/main/protection")) {
            // gh api 404（无分支保护）→ executor 抛错
            throw new Error("HTTP 404: branch protection not found")
          }
          throw new Error(`unexpected merge gh: ${args}`)
        })
        const result = await mergeTask(dir, 12, "user-auth-login", "low")
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe("BRANCH_PROTECTION_REQUIRED")
      })
    })

    it("rejects a high-risk diff without a non-author human approval", async () => {
      await withProjectDir(async dir => {
        await writeStateFor(dir)
        setTaskGhExecutor(async args => {
          if (args.includes("issue list")) return { stdout: "13", stderr: "" }
          if (args.includes("pr list --head")) {
            return { stdout: JSON.stringify({ number: 42, headRefOid: "sha1", author: { login: "dev" } }), stderr: "" }
          }
          if (args.includes("pr view 42 --json statusCheckRollup")) return { stdout: "[]", stderr: "" }
          if (args.includes("repo view")) return { stdout: "acme/repo", stderr: "" }
          if (args.includes("pr view 42 --json files")) {
            return { stdout: JSON.stringify(["src/db/migrations/001.sql"]), stderr: "" }
          }
          if (args.includes("--json author,reviews")) {
            return { stdout: JSON.stringify({ author: "dev", reviews: [] }), stderr: "" }
          }
          throw new Error(`unexpected task gh: ${args}`)
        })
        setMergeGhExecutor(async args => {
          if (args.includes("branches/main/protection")) {
            return {
              stdout: JSON.stringify({
                required_pull_request_reviews: { dismiss_stale_reviews: false },
                required_status_checks: { checks: [] },
              }),
              stderr: "",
            }
          }
          throw new Error(`unexpected merge gh: ${args}`)
        })
        const result = await mergeTask(dir, 12, "user-auth-login", "low")
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe("HIGH_RISK_APPROVAL_REQUIRED")
      })
    })

    it("merges a clean low-risk PR, closes the issue, and destroys the worktree", async () => {
      await withProjectDir(async dir => {
        await writeStateFor(dir)
        await mkdir(join(dir, ".worktree", "user-auth-login"), { recursive: true })
        const calls: string[] = []
        setTaskGhExecutor(async args => {
          calls.push(args)
          if (args.includes("issue list")) return { stdout: "13", stderr: "" }
          if (args.includes("pr list --head")) {
            return { stdout: JSON.stringify({ number: 42, headRefOid: "sha1", author: { login: "dev" } }), stderr: "" }
          }
          if (args.includes("pr view 42 --json statusCheckRollup")) return { stdout: "[]", stderr: "" }
          if (args.includes("repo view")) return { stdout: "acme/repo", stderr: "" }
          if (args.includes("pr view 42 --json files")) return { stdout: "[]", stderr: "" }
          if (args.includes("issue close 13")) return { stdout: "", stderr: "" }
          if (args.includes("issue view 13 --json labels")) return { stdout: "", stderr: "" }
          if (args.includes("issue edit 13")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected task gh: ${args}`)
        })
        setMergeGhExecutor(async args => {
          if (args.includes("branches/main/protection")) {
            return {
              stdout: JSON.stringify({
                required_pull_request_reviews: { dismiss_stale_reviews: false },
                required_status_checks: { checks: [] },
              }),
              stderr: "",
            }
          }
          if (args.includes("pr merge 42")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected merge gh: ${args}`)
        })
        setWorktreeGitExecutor(async args => {
          if (args.includes("status --porcelain")) return { stdout: "", stderr: "" }
          if (args.includes("worktree remove")) return { stdout: "", stderr: "" }
          if (args.includes("refs/heads/")) return { stdout: "abc", stderr: "" }
          if (args.includes("branch -D")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected worktree git: ${args}`)
        })

        const result = await mergeTask(dir, 12, "user-auth-login", "low")
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.prNumber).toBe(42)
          expect(result.risk).toBe("low")
        }
        expect(calls.some(c => c.includes("issue close 13"))).toBe(true)
        expect(calls.some(c => c.includes("--add-label 'cabbage:task:merged'"))).toBe(true)
      })
    })

    it("merges when CI checks are GitHub Actions CheckRuns (conclusion field)", async () => {
      await withProjectDir(async dir => {
        await writeStateFor(dir)
        await mkdir(join(dir, ".worktree", "user-auth-login"), { recursive: true })
        setTaskGhExecutor(async args => {
          if (args.includes("issue list")) return { stdout: "13", stderr: "" }
          if (args.includes("pr list --head")) {
            return { stdout: JSON.stringify({ number: 42, headRefOid: "sha1", author: { login: "dev" } }), stderr: "" }
          }
          if (args.includes("pr view 42 --json statusCheckRollup")) {
            // 真实 gh 经 jq 转换：CheckRun（name+conclusion）→ {name, state}
            return { stdout: JSON.stringify([{ name: "verify", state: "SUCCESS" }]), stderr: "" }
          }
          if (args.includes("repo view")) return { stdout: "acme/repo", stderr: "" }
          if (args.includes("pr view 42 --json files")) return { stdout: "[]", stderr: "" }
          if (args.includes("issue close 13")) return { stdout: "", stderr: "" }
          if (args.includes("issue view 13 --json labels")) return { stdout: "", stderr: "" }
          if (args.includes("issue edit 13")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected task gh: ${args}`)
        })
        setMergeGhExecutor(async args => {
          if (args.includes("branches/main/protection")) {
            return {
              stdout: JSON.stringify({
                required_pull_request_reviews: { dismiss_stale_reviews: false },
                required_status_checks: { checks: [] },
              }),
              stderr: "",
            }
          }
          if (args.includes("pr merge 42")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected merge gh: ${args}`)
        })
        setWorktreeGitExecutor(async () => ({ stdout: "", stderr: "" }))
        const result = await mergeTask(dir, 12, "user-auth-login", "low")
        expect(result.ok).toBe(true)
      })
    })

    it("merges a high-risk PR when a non-author human approved", async () => {
      await withProjectDir(async dir => {
        await writeStateFor(dir)
        setTaskGhExecutor(async args => {
          if (args.includes("issue list")) return { stdout: "13", stderr: "" }
          if (args.includes("pr list --head")) {
            return { stdout: JSON.stringify({ number: 42, headRefOid: "sha1", author: { login: "dev" } }), stderr: "" }
          }
          if (args.includes("pr view 42 --json statusCheckRollup")) return { stdout: "[]", stderr: "" }
          if (args.includes("repo view")) return { stdout: "acme/repo", stderr: "" }
          if (args.includes("pr view 42 --json files")) {
            return { stdout: JSON.stringify(["src/db/migrations/001.sql"]), stderr: "" }
          }
          if (args.includes("--json author,reviews")) {
            return {
              stdout: JSON.stringify({
                author: "dev",
                reviews: [{ state: "APPROVED", login: "human-boss", type: "User" }],
              }),
              stderr: "",
            }
          }
          if (args.includes("issue close 13")) return { stdout: "", stderr: "" }
          if (args.includes("issue view 13 --json labels")) return { stdout: "", stderr: "" }
          if (args.includes("issue edit 13")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected task gh: ${args}`)
        })
        setMergeGhExecutor(async args => {
          if (args.includes("branches/main/protection")) {
            return {
              stdout: JSON.stringify({
                required_pull_request_reviews: { dismiss_stale_reviews: false },
                required_status_checks: { checks: [] },
              }),
              stderr: "",
            }
          }
          if (args.includes("pr merge 42")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected merge gh: ${args}`)
        })
        setWorktreeGitExecutor(async args => {
          if (args.includes("status --porcelain")) return { stdout: "", stderr: "" }
          if (args.includes("worktree remove")) return { stdout: "", stderr: "" }
          if (args.includes("refs/heads/")) return { stdout: "abc", stderr: "" }
          if (args.includes("branch -D")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected worktree git: ${args}`)
        })

        const result = await mergeTask(dir, 12, "user-auth-login", "low")
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.risk).toBe("high")
      })
    })
  })

  describe("cancel-task / destroy-worktree / status-task", () => {
    it("cancel-task requires user confirmation", async () => {
      await withProjectDir(async dir => {
        const result = await cancelTask(dir, 12, "user-auth-login", false)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe("USER_CONFIRMATION_REQUIRED")
      })
    })

    it("cancel-task closes the issue and marks cancelled when confirmed", async () => {
      await withProjectDir(async dir => {
        const calls: string[] = []
        setTaskGhExecutor(async args => {
          calls.push(args)
          if (args.includes("issue list")) return { stdout: "13", stderr: "" }
          if (args.includes("issue close 13")) return { stdout: "", stderr: "" }
          if (args.includes("issue view 13 --json labels")) return { stdout: "", stderr: "" }
          if (args.includes("issue edit 13")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected task gh: ${args}`)
        })
        const result = await cancelTask(dir, 12, "user-auth-login", true)
        expect(result.ok).toBe(true)
        expect(calls.some(c => c.includes("issue close 13"))).toBe(true)
        expect(calls.some(c => c.includes("--add-label 'cabbage:task:cancelled'"))).toBe(true)
      })
    })

    it("destroy-worktree requires user confirmation when the PR is not merged", async () => {
      await withProjectDir(async dir => {
        await mkdir(join(dir, ".opencode", "opencode-cabbage", "task-state"), { recursive: true })
        const { writeFile: wf } = await import("node:fs/promises")
        await wf(
          join(dir, ".opencode", "opencode-cabbage", "task-state", "user-auth-login.json"),
          JSON.stringify({
            slug: "user-auth-login",
            parentIssueNumber: 12,
            issueNumber: 13,
            branch: "feat/user-auth-login",
            worktreePath: join(dir, ".worktree", "user-auth-login"),
            policy: null,
            baseline: null,
            startedAt: new Date().toISOString(),
          }),
          "utf8",
        )
        await mkdir(join(dir, ".worktree", "user-auth-login"), { recursive: true })
        setTaskGhExecutor(async args => {
          if (args.includes("issue list")) return { stdout: "13", stderr: "" }
          if (args.includes("pr list --head")) return { stdout: "0", stderr: "" }
          throw new Error(`unexpected task gh: ${args}`)
        })
        setWorktreeGitExecutor(async args => {
          if (args.includes("status --porcelain")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected worktree git: ${args}`)
        })
        const result = await destroyTaskWorktree(dir, 12, "user-auth-login", false)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.code).toBe("PR_NOT_MERGED")
      })
    })

    it("destroy-worktree removes a clean worktree when the PR is merged", async () => {
      await withProjectDir(async dir => {
        await mkdir(join(dir, ".opencode", "opencode-cabbage", "task-state"), { recursive: true })
        const { writeFile: wf } = await import("node:fs/promises")
        await wf(
          join(dir, ".opencode", "opencode-cabbage", "task-state", "user-auth-login.json"),
          JSON.stringify({
            slug: "user-auth-login",
            parentIssueNumber: 12,
            issueNumber: 13,
            branch: "feat/user-auth-login",
            worktreePath: join(dir, ".worktree", "user-auth-login"),
            policy: null,
            baseline: null,
            startedAt: new Date().toISOString(),
          }),
          "utf8",
        )
        await mkdir(join(dir, ".worktree", "user-auth-login"), { recursive: true })
        setTaskGhExecutor(async args => {
          if (args.includes("issue list")) return { stdout: "13", stderr: "" }
          if (args.includes("pr list --head")) return { stdout: "1", stderr: "" }
          throw new Error(`unexpected task gh: ${args}`)
        })
        setWorktreeGitExecutor(async args => {
          if (args.includes("status --porcelain")) return { stdout: "", stderr: "" }
          if (args.includes("worktree remove")) return { stdout: "", stderr: "" }
          if (args.includes("refs/heads/")) return { stdout: "abc", stderr: "" }
          if (args.includes("branch -D")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected worktree git: ${args}`)
        })
        const result = await destroyTaskWorktree(dir, 12, "user-auth-login", false)
        expect(result.ok).toBe(true)
        if (result.ok) expect(result.reason).toBe("OK")
      })
    })

    it("status-task aggregates the task record, PR, and checks", async () => {
      await withProjectDir(async dir => {
        setTaskGhExecutor(async args => {
          if (args.includes("issue list")) return { stdout: "13", stderr: "" }
          if (args.includes("issue view 13 --json number,title,state,labels,body")) {
            return {
              stdout: JSON.stringify({ number: 13, title: "user-auth-login", state: "OPEN", labels: ["cabbage:task:running"], body: "# Task: user-auth-login" }),
              stderr: "",
            }
          }
          if (args.includes("pr list --head 'feat/user-auth-login'")) {
            return {
              stdout: JSON.stringify([{ number: 42, state: "OPEN", headRefName: "feat/user-auth-login" }]),
              stderr: "",
            }
          }
          if (args.includes("pr view 42")) {
            return { stdout: JSON.stringify([{ name: "CI", state: "SUCCESS" }]), stderr: "" }
          }
          throw new Error(`unexpected task gh: ${args}`)
        })
        const result = await readTaskStatus(dir, 12, "user-auth-login")
        expect(result.ok).toBe(true)
        if (result.ok) {
          expect(result.report.task.issueNumber).toBe(13)
          expect(result.report.pullRequests).toHaveLength(1)
          expect(result.report.pullRequests[0]).toMatchObject({ number: 42, state: "OPEN" })
          expect(result.report.pullRequests[0].checks).toEqual([{ name: "CI", state: "SUCCESS" }])
        }
      })
    })
  })
})

describe("registerTaskControl", () => {
  it("mounts task_control on the tool registry", () => {
    const registry: Record<string, unknown> = {}
    registerTaskControl(registry, { projectDir: ".", sessionClient: primaryClient })
    expect(registry.task_control).toBeDefined()
  })
})

/** 写一个最小可用的 task-state（submit-task 测试用） */
async function writeTaskStateForTest(dir: string) {
  const { writeFile: wf } = await import("node:fs/promises")
  await mkdir(join(dir, ".opencode", "opencode-cabbage", "task-state"), { recursive: true })
  await wf(
    join(dir, ".opencode", "opencode-cabbage", "task-state", "user-auth-login.json"),
    JSON.stringify({
      slug: "user-auth-login",
      parentIssueNumber: 12,
      issueNumber: 13,
      branch: "feat/user-auth-login",
      worktreePath: join(dir, ".worktree", "user-auth-login"),
      policy: freezeTddPolicy({
        testCommand: "cabbage-test-tool run",
        regressionCommand: null,
        testFilePatterns: [],
        implementationFilePatterns: [],
        tddDefaultMode: "strict",
        versionBumpRule: null,
        versionFile: null,
        tagFormat: null,
        releaseWorkflowPath: null,
        riskPatterns: [],
      }),
      baseline: {
        digest: { algorithm: "sha256-content-v1", value: "abc" },
        capturedAt: new Date().toISOString(),
        testFilePatterns: [],
        implementationFilePatterns: [],
      },
      startedAt: new Date().toISOString(),
    }),
    "utf8",
  )
}

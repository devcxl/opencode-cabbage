/**
 * 对抗测试 #3 — 缺 RED evidence 直接提交 PR：
 * 低质量模型跳过 TDD 直接 submit-task → 必须被 TDD_EVIDENCE_INCOMPLETE 拒绝，
 * 且不得创建 PR（无 gh pr create / git push）。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { submitTask, setTaskGhExecutor, setTaskGitExecutor, freezeTddPolicy } from "../../src/kernel/task.js"
import { setRecordsGhExecutor } from "../../src/kernel/records.js"
import { setWorktreeGitExecutor } from "../../src/kernel/worktree.js"
import { setMergeGhExecutor } from "../../src/kernel/review.js"

function writeTaskState(dir: string) {
  return (async () => {
    const { writeFile } = await import("node:fs/promises")
    await mkdir(join(dir, ".opencode", "opencode-cabbage", "task-state"), { recursive: true })
    await writeFile(
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
  })()
}

function buildTaskBody(criteriaLine: string): string {
  return [
    "# Task: user-auth-login",
    "",
    "## Acceptance Criteria",
    "",
    criteriaLine,
    "",
    "## Dependencies",
    "",
    "- none",
    "",
    "## Status",
    "",
    "- [ ] running",
    "- [ ] reviewing",
    "- [ ] merged",
    "",
  ].join("\n")
}

describe("adversarial #3 — 缺 RED evidence 直接 submit 必须被拒", () => {
  beforeEach(async () => {
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
  })

  afterEach(() => {
    setTaskGhExecutor(null)
    setTaskGitExecutor(null)
    setRecordsGhExecutor(null)
    setWorktreeGitExecutor(null)
    setMergeGhExecutor(() => {
      throw new Error("unexpected merge gh")
    })
  })

  it("完全没有 evidence comment → TDD_EVIDENCE_INCOMPLETE，且无任何写调用", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cabbage-adv-submit-"))
    try {
      await writeTaskState(dir)
      const calls: string[] = []
      setTaskGhExecutor(async args => {
        calls.push(args)
        if (args.includes("issue list")) return { stdout: "13", stderr: "" }
        if (args.includes("issue view 13 --json body")) return { stdout: buildTaskBody("- [ ] c1: x [tdd]"), stderr: "" }
        throw new Error(`unexpected task gh: ${args}`)
      })
      setRecordsGhExecutor(async args => {
        if (args.includes("--json comments")) return { stdout: "null", stderr: "" }
        throw new Error(`unexpected records gh: ${args}`)
      })

      const result = await submitTask(dir, 12, "user-auth-login")
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("TDD_EVIDENCE_INCOMPLETE")
        expect(result.missing).toContain("evidence-comment")
      }
      expect(calls.some(c => c.includes("pr create"))).toBe(false)
      expect(calls.some(c => c.includes("push"))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("只有 RED 记录、无 final-regression/verification → 仍被拒（证据不完整）", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cabbage-adv-submit-"))
    try {
      await writeTaskState(dir)
      const calls: string[] = []
      setTaskGhExecutor(async args => {
        calls.push(args)
        if (args.includes("issue list")) return { stdout: "13", stderr: "" }
        if (args.includes("issue view 13 --json body")) {
          return { stdout: buildTaskBody("- [ ] c1: x [tdd]"), stderr: "" }
        }
        throw new Error(`unexpected task gh: ${args}`)
      })
      const redOnlyComment =
        "<!-- cabbage-tdd-evidence:start --> revision:1\n### stage: red\n- criterion: c1\n- cycle: cyc-1\n- status: red\n<!-- cabbage-tdd-evidence:end -->"
      setRecordsGhExecutor(async args => {
        if (args.includes("--json comments")) {
          return { stdout: JSON.stringify({ id: 5, body: redOnlyComment }), stderr: "" }
        }
        throw new Error(`unexpected records gh: ${args}`)
      })

      const result = await submitTask(dir, 12, "user-auth-login")
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("TDD_EVIDENCE_INCOMPLETE")
        expect(result.missing?.length ?? 0).toBeGreaterThan(0)
      }
      expect(calls.some(c => c.includes("pr create"))).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { containsLegacyMarker, detectLegacyFlowRun } from "../../src/kernel/legacy.js"
import {
  buildFlowBody,
  getCompletedStages,
  markStageComplete,
  getCurrentStage,
  checkStageGate,
  filterRelatedPrs,
  summarizeChecks,
  readFlowStatus,
  planningStart,
  planningPr,
  setFlowGhExecutor,
  setFlowGitExecutor,
  createFlow,
  completeFlow,
  cancelFlow,
  takeoverFlow,
} from "../../src/kernel/flow.js"
import { setWorktreeGitExecutor } from "../../src/kernel/worktree.js"
import { setRecordsGhExecutor } from "../../src/kernel/records.js"
import { readIndex, writeIndex } from "../../src/kernel/session-index.js"
import { createFlowControlTool, registerFlowControl } from "../../src/plugin/flow-control.js"

describe("legacy FlowRun detection (spec §11.2)", () => {
  it("containsLegacyMarker requires both cabinet markers", () => {
    const legacyBody = "<!-- cabbage-flow-run:start -->\n```json\n{}\n```\n<!-- cabbage-flow-run:end -->"
    expect(containsLegacyMarker(legacyBody)).toBe(true)
    expect(containsLegacyMarker("no markers here")).toBe(false)
    expect(containsLegacyMarker("<!-- cabbage-flow-run:start --> only")).toBe(false)
    expect(containsLegacyMarker("<!-- cabbage-flow-run:end --> only")).toBe(false)
  })

  it("detectLegacyFlowRun reports legacy with the flowRunId", async () => {
    const gh = async () => ({
      stdout:
        "<!-- cabbage-flow-run:start -->\n```json\n{\"flowRunId\": \"fr-123\"}\n```\n<!-- cabbage-flow-run:end -->",
      stderr: "",
    })
    const result = await detectLegacyFlowRun(12, gh)
    expect(result).toEqual({ legacy: true, flowRunId: "fr-123" })
  })

  it("detectLegacyFlowRun reports legacy without an id when the id is missing", async () => {
    const gh = async () => ({ stdout: "<!-- cabbage-flow-run:start -->\n<!-- cabbage-flow-run:end -->", stderr: "" })
    const result = await detectLegacyFlowRun(12, gh)
    expect(result).toEqual({ legacy: true })
  })

  it("detectLegacyFlowRun returns legacy false for a new-style issue body", async () => {
    const gh = async () => ({ stdout: "## Stages\n\n- [ ] requirements\n- [ ] design", stderr: "" })
    const result = await detectLegacyFlowRun(12, gh)
    expect(result).toEqual({ legacy: false })
  })

  it("detectLegacyFlowRun returns legacy false when the issue cannot be read", async () => {
    const gh = async () => {
      throw new Error("gh failed")
    }
    const result = await detectLegacyFlowRun(12, gh)
    expect(result).toEqual({ legacy: false })
  })
})

describe("flow kernel pure functions", () => {
  describe("buildFlowBody", () => {
    it("includes the slug, goal, acceptance, and the five stage checkboxes", () => {
      const body = buildFlowBody("planning-baseline")
      expect(body).toContain("planning-baseline")
      for (const stage of ["requirements", "design", "tasks", "code", "review"]) {
        expect(body).toContain(`- [ ] ${stage}`)
      }
    })
  })

  describe("getCompletedStages / markStageComplete", () => {
    it("extracts completed stages from the checklist", () => {
      const body = buildFlowBody("x").replace("- [ ] requirements", "- [x] requirements")
      expect(getCompletedStages(body)).toEqual(["requirements"])
    })

    it("marks a stage complete and is idempotent", () => {
      const body = buildFlowBody("x")
      const marked = markStageComplete(body, "design")
      expect(marked).toContain("- [x] design")
      expect(getCompletedStages(marked)).toEqual(["design"])
      expect(markStageComplete(marked, "design")).toBe(marked)
    })

    it("ignores non-stage checkboxes", () => {
      const body = "## Acceptance Criteria\n\n- [x] TBD\n\n## Stages\n\n- [ ] code"
      expect(getCompletedStages(body)).toEqual([])
    })
  })

  describe("getCurrentStage", () => {
    it("returns the furthest cabbage:stage:* label", () => {
      expect(getCurrentStage(["cabbage:flow", "cabbage:stage:requirements"])).toBe("requirements")
      expect(getCurrentStage(["cabbage:stage:requirements", "cabbage:stage:design"])).toBe("design")
    })

    it("returns null when no stage label exists", () => {
      expect(getCurrentStage(["cabbage:flow"])).toBeNull()
    })
  })

  describe("checkStageGate (spec §2.3 前置门禁)", () => {
    it("stage-start requirements has no prerequisite", () => {
      expect(checkStageGate("stage-start", "requirements", [], false, false).ok).toBe(true)
    })

    it("stage-start design requires requirements completed", () => {
      expect(checkStageGate("stage-start", "design", [], false, false)).toMatchObject({
        ok: false,
        code: "REQUIREMENTS_NOT_COMPLETE",
      })
      expect(checkStageGate("stage-start", "design", ["requirements"], false, false).ok).toBe(true)
    })

    it("stage-start tasks requires design and pauses on high-risk without confirmation", () => {
      expect(checkStageGate("stage-start", "tasks", ["requirements"], false, false)).toMatchObject({
        ok: false,
        code: "DESIGN_NOT_COMPLETE",
      })
      expect(checkStageGate("stage-start", "tasks", ["requirements", "design"], true, false)).toMatchObject({
        ok: false,
        code: "RISK_CONFIRMATION_REQUIRED",
      })
      expect(checkStageGate("stage-start", "tasks", ["requirements", "design"], true, true).ok).toBe(true)
      expect(checkStageGate("stage-start", "tasks", ["requirements", "design"], false, false).ok).toBe(true)
    })

    it("stage-start code/review require the previous stage", () => {
      expect(checkStageGate("stage-start", "code", ["requirements", "design"], false, false)).toMatchObject({
        ok: false,
        code: "TASKS_NOT_COMPLETE",
      })
      expect(checkStageGate("stage-start", "code", ["requirements", "design", "tasks"], false, false).ok).toBe(true)
      expect(checkStageGate("stage-start", "review", ["requirements", "design", "tasks"], false, false)).toMatchObject({
        ok: false,
        code: "CODE_NOT_COMPLETE",
      })
    })

    it("stage-complete requirements requires user confirmation once", () => {
      expect(checkStageGate("stage-complete", "requirements", [], false, false)).toMatchObject({
        ok: false,
        code: "REQUIREMENTS_CONFIRMATION_REQUIRED",
      })
      expect(checkStageGate("stage-complete", "requirements", [], false, true).ok).toBe(true)
    })

    it("stage-complete is idempotent once the stage is already completed", () => {
      expect(checkStageGate("stage-complete", "requirements", ["requirements"], false, false).ok).toBe(true)
    })

    it("stage-complete design requires requirements completed", () => {
      expect(checkStageGate("stage-complete", "design", [], false, true)).toMatchObject({
        ok: false,
        code: "REQUIREMENTS_NOT_COMPLETE",
      })
      expect(checkStageGate("stage-complete", "design", ["requirements"], false, true).ok).toBe(true)
    })

    it("stage-complete tasks requires high-risk confirmation（不可绕过 stage-start）", () => {
      expect(checkStageGate("stage-complete", "tasks", ["requirements", "design"], true, false)).toMatchObject({
        ok: false,
        code: "RISK_CONFIRMATION_REQUIRED",
      })
      expect(checkStageGate("stage-complete", "tasks", ["requirements", "design"], true, true).ok).toBe(true)
      expect(checkStageGate("stage-complete", "tasks", ["requirements", "design"], false, false).ok).toBe(true)
    })
  })
})

describe("status aggregation (spec §2.3 status)", () => {
  describe("filterRelatedPrs / summarizeChecks", () => {
    it("filters PRs referencing the flow or its subtasks", () => {
      const prs = [
        { number: 1, body: "Closes #13" },
        { number: 2, body: "Refs #12" },
        { number: 3, body: "unrelated work" },
      ]
      expect(filterRelatedPrs(prs, 12, [13])).toEqual([
        { number: 1, body: "Closes #13" },
        { number: 2, body: "Refs #12" },
      ])
    })

    it("summarizes the check rollup into name/state pairs", () => {
      expect(
        summarizeChecks([{ name: "CI", state: "SUCCESS" }, { context: "lint", state: "FAILURE" }]),
      ).toEqual([
        { name: "CI", state: "SUCCESS" },
        { name: "lint", state: "FAILURE" },
      ])
    })
  })

  describe("readFlowStatus", () => {
    afterEach(() => {
      setFlowGhExecutor(null)
    })

    it("aggregates flow record, subtasks, and related PR checks", async () => {
      const calls: string[] = []
      setFlowGhExecutor(async args => {
        calls.push(args)
        if (args.includes("issue view")) {
          return {
            stdout: JSON.stringify({
              number: 12,
              title: "planning-baseline",
              state: "OPEN",
              labels: ["cabbage:flow", "cabbage:stage:requirements"],
              body: "## Stages\n\n- [x] requirements\n- [ ] design",
            }),
            stderr: "",
          }
        }
        if (args.includes("issue list")) {
          return { stdout: JSON.stringify([{ number: 13, title: "flow-record-layer", state: "OPEN" }]), stderr: "" }
        }
        if (args.includes("pr list")) {
          return {
            stdout: JSON.stringify([
              { number: 99, title: "docs: planning baseline", state: "OPEN", headRefName: "docs/planning-x", body: "Closes #13" },
            ]),
            stderr: "",
          }
        }
        if (args.includes("pr view")) {
          return { stdout: JSON.stringify([{ name: "CI", state: "SUCCESS" }]), stderr: "" }
        }
        throw new Error(`unexpected gh call: ${args}`)
      })

      const result = await readFlowStatus(12)
      expect(result.ok).toBe(true)
      const status = result.status
      expect(status.flow.title).toBe("planning-baseline")
      expect(status.stages.current).toBe("requirements")
      expect(status.subtasks).toEqual([{ number: 13, title: "flow-record-layer", state: "OPEN" }])
      expect(status.pullRequests).toHaveLength(1)
      expect(status.pullRequests[0]).toMatchObject({ number: 99, state: "OPEN" })
      expect(status.pullRequests[0].checks).toEqual([{ name: "CI", state: "SUCCESS" }])
    })

    it("returns NOT_FOUND when the flow record cannot be read", async () => {
      setFlowGhExecutor(async () => {
        throw new Error("not found")
      })
      const result = await readFlowStatus(12)
      expect(result.ok).toBe(false)
      expect(result.code).toBe("NOT_FOUND")
    })
  })
})

describe("planning worktree (spec §2.3 planning-start / planning-pr)", () => {
  afterEach(() => {
    setFlowGhExecutor(null)
    setFlowGitExecutor(null)
    setWorktreeGitExecutor(null)
  })

  it("planning-start creates the planning worktree with the flow slug", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cabbage-flow-plan-"))
    try {
      setFlowGhExecutor(async args => {
        if (args.includes("issue view")) return { stdout: "planning-baseline", stderr: "" }
        if (args.includes("repo view")) return { stdout: "main", stderr: "" }
        throw new Error(`unexpected gh: ${args}`)
      })
      setWorktreeGitExecutor(async args => {
        if (args.includes("worktree add")) return { stdout: "", stderr: "" }
        throw new Error(`unexpected git: ${args}`)
      })

      const result = await planningStart(dir, 12)
      expect(result.ok).toBe(true)
      expect(result.branch).toBe("docs/planning-planning-baseline")
      expect(result.worktreePath).toBe(join(dir, ".worktree", "planning-planning-baseline"))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("planning-start fails when the flow record cannot be read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cabbage-flow-plan-"))
    try {
      setFlowGhExecutor(async () => {
        throw new Error("not found")
      })
      const result = await planningStart(dir, 12)
      expect(result.ok).toBe(false)
      expect(result.code).toBe("NOT_FOUND")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("planning-pr commits, pushes, and creates the Planning PR", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cabbage-flow-plan-"))
    try {
      await mkdir(join(dir, ".worktree", "planning-planning-baseline"), { recursive: true })
      setFlowGhExecutor(async args => {
        if (args.includes("issue view")) return { stdout: "planning-baseline", stderr: "" }
        if (args.includes("repo view")) return { stdout: "main", stderr: "" }
        if (args.includes("pr create")) return { stdout: "42", stderr: "" }
        throw new Error(`unexpected gh: ${args}`)
      })
      setFlowGitExecutor(async args => {
        if (args.includes("status --porcelain")) return { stdout: " M docs/planning.md\n", stderr: "" }
        if (args.includes("add")) return { stdout: "", stderr: "" }
        if (args.includes("commit")) return { stdout: "", stderr: "" }
        if (args.includes("push")) return { stdout: "", stderr: "" }
        throw new Error(`unexpected git: ${args}`)
      })

      const result = await planningPr(dir, 12)
      expect(result.ok).toBe(true)
      expect(result.prNumber).toBe(42)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("planning-pr refuses when the planning worktree does not exist", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cabbage-flow-plan-"))
    try {
      setFlowGhExecutor(async args => {
        if (args.includes("issue view")) return { stdout: "planning-baseline", stderr: "" }
        throw new Error(`unexpected gh: ${args}`)
      })
      const result = await planningPr(dir, 12)
      expect(result.ok).toBe(false)
      expect(result.code).toBe("PLANNING_WORKTREE_NOT_FOUND")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("planning-pr refuses when there is nothing to commit", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cabbage-flow-plan-"))
    try {
      await mkdir(join(dir, ".worktree", "planning-planning-baseline"), { recursive: true })
      setFlowGhExecutor(async args => {
        if (args.includes("issue view")) return { stdout: "planning-baseline", stderr: "" }
        throw new Error(`unexpected gh: ${args}`)
      })
      setFlowGitExecutor(async args => {
        if (args.includes("status --porcelain")) return { stdout: "", stderr: "" }
        throw new Error(`unexpected git: ${args}`)
      })
      const result = await planningPr(dir, 12)
      expect(result.ok).toBe(false)
      expect(result.code).toBe("NOTHING_TO_COMMIT")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe("flow lifecycle (spec §2.3 create-flow / complete-flow / cancel-flow / takeover)", () => {
  afterEach(() => {
    setFlowGhExecutor(null)
    setFlowGitExecutor(null)
    setRecordsGhExecutor(null)
    setWorktreeGitExecutor(null)
  })

  async function withProjectDir(fn: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "cabbage-flow-lifecycle-"))
    try {
      await fn(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  async function writeProfile(dir: string) {
    await writeFile(join(dir, "AGENTS.md"), "## Project Profile\n\n- test command: `cabbage-test-tool run`\n")
  }

  describe("createFlow", () => {
    it("creates a draft parent issue, binds the session, and returns the ref", async () => {
      await withProjectDir(async dir => {
        await writeProfile(dir)
        setRecordsGhExecutor(async args => {
          if (args.includes("issue create")) return { stdout: "12", stderr: "" }
          throw new Error(`unexpected gh: ${args}`)
        })
        setFlowGhExecutor(async () => {
          throw new Error("unexpected gh")
        })

        const result = await createFlow({ projectDir: dir, title: "flow-control-tool", sessionID: "sess-1" })
        expect(result.ok).toBe(true)
        expect(result.ref.parentIssueNumber).toBe(12)

        const index = await readIndex(dir)
        expect(index.flows["12"]).toMatchObject({ sessionID: "sess-1", status: "active" })
      })
    })

    it("rejects a bad title", async () => {
      await withProjectDir(async dir => {
        const result = await createFlow({ projectDir: dir, title: "Task 001", sessionID: "s" })
        expect(result.ok).toBe(false)
        expect(result.code).toBe("INVALID_FORMAT")
      })
    })

    it("rejects when no project profile is confirmed", async () => {
      await withProjectDir(async dir => {
        const result = await createFlow({ projectDir: dir, title: "flow-control-tool", sessionID: "s" })
        expect(result.ok).toBe(false)
        expect(result.code).toBe("SETUP_REQUIRED")
      })
    })

    it("detects a legacy FlowRun when binding an existing issue", async () => {
      await withProjectDir(async dir => {
        setFlowGhExecutor(async args => {
          if (args.includes("issue view")) {
            return { stdout: "<!-- cabbage-flow-run:start -->\n<!-- cabbage-flow-run:end -->", stderr: "" }
          }
          throw new Error(`unexpected gh: ${args}`)
        })
        const result = await createFlow({ projectDir: dir, title: "x", sessionID: "s", parentIssueNumber: 12 })
        expect(result.ok).toBe(false)
        expect(result.code).toBe("LEGACY_FLOW_DETECTED")
      })
    })

    it("rejects a double-session bind with FLOW_SESSION_CONFLICT", async () => {
      await withProjectDir(async dir => {
        await writeIndex(dir, {
          flows: { "12": { sessionID: "sess-A", status: "active", continuationCount: 0, updatedAt: 0 } },
        })
        setFlowGhExecutor(async args => {
          if (args.includes("issue view")) return { stdout: "flow-x", stderr: "" }
          throw new Error(`unexpected gh: ${args}`)
        })
        const result = await createFlow({ projectDir: dir, title: "x", sessionID: "sess-B", parentIssueNumber: 12 })
        expect(result.ok).toBe(false)
        expect(result.code).toBe("FLOW_SESSION_CONFLICT")
      })
    })
  })

  describe("completeFlow", () => {
    it("closes the parent issue and marks the session completed", async () => {
      await withProjectDir(async dir => {
        await writeIndex(dir, {
          flows: { "12": { sessionID: "sess-1", status: "active", continuationCount: 0, updatedAt: 0 } },
        })
        setFlowGhExecutor(async args => {
          if (args.includes("issue close")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected gh: ${args}`)
        })

        const result = await completeFlow(dir, 12)
        expect(result.ok).toBe(true)
        const index = await readIndex(dir)
        expect(index.flows["12"].status).toBe("completed")
      })
    })
  })

  describe("cancelFlow", () => {
    it("requires user confirmation", async () => {
      await withProjectDir(async dir => {
        const result = await cancelFlow(dir, 12, false)
        expect(result.ok).toBe(false)
        expect(result.code).toBe("USER_CONFIRMATION_REQUIRED")
      })
    })

    it("closes the issue and marks the session cancelled when confirmed", async () => {
      await withProjectDir(async dir => {
        await writeIndex(dir, {
          flows: { "12": { sessionID: "sess-1", status: "active", continuationCount: 0, updatedAt: 0 } },
        })
        setFlowGhExecutor(async args => {
          if (args.includes("issue close")) return { stdout: "", stderr: "" }
          throw new Error(`unexpected gh: ${args}`)
        })

        const result = await cancelFlow(dir, 12, true)
        expect(result.ok).toBe(true)
        const index = await readIndex(dir)
        expect(index.flows["12"].status).toBe("cancelled")
      })
    })
  })

  describe("takeoverFlow", () => {
    it("requires user confirmation when another session is active", async () => {
      await withProjectDir(async dir => {
        await writeIndex(dir, {
          flows: { "12": { sessionID: "sess-A", status: "active", continuationCount: 0, updatedAt: 0 } },
        })
        const result = await takeoverFlow(dir, 12, "sess-B", false)
        expect(result.ok).toBe(false)
        expect(result.code).toBe("TAKEOVER_NOT_CONFIRMED")
      })
    })

    it("pauses the old session and binds the new one when confirmed", async () => {
      await withProjectDir(async dir => {
        await writeIndex(dir, {
          flows: { "12": { sessionID: "sess-A", status: "active", continuationCount: 0, updatedAt: 0 } },
        })
        const result = await takeoverFlow(dir, 12, "sess-B", true)
        expect(result.ok).toBe(true)
        expect(result.oldSessionID).toBe("sess-A")

        const index = await readIndex(dir)
        expect(index.flows["12"]).toMatchObject({ sessionID: "sess-B", status: "active" })
      })
    })
  })
})

describe("createFlowControlTool (spec §2.3 flow_control)", () => {
  afterEach(() => {
    setFlowGhExecutor(null)
    setFlowGitExecutor(null)
    setRecordsGhExecutor(null)
    setWorktreeGitExecutor(null)
  })

  async function withProjectDir(fn: (dir: string, client: any) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "cabbage-flow-tool-"))
    const client = makeSessionClient()
    try {
      await fn(dir, client)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  function makeSessionClient(overrides: Record<string, unknown> = {}) {
    return {
      session: {
        get: async () => ({ data: { parentID: null, metadata: {} } }),
        update: async () => {},
      },
      ...overrides,
    }
  }

  function makeCtx(agent: string, sessionID: string) {
    return { agent, sessionID, messageID: "m1", directory: ".", worktree: "." }
  }

  async function executeOp(
    dir: string,
    client: any,
    op: string,
    args: Record<string, unknown> = {},
    agent = "dev-lifecycle",
    sessionID = "sess-1",
  ): Promise<Record<string, any>> {
    const t = createFlowControlTool({ projectDir: dir, sessionClient: client })
    const out = await t.execute({ op, ...args }, makeCtx(agent, sessionID) as never)
    return JSON.parse(String(out)) as Record<string, any>
  }

  it("defines the nine ops in the args schema", () => {
    const t = createFlowControlTool({ projectDir: ".", sessionClient: makeSessionClient() })
    const opSchema = t.args.op as { safeParse(value: unknown): { success: boolean } }
    const ops = [
      "create-flow", "status", "planning-start", "planning-pr",
      "stage-start", "stage-complete", "complete-flow", "cancel-flow", "takeover",
    ]
    for (const op of ops) expect(opSchema.safeParse(op).success).toBe(true)
    expect(opSchema.safeParse("bogus").success).toBe(false)
  })

  it("create-flow creates the draft issue, binds the session, and writes the minimal goal", async () => {
    await withProjectDir(async (dir, client) => {
      await writeFile(join(dir, "AGENTS.md"), "## Project Profile\n\n- test command: `cabbage-test-tool run`\n")
      const updates: Array<{ sessionID: string; metadata: Record<string, unknown> }> = []
      client.session.update = async (input: { sessionID: string; metadata: Record<string, unknown> }) => {
        updates.push(input)
      }
      setRecordsGhExecutor(async args => {
        if (args.includes("issue create")) return { stdout: "12", stderr: "" }
        throw new Error(`unexpected gh: ${args}`)
      })
      setFlowGhExecutor(async () => {
        throw new Error("unexpected gh")
      })

      const resp = await executeOp(dir, client, "create-flow", { title: "flow-control-tool" })
      expect(resp.ok).toBe(true)
      expect(resp.flow.parentIssueNumber).toBe(12)

      const index = await readIndex(dir)
      expect(index.flows["12"].sessionID).toBe("sess-1")
      expect(updates).toHaveLength(1)
      expect(updates[0].metadata.goal).toEqual({ parentIssueNumber: 12, status: "active", continuationCount: 0 })
    })
  })

  it("create-flow rejects a non-primary caller", async () => {
    await withProjectDir(async dir => {
      const childClient = makeSessionClient({
        session: { get: async () => ({ data: { parentID: "parent", metadata: {} } }) },
      })
      const resp = await executeOp(dir, childClient, "create-flow", { title: "flow-control-tool" }, "developer")
      expect(resp.ok).toBe(false)
      expect(resp.error.code).toBe("CALLER_NOT_AUTHORIZED")
    })
  })

  it("status aggregates and returns the report to primary", async () => {
    await withProjectDir(async dir => {
      setFlowGhExecutor(async args => {
        if (args.includes("issue view")) {
          return {
            stdout: JSON.stringify({
              number: 12, title: "planning-baseline", state: "OPEN",
              labels: ["cabbage:flow", "cabbage:stage:requirements"],
              body: "## Stages\n\n- [x] requirements\n- [ ] design",
            }),
            stderr: "",
          }
        }
        if (args.includes("issue list")) return { stdout: "[]", stderr: "" }
        if (args.includes("pr list")) return { stdout: "[]", stderr: "" }
        throw new Error(`unexpected gh: ${args}`)
      })

      const resp = await executeOp(dir, makeSessionClient(), "status", { parent_issue_number: 12 })
      expect(resp.ok).toBe(true)
      expect(resp.status.flow.title).toBe("planning-baseline")
      expect(resp.status.stages.current).toBe("requirements")
    })
  })

  it("status reports LEGACY_FLOW_DETECTED for an old-architecture issue", async () => {
    await withProjectDir(async dir => {
      setFlowGhExecutor(async args => {
        if (args.includes("issue view")) {
          return { stdout: "<!-- cabbage-flow-run:start -->\n<!-- cabbage-flow-run:end -->", stderr: "" }
        }
        throw new Error(`unexpected gh: ${args}`)
      })
      const resp = await executeOp(dir, makeSessionClient(), "status", { parent_issue_number: 12 })
      expect(resp.ok).toBe(false)
      expect(resp.error.code).toBe("LEGACY_FLOW_DETECTED")
    })
  })

  it("stage-complete requirements requires user confirmation once", async () => {
    await withProjectDir(async dir => {
      const body = "## Stages\n\n- [ ] requirements\n- [ ] design"
      setRecordsGhExecutor(async args => {
        if (args.includes("--jq .body")) return { stdout: body, stderr: "" }
        throw new Error(`unexpected gh: ${args}`)
      })
      setFlowGhExecutor(async args => {
        if (args.includes("issue view")) return { stdout: '["cabbage:flow"]', stderr: "" }
        throw new Error(`unexpected gh: ${args}`)
      })

      const resp = await executeOp(dir, makeSessionClient(), "stage-complete", {
        parent_issue_number: 12,
        stage: "requirements",
      })
      expect(resp.ok).toBe(false)
      expect(resp.error.code).toBe("REQUIREMENTS_CONFIRMATION_REQUIRED")
    })
  })

  it("stage-complete requirements with confirmation updates the checklist and label", async () => {
    await withProjectDir(async dir => {
      const body = "## Stages\n\n- [ ] requirements\n- [ ] design"
      setRecordsGhExecutor(async args => {
        if (args.includes("issue edit")) return { stdout: "", stderr: "" }
        if (args.includes('join(" ")')) return { stdout: "", stderr: "" }
        if (args.includes("--jq .body")) return { stdout: body, stderr: "" }
        throw new Error(`unexpected gh: ${args}`)
      })
      setFlowGhExecutor(async args => {
        if (args.includes("issue view")) return { stdout: '["cabbage:flow"]', stderr: "" }
        throw new Error(`unexpected gh: ${args}`)
      })

      const resp = await executeOp(dir, makeSessionClient(), "stage-complete", {
        parent_issue_number: 12,
        stage: "requirements",
        user_confirmed: true,
      })
      expect(resp.ok).toBe(true)
      expect(resp.stage).toBe("requirements")
      expect(resp.completedStages).toEqual(["requirements"])
    })
  })

  it("stage-start tasks is blocked until design is completed", async () => {
    await withProjectDir(async dir => {
      const body = "## Stages\n\n- [x] requirements\n- [ ] design"
      setRecordsGhExecutor(async args => {
        if (args.includes("--jq .body")) return { stdout: body, stderr: "" }
        throw new Error(`unexpected gh: ${args}`)
      })
      setFlowGhExecutor(async args => {
        if (args.includes("issue view")) return { stdout: '["cabbage:flow", "cabbage:stage:requirements"]', stderr: "" }
        throw new Error(`unexpected gh: ${args}`)
      })

      const resp = await executeOp(dir, makeSessionClient(), "stage-start", {
        parent_issue_number: 12,
        stage: "tasks",
      })
      expect(resp.ok).toBe(false)
      expect(resp.error.code).toBe("DESIGN_NOT_COMPLETE")
    })
  })

  it("stage-start tasks with declared risk=high requires user confirmation (R11)", async () => {
    await withProjectDir(async dir => {
      const body = "## Stages\n\n- [x] requirements\n- [x] design\n- [ ] tasks"
      setRecordsGhExecutor(async args => {
        if (args.includes("--jq .body")) return { stdout: body, stderr: "" }
        if (args.includes('join(" ")')) return { stdout: "", stderr: "" }
        if (args.includes("issue edit")) return { stdout: "", stderr: "" }
        throw new Error(`unexpected gh: ${args}`)
      })
      const flowCalls: string[] = []
      setFlowGhExecutor(async args => {
        flowCalls.push(args)
        if (args.includes("issue view")) return { stdout: '["cabbage:flow", "cabbage:stage:requirements", "cabbage:stage:design"]', stderr: "" }
        if (args.includes("issue edit")) return { stdout: "", stderr: "" }
        throw new Error(`unexpected gh: ${args}`)
      })

      const denied = await executeOp(dir, makeSessionClient(), "stage-start", {
        parent_issue_number: 12,
        stage: "tasks",
        risk: "high",
      })
      expect(denied.ok).toBe(false)
      expect(denied.error.code).toBe("RISK_CONFIRMATION_REQUIRED")
      // 未确认 → 不得打 RISK_LABEL
      expect(flowCalls.some(c => c.includes("cabbage:risk:high"))).toBe(false)
    })
  })

  it("stage-start tasks with declared risk=high and confirmation passes and persists the RISK_LABEL", async () => {
    await withProjectDir(async dir => {
      const body = "## Stages\n\n- [x] requirements\n- [x] design\n- [ ] tasks"
      setRecordsGhExecutor(async args => {
        if (args.includes("--jq .body")) return { stdout: body, stderr: "" }
        if (args.includes('join(" ")')) return { stdout: "", stderr: "" }
        if (args.includes("issue edit")) return { stdout: "", stderr: "" }
        throw new Error(`unexpected gh: ${args}`)
      })
      const flowCalls: string[] = []
      setFlowGhExecutor(async args => {
        flowCalls.push(args)
        if (args.includes("issue view")) return { stdout: '["cabbage:flow", "cabbage:stage:requirements", "cabbage:stage:design"]', stderr: "" }
        if (args.includes("issue edit")) return { stdout: "", stderr: "" }
        throw new Error(`unexpected gh: ${args}`)
      })

      const resp = await executeOp(dir, makeSessionClient(), "stage-start", {
        parent_issue_number: 12,
        stage: "tasks",
        risk: "high",
        user_confirmed: true,
      })
      expect(resp.ok).toBe(true)
      expect(resp.highRisk).toBe(true)
      expect(flowCalls.some(c => c.includes("--add-label 'cabbage:risk:high'"))).toBe(true)
    })
  })

  it("stage-start tasks with declared risk=low passes without confirmation (no label)", async () => {
    await withProjectDir(async dir => {
      const body = "## Stages\n\n- [x] requirements\n- [x] design\n- [ ] tasks"
      setRecordsGhExecutor(async args => {
        if (args.includes("--jq .body")) return { stdout: body, stderr: "" }
        if (args.includes('join(" ")')) return { stdout: "", stderr: "" }
        if (args.includes("issue edit")) return { stdout: "", stderr: "" }
        throw new Error(`unexpected gh: ${args}`)
      })
      const flowCalls: string[] = []
      setFlowGhExecutor(async args => {
        flowCalls.push(args)
        if (args.includes("issue view")) return { stdout: '["cabbage:flow", "cabbage:stage:requirements", "cabbage:stage:design"]', stderr: "" }
        if (args.includes("issue edit")) return { stdout: "", stderr: "" }
        throw new Error(`unexpected gh: ${args}`)
      })

      const resp = await executeOp(dir, makeSessionClient(), "stage-start", {
        parent_issue_number: 12,
        stage: "tasks",
        risk: "low",
      })
      expect(resp.ok).toBe(true)
      expect(flowCalls.some(c => c.includes("cabbage:risk:high"))).toBe(false)
    })
  })

  it("complete-flow rejects callers other than goal-verify", async () => {
    await withProjectDir(async dir => {
      const resp = await executeOp(dir, makeSessionClient(), "complete-flow", { parent_issue_number: 12 }, "dev-lifecycle")
      expect(resp.ok).toBe(false)
      expect(resp.error.code).toBe("CALLER_NOT_AUTHORIZED")
    })
  })

  it("complete-flow requires the goal to be verified complete", async () => {
    await withProjectDir(async (dir, client) => {
      await writeIndex(dir, { flows: { "12": { sessionID: "sess-parent", status: "active", continuationCount: 0, updatedAt: 0 } } })
      const goalVerifyClient = makeSessionClient({
        session: {
          get: async () => ({
            data: { parentID: "parent", metadata: { goal: { parentIssueNumber: 12, status: "active", continuationCount: 0 } } },
          }),
        },
      })
      const resp = await executeOp(dir, goalVerifyClient, "complete-flow", { parent_issue_number: 12 }, "goal-verify", "sess-gv")
      expect(resp.ok).toBe(false)
      expect(resp.error.code).toBe("GOAL_NOT_COMPLETE")
      void client
    })
  })

  it("complete-flow by goal-verify closes the parent issue", async () => {
    await withProjectDir(async dir => {
      await writeIndex(dir, { flows: { "12": { sessionID: "sess-parent", status: "active", continuationCount: 0, updatedAt: 0 } } })
      const goalVerifyClient = makeSessionClient({
        session: {
          get: async () => ({
            data: { parentID: "parent", metadata: { goal: { parentIssueNumber: 12, status: "complete", continuationCount: 0 } } },
          }),
        },
      })
      setFlowGhExecutor(async args => {
        if (args.includes("issue close")) return { stdout: "", stderr: "" }
        throw new Error(`unexpected gh: ${args}`)
      })

      const resp = await executeOp(dir, goalVerifyClient, "complete-flow", { parent_issue_number: 12 }, "goal-verify", "sess-gv")
      expect(resp.ok).toBe(true)
      const index = await readIndex(dir)
      expect(index.flows["12"].status).toBe("completed")
    })
  })

  it("cancel-flow requires user confirmation", async () => {
    await withProjectDir(async dir => {
      const resp = await executeOp(dir, makeSessionClient(), "cancel-flow", { parent_issue_number: 12 })
      expect(resp.ok).toBe(false)
      expect(resp.error.code).toBe("USER_CONFIRMATION_REQUIRED")
    })
  })

  it("takeover with confirmation pauses the old session goal and rebinds", async () => {
    await withProjectDir(async dir => {
      await writeIndex(dir, { flows: { "12": { sessionID: "sess-A", status: "active", continuationCount: 0, updatedAt: 0 } } })
      const updates: string[] = []
      const client = makeSessionClient({
        session: {
          get: async ({ sessionID }: { sessionID: string }) => {
            if (sessionID === "sess-A") {
              return { data: { parentID: null, metadata: { goal: { parentIssueNumber: 12, status: "active", continuationCount: 0 } } } }
            }
            return { data: { parentID: null, metadata: {} } }
          },
          update: async (input: { sessionID: string }) => {
            updates.push(input.sessionID)
          },
        },
      })

      const resp = await executeOp(dir, client, "takeover", { parent_issue_number: 12, user_confirmed: true }, "dev-lifecycle", "sess-B")
      expect(resp.ok).toBe(true)
      expect(resp.oldSessionID).toBe("sess-A")
      expect(updates).toContain("sess-A")

      const index = await readIndex(dir)
      expect(index.flows["12"]).toMatchObject({ sessionID: "sess-B", status: "active" })
    })
  })

  it("returns UNKNOWN_OP for an unknown op", async () => {
    await withProjectDir(async dir => {
      const resp = await executeOp(dir, makeSessionClient(), "bogus" as string)
      expect(resp.ok).toBe(false)
      expect(resp.error.code).toBe("UNKNOWN_OP")
    })
  })
})

describe("registerFlowControl", () => {
  it("mounts flow_control on the tool registry", () => {
    const registry: Record<string, unknown> = {}
    const client = { session: { get: async () => ({ data: { parentID: null } }), update: async () => {} } }
    registerFlowControl(registry, { projectDir: ".", sessionClient: client })
    expect(registry.flow_control).toBeDefined()
  })
})

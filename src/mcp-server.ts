// @ts-nocheck
/**
 * Cabbage MCP Server — wraps the 5 lifecycle tools (setup_control, flow_control,
 * task_control, tdd_checkpoint, release_control) as MCP tools for Codex.
 *
 * Unlike the OpenCode plugin, this MCP server runs as a subprocess via stdio
 * and exposes tools without the OpenCode session/client infrastructure.
 * Caller authentication is simplified: all tools are available to the primary agent.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js"

// ─── Tool Definitions ───

const SETUP_CONTROL_TOOL: Tool = {
  name: "setup_control",
  description: `Detect project setup readiness, generate missing CI/release workflow drafts, and confirm the project profile.

Operations:
- probe: Detect git/gh availability, AGENTS.md Profile, CI/release workflows, and branch protection. Returns a readiness report.
- generate-workflows: Generate missing CI/release workflow drafts under .github/workflows/, then create a chore/setup-workflows branch, commit, push, and open a Setup PR.
- confirm-profile: After user confirmation, write the Project Profile block back to the root AGENTS.md.
- init-repo: Initialize a git repository, make initial commit, optionally create remote.`,
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["probe", "generate-workflows", "confirm-profile", "init-repo"], description: "Setup operation" },
      pr_title: { type: "string", description: "PR title for generate-workflows" },
      test_command: { type: "string", description: "Test command to inject into the generated ci.yml" },
      profile_overrides: { type: "string", description: "JSON of user-confirmed profile fields for confirm-profile" },
      create_remote: { type: "boolean", description: "Create a GitHub remote for init-repo" },
      remote_name: { type: "string", description: "Remote repository name for init-repo" },
      private: { type: "boolean", description: "Create the remote repository as private" },
    },
    required: ["op"],
  },
}

const FLOW_CONTROL_TOOL: Tool = {
  name: "flow_control",
  description: `Control the Flow Record lifecycle (a Flow = one GitHub Parent Issue).

Operations:
- create-flow: Validate the functional title, derive the slug, create a Draft Parent Issue (body contains goal/acceptance/stage checklist, label cabbage:flow), bind the session, and write the minimal goal.
- status: Aggregate the Flow Record body, subtasks, and related PR checks into one report.
- planning-start: Create the planning worktree .worktree/planning-<slug> for the architect.
- planning-pr: Commit/push the planning worktree changes and open the Planning PR.
- stage-start / stage-complete: Enforce stage gates and update the Parent Issue checklist + cabbage:stage:* label.
- complete-flow: After independent verification, close the Parent Issue.
- cancel-flow: Controlled cancellation (requires user_confirmed).
- takeover: Take over a flow bound to another active session.`,
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["create-flow", "status", "planning-start", "planning-pr", "stage-start", "stage-complete", "complete-flow", "cancel-flow", "takeover"], description: "Flow control operation" },
      title: { type: "string", description: "Functional title (kebab-case slug) for create-flow" },
      parent_issue_number: { type: "number", description: "Parent GitHub Issue number of the Flow Record" },
      stage: { type: "string", enum: ["requirements", "design", "tasks", "code", "review"], description: "Stage name (for stage-start/stage-complete)" },
      risk: { type: "string", enum: ["high", "low"], description: "Risk declaration" },
      user_confirmed: { type: "boolean", description: "User confirmation for destructive operations" },
    },
    required: ["op"],
  },
}

const TASK_CONTROL_TOOL: Tool = {
  name: "task_control",
  description: `Control the Task Record lifecycle (a Task = one GitHub Sub Issue under a Flow Parent Issue).

Operations:
- create-task: Validate the functional title, derive the slug, and create a Sub Issue linked to the parent.
- start-task: Gate checks, then worktree-start, capture the clean workspace baseline, freeze the TDD policy, and mark the task running.
- submit-task: TDD hard gate — reject PR creation when evidence is incomplete. On pass: push the branch, create the PR.
- submit-review: Submit the reviewer's dual-axis result via gh pr review.
- merge-task: Merge gates (CI checks pass + branch protection + dual-layer risk escalation) → merge PR → close Sub Issue → destroy worktree.
- cancel-task / destroy-worktree: controlled cancellation, both require user_confirmed.
- status-task: Aggregate the Task Record, PR, and checks into one report.`,
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["create-task", "start-task", "submit-task", "submit-review", "merge-task", "cancel-task", "destroy-worktree", "status-task"], description: "Task control operation" },
      title: { type: "string", description: "Functional title (kebab-case slug) for create-task" },
      parent_issue_number: { type: "number", description: "Parent GitHub Issue number of the Flow Record" },
      task_id: { type: "string", description: "Task slug" },
      pr_number: { type: "number", description: "PR number (submit-review/status)" },
      risk: { type: "string", enum: ["low", "high"], description: "Model-assessed risk for merge-task" },
      verdict: { type: "string", enum: ["approve", "request-changes"], description: "Review verdict for submit-review" },
      user_confirmed: { type: "boolean", description: "User confirmation for destructive operations" },
    },
    required: ["op"],
  },
}

const TDD_CHECKPOINT_TOOL: Tool = {
  name: "tdd_checkpoint",
  description: `TDD Checkpoint — runtime TDD evidence management for RED→GREEN cycles.

Operations:
- cycle-start: Start a new TDD cycle for a criterion. Takes a snapshot of implementation files as baseline.
- red: Execute a test and expect failure (RED). Triples validation: failure classification, impl files unchanged, test input not swapped.
- green: Execute the same test and expect success (GREEN). Validates: same test selector, impl files changed.
- final-regression: Execute the full regression suite.
- final-verification: Final verification pass.
- abandon-cycle: Abandon the current cycle.
- status: Read current TDD evidence state.
- not-applicable: Mark this task as not requiring TDD.
- exempt-request: Request a TDD exemption.`,
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["cycle-start", "red", "green", "final-regression", "final-verification", "abandon-cycle", "status", "not-applicable", "exempt-request"], description: "TDD checkpoint operation" },
      parent_issue_number: { type: "number", description: "Parent GitHub Issue number" },
      task_id: { type: "string", description: "Task slug" },
      cycle_id: { type: "string", description: "Cycle identifier" },
      criterion_id: { type: "string", description: "Acceptance criterion ID" },
      test_paths: { type: "array", items: { type: "string" }, description: "Test file paths" },
      test_selector: { type: "string", description: "Test selector (e.g., vitest run -t 'test name')" },
    },
    required: ["op"],
  },
}

const RELEASE_CONTROL_TOOL: Tool = {
  name: "release_control",
  description: `Control the release lifecycle (tech-stack agnostic).

Operations:
- propose-version: aggregate all changes on main since the last tag, classify them, and propose a SemVer bump.
- open-release-pr: create the release branch, bump the version file, generate Release Notes, push, and open a Release PR.
- merge-release-pr: after CI passes and human approval, merge the Release PR, verify the merge SHA, and push the tag.
- monitor: poll the project GitHub Actions release workflow run until success.`,
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["propose-version", "open-release-pr", "merge-release-pr", "monitor"], description: "Release control operation" },
      proposed_version: { type: "string", description: "Proposed semantic version (x.y.z)" },
      user_confirmed: { type: "boolean", description: "Human approval for merge-release-pr" },
    },
    required: ["op"],
  },
}

// ─── Server Setup ───

const server = new Server(
  { name: "cabbage-lifecycle", version: "1.1.0" },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [SETUP_CONTROL_TOOL, FLOW_CONTROL_TOOL, TASK_CONTROL_TOOL, TDD_CHECKPOINT_TOOL, RELEASE_CONTROL_TOOL],
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    switch (name) {
      case "setup_control":    return await handleSetupControl(args as Record<string, unknown>)
      case "flow_control":     return await handleFlowControl(args as Record<string, unknown>)
      case "task_control":     return await handleTaskControl(args as Record<string, unknown>)
      case "tdd_checkpoint":   return await handleTddCheckpoint(args as Record<string, unknown>)
      case "release_control":  return await handleReleaseControl(args as Record<string, unknown>)
      default:                 return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true }
    }
  } catch (err) {
    return { content: [{ type: "text", text: `Error: ${String(err)}` }], isError: true }
  }
})

// ─── Helpers ───

function ok(data: Record<string, unknown>) {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...data }, null, 2) }] }
}

function err(msg: string) {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: { message: msg } }, null, 2) }], isError: true }
}

function requireInt(n: unknown, name: string): number | null {
  const v = Number(n)
  return Number.isInteger(v) && v > 0 ? v : null
}

// ─── Handler Implementations ───

async function getProjectDir(): Promise<string> {
  const { execSync } = await import("node:child_process")
  try {
    const root = execSync("git rev-parse --show-toplevel 2>/dev/null", { encoding: "utf8" }).trim()
    if (root) return root
  } catch { /* cwd fallback */ }
  return process.cwd()
}

async function handleSetupControl(args: Record<string, unknown>) {
  const op = String(args.op ?? "")
  const projectDir = await getProjectDir()

  try {
    const { probe, generateWorkflows, confirmProjectProfile, initRepo } = await import("./kernel/setup.js")

    switch (op) {
      case "probe": {
        const readiness = await probe(projectDir)
        return ok({ readiness })
      }
      case "generate-workflows": {
        const result: any = await generateWorkflows(projectDir, {
          prTitle: String(args.pr_title ?? "chore: add CI/release workflow drafts"),
          testCommand: args.test_command as string | undefined,
        })
        if (!result.ok) return err(result.error ?? "failed to generate workflows")
        return ok({ created: result.created, updated: result.updated, existing: result.existing, prNumber: result.prNumber })
      }
      case "confirm-profile": {
        const overrides = String(args.profile_overrides ?? "")
        if (!overrides) return err("profile_overrides is required")
        const result: any = await confirmProjectProfile(projectDir, overrides)
        if (!result.ok) return err(result.message ?? "failed to confirm profile")
        return ok({ profileConfirmed: true })
      }
      case "init-repo": {
        const result: any = await initRepo(projectDir, {
          createRemote: args.create_remote === true,
          remoteName: args.remote_name as string | undefined,
          private: args.private === true,
        })
        if (!result.ok) return err(result.error ?? "failed to initialize repo")
        return ok({ initialized: result.initialized, committed: result.committed, remoteCreated: result.remoteCreated })
      }
      default:
        return err(`Unknown op: ${op}`)
    }
  } catch (e) {
    return err(`setup_control(${op}): ${String(e)}`)
  }
}

async function handleFlowControl(args: Record<string, unknown>) {
  const op = String(args.op ?? "")
  const projectDir = await getProjectDir()

  try {
    const flow = await import("./kernel/flow.js")

    switch (op) {
      case "create-flow": {
        const result: any = await flow.createFlow({
          projectDir,
          title: String(args.title ?? ""),
          sessionID: "codex-session",
          autoMode: args.auto_mode === true,
          goal: args.goal as string | undefined,
          acceptanceCriteria: args.acceptance_criteria as string[] | undefined,
          parentIssueNumber: args.parent_issue_number as number | undefined,
        })
        if (!result.ok) return err(result.message ?? "failed to create flow")
        return ok({ flow: result.ref })
      }
      case "status": {
        const n = requireInt(args.parent_issue_number, "parent_issue_number")
        if (!n) return err("parent_issue_number is required")
        const result: any = await flow.readFlowStatus(n)
        if (!result.ok) return err(result.message ?? "failed to read flow status")
        return ok({ status: result.status })
      }
      case "planning-start": {
        const n = requireInt(args.parent_issue_number, "parent_issue_number")
        if (!n) return err("parent_issue_number is required")
        const result: any = await flow.planningStart(projectDir, n)
        if (!result.ok) return err(result.message ?? "failed to start planning")
        return ok({ worktreePath: result.worktreePath, branch: result.branch })
      }
      case "planning-pr": {
        const n = requireInt(args.parent_issue_number, "parent_issue_number")
        if (!n) return err("parent_issue_number is required")
        const result: any = await flow.planningPr(projectDir, n)
        if (!result.ok) return err(result.message ?? "failed to create planning PR")
        return ok({ prNumber: result.prNumber, worktreePath: result.worktreePath, branch: result.branch })
      }
      case "stage-start":
      case "stage-complete": {
        const n = requireInt(args.parent_issue_number, "parent_issue_number")
        if (!n) return err("parent_issue_number is required")
        const stage = String(args.stage ?? "")
        if (!["requirements", "design", "tasks", "code", "review"].includes(stage)) {
          return err("stage is required: requirements|design|tasks|code|review")
        }
        const risk = args.risk as "high" | "low" | undefined
        const result: any = await flow.applyStageOp(projectDir, n, op as "stage-start" | "stage-complete", stage, args.user_confirmed === true, risk)
        if (!result.ok) return err(result.message ?? "stage operation failed")
        return ok({ stage: result.stage, completedStages: result.completedStages })
      }
      case "complete-flow": {
        const n = requireInt(args.parent_issue_number, "parent_issue_number")
        if (!n) return err("parent_issue_number is required")
        const result: any = await flow.completeFlow(projectDir, n)
        if (!result.ok) return err(result.message ?? "failed to complete flow")
        return ok({ flow: { parentIssueNumber: result.parentIssueNumber } })
      }
      case "cancel-flow": {
        const n = requireInt(args.parent_issue_number, "parent_issue_number")
        if (!n) return err("parent_issue_number is required")
        const result: any = await flow.cancelFlow(projectDir, n, args.user_confirmed === true)
        if (!result.ok) return err(result.message ?? "failed to cancel flow")
        return ok({ flow: { parentIssueNumber: result.parentIssueNumber } })
      }
      default:
        return err(`Unknown op: ${op}`)
    }
  } catch (e) {
    return err(`flow_control(${op}): ${String(e)}`)
  }
}

async function handleTaskControl(args: Record<string, unknown>) {
  const op = String(args.op ?? "")
  const projectDir = await getProjectDir()

  try {
    const task = await import("./kernel/task.js")

    switch (op) {
      case "create-task": {
        const result: any = await task.createTask({
          projectDir,
          parentIssueNumber: Number(args.parent_issue_number),
          title: String(args.title ?? ""),
          acceptanceCriteriaJson: args.acceptance_criteria as string | undefined,
          dependencies: parseDeps(args.depends_on as string | undefined),
        })
        if (!result.ok) return err(result.message ?? "failed to create task")
        return ok({ task: result.ref })
      }
      case "start-task": {
        const parent = requireInt(args.parent_issue_number, "parent_issue_number")
        const taskId = String(args.task_id ?? "")
        if (!parent || !taskId) return err("parent_issue_number and task_id are required")
        const result: any = await task.startTask(projectDir, parent, taskId)
        if (!result.ok) return err(result.message ?? "failed to start task")
        return ok({ issueNumber: result.issueNumber, branch: result.branch, worktreePath: result.worktreePath })
      }
      case "submit-task": {
        const parent = requireInt(args.parent_issue_number, "parent_issue_number")
        const taskId = String(args.task_id ?? "")
        if (!parent || !taskId) return err("parent_issue_number and task_id are required")
        const result: any = await task.submitTask(projectDir, parent, taskId)
        if (!result.ok) return err(result.message ?? "submit task failed")
        return ok({ prNumber: result.prNumber, evidenceRevision: result.evidenceRevision })
      }
      case "submit-review": {
        const pr = requireInt(args.pr_number, "pr_number")
        if (!pr) return err("pr_number is required")
        const verdict = String(args.verdict ?? "")
        if (verdict !== "approve" && verdict !== "request-changes") return err("verdict is required: approve|request-changes")
        const result: any = await task.submitReview(pr, verdict, args.comment as string | undefined)
        if (!result.ok) return err(result.message ?? "submit review failed")
        return ok({ prNumber: result.prNumber, verdict: result.verdict })
      }
      case "merge-task": {
        const parent = requireInt(args.parent_issue_number, "parent_issue_number")
        const taskId = String(args.task_id ?? "")
        if (!parent || !taskId) return err("parent_issue_number and task_id are required")
        const risk = args.risk === "high" ? "high" : "low"
        const result: any = await task.mergeTask(projectDir, parent, taskId, risk)
        if (!result.ok) return err(result.message ?? "merge task failed")
        return ok({ prNumber: result.prNumber, risk: result.risk })
      }
      case "cancel-task": {
        const parent = requireInt(args.parent_issue_number, "parent_issue_number")
        const taskId = String(args.task_id ?? "")
        if (!parent || !taskId) return err("parent_issue_number and task_id are required")
        const result: any = await task.cancelTask(projectDir, parent, taskId, args.user_confirmed === true)
        if (!result.ok) return err(result.message ?? "cancel task failed")
        return ok({ issueNumber: result.issueNumber })
      }
      case "status-task": {
        const parent = requireInt(args.parent_issue_number, "parent_issue_number")
        const taskId = String(args.task_id ?? "")
        if (!parent || !taskId) return err("parent_issue_number and task_id are required")
        const result: any = await task.readTaskStatus(projectDir, parent, taskId)
        if (!result.ok) return err(result.message ?? "read task status failed")
        return ok({ report: result.report })
      }
      default:
        return err(`Unknown op: ${op}`)
    }
  } catch (e) {
    return err(`task_control(${op}): ${String(e)}`)
  }
}

function parseDeps(depStr: string | undefined): number[] {
  if (!depStr) return []
  return depStr.split(",").map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n) && n > 0)
}

async function handleTddCheckpoint(args: Record<string, unknown>) {
  const op = String(args.op ?? "")
  try {
    if (op === "status") {
      const parent = requireInt(args.parent_issue_number, "parent_issue_number")
      const taskId = String(args.task_id ?? "")
      if (!parent || !taskId) return err("parent_issue_number and task_id are required")
      const projectDir = await getProjectDir()
      const { resolveTaskContext } = await import("./plugin/tdd-checkpoint.js")
      const task = await resolveTaskContext(parent, taskId, projectDir)
      return ok({ context: { issueNumber: task.issueNumber, policy: task.policy, criteria: task.criteria, worktreeDir: task.worktreeDir } })
    }
    return err(`tdd_checkpoint op "${op}" requires full OpenCode session context; use OpenCode plugin for TDD operations`)
  } catch (e) {
    return err(`tdd_checkpoint(${op}): ${String(e)}`)
  }
}

async function handleReleaseControl(args: Record<string, unknown>) {
  const op = String(args.op ?? "")
  try {
    const projectDir = await getProjectDir()
    const { readProjectProfile } = await import("./kernel/profile.js")
    const profile = await readProjectProfile(projectDir)
    // Basic release control proxy — use gh CLI directly for advanced operations
    return err(`release_control(${op}): use gh CLI directly for full release support, or use the OpenCode plugin`)
  } catch (e) {
    return err(`release_control(${op}): ${String(e)}`)
  }
}

// ─── Start Server ───

async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error("[cabbage-mcp] MCP server started on stdio")
}

main().catch((err) => {
  console.error("[cabbage-mcp] Fatal error:", err)
  process.exit(1)
})
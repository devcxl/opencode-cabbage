import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import path from "node:path"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"

import { initPrompts } from "./prompts.js"
import { initBootstrap, getBootstrapContent } from "./bootstrap.js"
import { loadCommands } from "./commands.js"
import { setupSkillsDir } from "./skills.js"
import { loadAgents } from "./agents.js"
import { createIsolatedShellEnv, detectAmbientCredentials } from "./shell.js"
import { createGoalClient, createGoalTool, readGoal, writeGoal, bindFlowRunRef, MAX_CONTINUATIONS, continuationPrompt, verifyAgentPrompt, formatGoal } from "./goal.js"
import { FlowBroker } from "./broker.js"
import {
  flowRunStart,
  flowStageStart,
  flowStageComplete,
  flowTaskStart,
} from "../flowrun/transitions.js"
import type { TaskExecutionBinding, FlowControlResponse } from "../flowrun/types.js"
import { handleFlowPrCreateWithBroker } from "./flow-pr-tool.js"

const abortedSessions = new Set<string>()
const errorRetryCount = new Map<string, number>()
const COMPACTION_THRESHOLD = 20

interface V1ClientContainer {
  _client?: { getConfig?: () => Record<string, unknown> }
}

interface SessionGetResponse {
  data?: { parentID?: string | null; metadata?: Record<string, unknown> }
}

interface AgentToolConfig {
  tools?: Record<string, boolean>
}

interface GoalToolConfig extends AgentToolConfig {
  agent?: Record<string, unknown>
}

export function configureGoalTools(config: GoalToolConfig): void {
  config.tools = { ...config.tools, goal: false }

  for (const [agentName, agent] of Object.entries(config.agent ?? {})) {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) continue
    const agentConfig = agent as AgentToolConfig
    const canUseGoal = agentName === "dev-lifecycle" || agentName === "goal-verify"
    agentConfig.tools = { ...agentConfig.tools, goal: canUseGoal }
  }
}

function sessionStatePath(projectDir: string) {
  return path.join(projectDir, ".opencode", "opencode-cabbage", "session-state.json")
}

async function saveSessionState(projectDir: string, sessionID: string, goal: { status: string }) {
  const dir = path.dirname(sessionStatePath(projectDir))
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  await writeFile(sessionStatePath(projectDir), JSON.stringify({
    sessionID,
    status: goal.status,
    updatedAt: Date.now(),
  }), "utf8")
}

async function loadLastSession(projectDir: string): Promise<string | null> {
  try {
    const data = JSON.parse(await readFile(sessionStatePath(projectDir), "utf8"))
    return data.status === "active" ? data.sessionID : null
  } catch {
    return null
  }
}

async function clearSessionState(projectDir: string) {
  try {
    await writeFile(sessionStatePath(projectDir), JSON.stringify({ status: "completed", updatedAt: Date.now() }), "utf8")
  } catch {}
}

async function queueContinuation(
  client: ReturnType<typeof import("@opencode-ai/sdk/v2").createOpencodeClient>,
  sessionID: string,
  projectDir?: string
) {
  const { goal } = await readGoal(client, sessionID)
  if (!goal || goal.status !== "active") return

  if (projectDir) saveSessionState(projectDir, sessionID, goal)

  if (abortedSessions.has(sessionID)) {
    abortedSessions.delete(sessionID)
    goal.status = "paused"
    await writeGoal(client, sessionID, goal)
    if (projectDir) clearSessionState(projectDir)
    return
  }

  if (goal.continuationCount >= MAX_CONTINUATIONS) {
    goal.status = "paused"
    await writeGoal(client, sessionID, goal)
    if (projectDir) clearSessionState(projectDir)
    return
  }

  goal.continuationCount++
  await writeGoal(client, sessionID, goal)

  try {
    if (goal.continuationCount > 0 && goal.continuationCount % COMPACTION_THRESHOLD === 0) {
      try {
        await client.session.promptAsync({
          sessionID,
          parts: [{ type: "text" as const, text: "[compact] The session history is growing long. Summarize completed work and continue.", synthetic: true }],
        })
      } catch {}
    }

    await client.session.promptAsync({
      sessionID,
      parts: [{ type: "text" as const, text: continuationPrompt(goal.objective, goal.completionCriterion), synthetic: true }],
    })
  } catch (err) {
    console.error("[cabbage] continuation failed:", err)
  }
}

async function autoResume(client: ReturnType<typeof import("@opencode-ai/sdk/v2").createOpencodeClient>, projectDir: string) {
  const lastSessionID = await loadLastSession(projectDir)
  if (!lastSessionID) return

  const { goal } = await readGoal(client, lastSessionID)
  if (!goal || goal.status !== "active") {
    await clearSessionState(projectDir)
    return
  }

  try {
    await client.session.promptAsync({
      sessionID: lastSessionID,
      parts: [{
        type: "text" as const,
        text: `[auto-resume] Plugin restarted. Resuming previous goal:\n\n${formatGoal(goal)}\n\nContinue working.`,
        synthetic: true,
      }],
    })
  } catch (err) {
    console.error("[cabbage] auto-resume failed:", err)
  }
}

function getRetryKey(sessionID: string, phase: string) {
  return `${sessionID}:${phase}`
}

function shouldEscalate(sessionID: string, phase: string): "retry" | "skip" | "pause" {
  const key = getRetryKey(sessionID, phase)
  const count = errorRetryCount.get(key) ?? 0
  errorRetryCount.set(key, count + 1)

  if (count < 3) return "retry"
  if (count < 5) return "skip"
  return "pause"
}

const ABORTED_SESSION_CLEANUP_INTERVAL = 1000 * 60 * 30
let abortedCleanupTimer: ReturnType<typeof setInterval> | null = null

function startPeriodicCleanup() {
  if (abortedCleanupTimer) clearInterval(abortedCleanupTimer)
  abortedCleanupTimer = setInterval(() => {
    abortedSessions.clear()
    errorRetryCount.clear()
  }, ABORTED_SESSION_CLEANUP_INTERVAL)
}

// ─── Flow Control Tool ───

function createFlowControlTool(
  broker: FlowBroker,
  goalClient: ReturnType<typeof createGoalClient>,
) {
  return tool({
    description: `Control the FlowRun lifecycle: start a FlowRun, transition stages, and start tasks.

Operations:
- run-start: Transition FlowRun from planned → running. Binds Goal to FlowRun.
- stage-start: Start a stage (requirements/design/tasks/code). Requires prerequisites met.
- stage-complete: Complete a stage (requirements/design/tasks). Requires all checks pass.
- task-start: Start a task (pending/ready → running). Freezes TDD policy and sets execution binding.`,
    args: {
      op: tool.schema.enum(["run-start", "stage-start", "stage-complete", "task-start"]).describe("Flow control operation"),
      parent_issue_number: tool.schema.number().describe("Parent GitHub Issue number containing the FlowRun"),
      stage: tool.schema.enum(["requirements", "design", "tasks", "code", "test", "review", "merge"]).optional().describe("Stage name (for stage-start/stage-complete)"),
      task_id: tool.schema.string().optional().describe("Task ID (for task-start)"),
      execution_binding: tool.schema.object({
        branch: tool.schema.string(),
        base_sha: tool.schema.string(),
        start_head_sha: tool.schema.string(),
        worktree_id: tool.schema.string(),
        session_id: tool.schema.string(),
      }).optional().describe("Execution binding for task-start"),
      tdd_policy_json: tool.schema.string().optional().describe("JSON string of frozen TDD policy (for task-start)"),
    },
    async execute(args, ctx) {
      const sessionID = (ctx as any).sessionID as string
      const op = args.op as string
      const parentIssueNumber = args.parent_issue_number as number

      try {
        switch (op) {
          case "run-start":
            return handleRunStart(broker, goalClient, parentIssueNumber, sessionID)
          case "stage-start":
            return handleStageStart(broker, parentIssueNumber, args.stage as string)
          case "stage-complete":
            return handleStageComplete(broker, parentIssueNumber, args.stage as string)
          case "task-start":
            return handleTaskStart(broker, parentIssueNumber, args.task_id as string, args.execution_binding as TaskExecutionBinding | undefined, args.tdd_policy_json as string | undefined)
          default:
            return errorResponse("UNKNOWN_OP", `Unknown operation: "${op}"`)
        }
      } catch (err) {
        return errorResponse("INTERNAL_ERROR", String(err))
      }
    },
  })
}

function okResponse(overrides: Partial<FlowControlResponse> = {}): string {
  const resp: FlowControlResponse = { ok: true, ...overrides }
  return JSON.stringify(resp, null, 2)
}

function errorResponse(code: string, message: string): string {
  const resp: FlowControlResponse = { ok: false, error: { code, message } }
  return JSON.stringify(resp, null, 2)
}

async function handleRunStart(
  broker: FlowBroker,
  goalClient: ReturnType<typeof createGoalClient>,
  parentIssueNumber: number,
  sessionID: string,
): Promise<string> {
  // 通过 broker 执行状态迁移
  const writeResult = await broker.writeFlowRunWithLock<unknown>(parentIssueNumber, (flowRun) => {
    const res = flowRunStart(flowRun)
    if (!res.ok) {
      return { flowRun, result: res.error, shouldPersist: false }
    }
    return { flowRun: res.value, result: res.value.status, shouldPersist: true }
  })

  if (!writeResult.ok) {
    return errorResponse(writeResult.code, writeResult.message)
  }

  if (!writeResult.persisted) {
    // 状态迁移被拒绝（如已是 running）
    return errorResponse("INVALID_TRANSITION", "FlowRun is not in planned state")
  }

  // 绑定 Goal → FlowRun
  const actualFlowRunId = writeResult.flowRun.flowRunId
  const bindResult = await bindFlowRunRef(goalClient, sessionID, {
    repo: writeResult.flowRun.repo,
    parentIssueNumber,
    flowRunId: actualFlowRunId,
  })

  if (!bindResult.ok) {
    return errorResponse(bindResult.code, bindResult.message)
  }

  return okResponse({
    flowRunStatus: writeResult.flowRun.status,
  })
}

async function handleStageStart(
  broker: FlowBroker,
  parentIssueNumber: number,
  stageName: string,
): Promise<string> {
  if (!stageName) {
    return errorResponse("POLICY_INVALID", "stage is required for stage-start")
  }

  const writeResult = await broker.writeFlowRunWithLock<unknown>(parentIssueNumber, (flowRun) => {
    const res = flowStageStart(flowRun, stageName as any)
    if (!res.ok) {
      return { flowRun, result: res.error, shouldPersist: false }
    }
    return {
      flowRun: res.value,
      result: { stage: stageName, status: res.value.stages[stageName as keyof typeof res.value.stages].status },
      shouldPersist: true,
    }
  })

  if (!writeResult.ok) {
    return errorResponse(writeResult.code, writeResult.message)
  }

  if (!writeResult.persisted && writeResult.result && typeof writeResult.result === "object" && "code" in writeResult.result) {
    const err = writeResult.result as { code: string; message: string }
    return errorResponse(err.code, err.message)
  }

  return okResponse({
    flowRunStatus: writeResult.flowRun.status,
    stage: writeResult.result as FlowControlResponse["stage"],
  })
}

async function handleStageComplete(
  broker: FlowBroker,
  parentIssueNumber: number,
  stageName: string,
): Promise<string> {
  if (!stageName) {
    return errorResponse("POLICY_INVALID", "stage is required for stage-complete")
  }

  const writeResult = await broker.writeFlowRunWithLock<unknown>(parentIssueNumber, (flowRun) => {
    const res = flowStageComplete(flowRun, stageName as any)
    if (!res.ok) {
      return { flowRun, result: res.error, shouldPersist: false }
    }
    return {
      flowRun: res.value,
      result: { stage: stageName, status: res.value.stages[stageName as keyof typeof res.value.stages].status },
      shouldPersist: true,
    }
  })

  if (!writeResult.ok) {
    return errorResponse(writeResult.code, writeResult.message)
  }

  if (!writeResult.persisted && writeResult.result && typeof writeResult.result === "object" && "code" in writeResult.result) {
    const err = writeResult.result as { code: string; message: string }
    return errorResponse(err.code, err.message)
  }

  return okResponse({
    flowRunStatus: writeResult.flowRun.status,
    stage: writeResult.result as FlowControlResponse["stage"],
  })
}

async function handleTaskStart(
  broker: FlowBroker,
  parentIssueNumber: number,
  taskId: string,
  executionBinding: TaskExecutionBinding | undefined,
  tddPolicyJson: string | undefined,
): Promise<string> {
  if (!taskId) {
    return errorResponse("POLICY_INVALID", "task_id is required for task-start")
  }

  if (!executionBinding) {
    return errorResponse("POLICY_INVALID", "execution_binding is required for task-start")
  }

  // 解析 frozen policy
  let tddPolicy = undefined
  if (tddPolicyJson) {
    try {
      tddPolicy = JSON.parse(tddPolicyJson)
    } catch {
      return errorResponse("POLICY_INVALID", "tdd_policy_json is not valid JSON")
    }
  }

  const writeResult = await broker.writeFlowRunWithLock<unknown>(parentIssueNumber, (flowRun) => {
    const res = flowTaskStart(flowRun, taskId, executionBinding, tddPolicy)
    if (!res.ok) {
      return { flowRun, result: res.error, shouldPersist: false }
    }
    return {
      flowRun: res.value.flowRun,
      result: {
        taskId,
        status: res.value.task.status,
        executionBinding: res.value.task.executionBinding,
      },
      shouldPersist: true,
    }
  })

  if (!writeResult.ok) {
    return errorResponse(writeResult.code, writeResult.message)
  }

  if (!writeResult.persisted && writeResult.result && typeof writeResult.result === "object" && "code" in writeResult.result) {
    const err = writeResult.result as { code: string; message: string }
    return errorResponse(err.code, err.message)
  }

  return okResponse({
    flowRunStatus: writeResult.flowRun.status,
    task: writeResult.result as FlowControlResponse["task"],
  })
}

// ─── Flow PR Tool ───

function createFlowPRTool(broker: FlowBroker) {
  return tool({
    description: `Create a Pull Request for a task that has passed committed-head regression and verification.

Operation:
- create: Create or reuse a PR for the specified task. Idempotent — reuses existing open PR for the same head branch.`,
    args: {
      op: tool.schema.enum(["create"]).describe("Flow PR operation"),
      parent_issue_number: tool.schema.number().describe("Parent GitHub Issue number containing the FlowRun"),
      task_id: tool.schema.string().describe("Task ID for the PR"),
      current_head_sha: tool.schema.string().describe("Current committed HEAD SHA (for verification)"),
      pr_title: tool.schema.string().describe("PR title"),
      pr_body: tool.schema.string().describe("PR body/description"),
      base_branch: tool.schema.string().optional().describe("Base branch (default: main)"),
    },
    async execute(args, _ctx) {
      const taskId = args.task_id as string
      const currentHeadSha = args.current_head_sha as string
      const prTitle = args.pr_title as string
      const prBody = args.pr_body as string
      const baseBranch = (args.base_branch as string | undefined) ?? "main"
      const parentIssueNumber = args.parent_issue_number as number

      const resp = await handleFlowPrCreateWithBroker(broker, {
        op: "pr-create",
        parentIssueNumber,
        taskId,
        currentHeadSha,
        prTitle,
        prBody,
        baseBranch,
      })

      if (!resp.ok) {
        return JSON.stringify({
          ok: false,
          error: resp.error,
          conflictPause: resp.conflictPause,
        }, null, 2)
      }

      return JSON.stringify({
        ok: true,
        pr: {
          prNumber: resp.prNumber,
          prUrl: resp.prUrl,
          created: resp.created,
        },
        taskStatus: resp.taskStatus,
      }, null, 2)
    },
  })
}

export function createOpencodeCabbage(packageRoot: string): Plugin {
  return async (ctx, _options) => {
    const sourceSkillsDir = path.join(packageRoot, "assets", "skills")
    const contextDir = path.join(packageRoot, "assets", "context")
    const promptsDir = path.join(packageRoot, "assets", "prompts")
    const commandsDir = path.join(packageRoot, "assets", "commands")
    const skillsDir = await setupSkillsDir(sourceSkillsDir, contextDir, promptsDir)

    const projectDir = ctx.worktree || ctx.directory
    const v1Client = (ctx.client as unknown as V1ClientContainer)._client
    const goalClient = createGoalClient(ctx.serverUrl, v1Client)
    const goalTool = createGoalTool(goalClient)
    const broker = new FlowBroker()
    const flowControlTool = createFlowControlTool(broker, goalClient)
    const flowPRTool = createFlowPRTool(broker)

    const agentsDir = path.join(packageRoot, "assets", "agents")

    await initPrompts(packageRoot, projectDir)
    await initBootstrap()
    startPeriodicCleanup()

    autoResume(goalClient, projectDir)

    return {
      tool: {
        goal: goalTool,
        flow_control: flowControlTool,
        flow_pr: flowPRTool,
      },

      config: async (rawConfig) => {
        const config = rawConfig as Record<string, any>

        // ── Ambient credential 检测 ──
        const ambientReport = detectAmbientCredentials()
        if (ambientReport.hasWriteCredentials) {
          console.warn(
            "[cabbage] ⚠️  检测到可用 GitHub 写凭证，Runtime enforcement 已降级为 advisory:",
            ambientReport.sources.map(s => s.location).join(", "),
          )
        }

        config.skills = config.skills || {}
        config.skills.paths = config.skills.paths || []
        if (!config.skills.paths.includes(skillsDir)) {
          config.skills.paths.push(skillsDir)
        }

        config.command = config.command || {}
        for (const cmd of loadCommands(commandsDir, skillsDir)) {
          if (config.command[cmd.name]) continue
          config.command[cmd.name] = {
            template: cmd.template,
            description: cmd.description,
            agent: cmd.agent,
            model: cmd.model,
            subtask: cmd.subtask,
          }
        }

        config.agent = config.agent || {}
        for (const agent of loadAgents(agentsDir)) {
          if (config.agent[agent.key]) continue
          config.agent[agent.key] = {
            description: agent.description,
            mode: agent.mode,
            color: agent.color,
            prompt: agent.prompt,
            tools: agent.tools ?? { read: true, bash: true, write: true, edit: true },
            permission: agent.permission,
            shell: {
              env: createIsolatedShellEnv(agent),
            },
          }
        }

        if (!config.agent["goal-verify"]) {
          config.agent["goal-verify"] = {
            mode: "subagent",
            description: "Goal verification agent. Verifies completion independently.",
            prompt: verifyAgentPrompt(),
            tools: { read: true, bash: true, write: false, edit: false },
            permission: {
              bash: "npm test|npm run|git status|git diff|git log",
              write: "deny",
              edit: "deny",
            },
            shell: {
              env: createIsolatedShellEnv({
                key: "goal-verify",
                mode: "subagent",
                prompt: verifyAgentPrompt(),
                permission: {
                  bash: "npm test|npm run|git status|git diff|git log",
                  write: "deny",
                  edit: "deny",
                },
              }),
            },
          }
        }

        configureGoalTools(config)
      },

      "experimental.chat.messages.transform": async (_input, output) => {
        if (!output.messages.length) return

        const firstUser = output.messages.find(m => m.info.role === "user")
        if (!firstUser || !firstUser.parts.length) return

        if (firstUser.parts.some(p => p.type === "text" && p.text.includes("EXTREMELY_IMPORTANT"))) return

        // Only inject bootstrap for active flow: goal is active or user sent a flow command
        const hasGoal = await readGoal(goalClient, output.messages[0].info.sessionID).then(r => r.goal?.status === "active").catch(() => false)
        if (!hasGoal) return

        firstUser.parts.unshift({ type: "text", text: getBootstrapContent() } as typeof firstUser.parts[number])
      },

      async event({ event }) {
        const evt = event as { type: string; properties: Record<string, any> }

        if (evt.type === "session.error") {
          const errorName = evt.properties?.error?.name
          const sessionID: string | undefined = evt.properties.sessionID
          if (errorName === "MessageAbortedError" && sessionID) {
            abortedSessions.add(sessionID)
          }
        }

        if (evt.type === "session.status" && evt.properties?.status?.type === "idle") {
          const sessionID: string | undefined = evt.properties.sessionID
          if (sessionID) {
            const result = await goalClient.session.get({ sessionID }) as unknown as SessionGetResponse
            if (result?.data?.parentID) return
            void queueContinuation(goalClient, sessionID, projectDir)
          }
        }

        if (evt.type === "session.status" && evt.properties?.status?.type === "error") {
          const sessionID: string | undefined = evt.properties.sessionID
          if (sessionID && !abortedSessions.has(sessionID)) {
            const phase = evt.properties?.phase ?? "unknown"
            const action = shouldEscalate(sessionID, phase)
            const { goal } = await readGoal(goalClient, sessionID)

            if (action === "retry" && goal) {
              await goalClient.session.promptAsync({
                sessionID,
                parts: [{
                  type: "text" as const,
                  text: `[auto-retry] Previous attempt failed. Try a different approach.\n\nGoal: ${goal.objective}`,
                  synthetic: true,
                }],
              })
            } else if (action === "skip" && goal) {
              await goalClient.session.promptAsync({
                sessionID,
                parts: [{
                  type: "text" as const,
                  text: `[skip] Skipping failed step. Continue with remaining work.\n\nGoal: ${goal.objective}`,
                  synthetic: true,
                }],
              })
            }
          }
        }

        if (evt.type === "message.updated" && evt.properties?.info?.role === "user") {
          const sessionID: string | undefined = evt.properties.sessionID
          if (sessionID) {
            abortedSessions.delete(sessionID)
            const { goal, session } = await readGoal(goalClient, sessionID)
            if (goal) {
              goal.continuationCount = 0
              await writeGoal(goalClient, sessionID, goal, session ?? undefined)
            }
          }
        }

        if (evt.type === "session.updated") {
          const sessionID: string | undefined = evt.properties?.sessionID
          if (sessionID) {
            const { goal } = await readGoal(goalClient, sessionID)
            if (goal?.status === "complete") {
              await clearSessionState(projectDir)
            }
          }
        }
      },
    }
  }
}

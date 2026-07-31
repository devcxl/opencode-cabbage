import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin/tool"
import path from "node:path"

import { initPrompts } from "./prompts.js"
import { initBootstrap, getBootstrapContent } from "./bootstrap.js"
import { loadCommands } from "./commands.js"
import { setupSkillsDir } from "./skills.js"
import { loadAgents } from "./agents.js"
import { createAgentShellEnv } from "./shell.js"
import { createGoalClient, createGoalTool, readGoal, writeGoal, MAX_CONTINUATIONS, continuationPrompt, formatGoal } from "./goal.js"
import { readIndex, updateFlowSession } from "../kernel/session-index.js"
import { FlowBroker } from "./broker.js"
import {
  flowRunStart,
  flowStageStart,
  flowStageComplete,
  flowTaskStart,
  flowRunFinalize,
} from "../flowrun/transitions.js"
import type { TaskExecutionBinding, FlowControlResponse } from "../flowrun/types.js"
import { readFlowRun } from "../flowrun/github.js"
import { getContextBlock, formatContextBlock, CONTEXT_MARKER } from "../kernel/context.js"
import type { ContextBlock } from "../kernel/context.js"
import { readProjectProfile } from "../kernel/profile.js"

const abortedSessions = new Set<string>()
const errorRetryCount = new Map<string, number>()
const COMPACTION_THRESHOLD = 20

export interface FirstUserInjectionInput {
  hasGoal: boolean
  isSubAgent: boolean
  contextBlock: ContextBlock | null
  bootstrap: string
}

/**
 * 决定首条 user 消息注入内容：
 * - Primary（goal 激活）→ bootstrap + Project Context 块
 * - 子 agent → 仅 Project Context 块
 * - 其他 → 不注入
 */
export function buildFirstUserInjection(input: FirstUserInjectionInput): string | null {
  const parts: string[] = []
  if (input.hasGoal) parts.push(input.bootstrap)
  if (input.contextBlock && (input.hasGoal || input.isSubAgent)) {
    parts.push(input.contextBlock.block)
  }
  return parts.length > 0 ? parts.join("\n\n") : null
}

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

/**
 * config 层第二道门（spec §2.2）：按 caller 矩阵把 5 个生命周期工具
 * 对每个 agent 置 true/false。agent 名 → 角色映射与 caller.ts ROLE_BY_AGENT 一致。
 */
export function configureLifecycleTools(config: GoalToolConfig): void {
  const lifecycleTools = ["setup_control", "flow_control", "task_control", "tdd_checkpoint", "release_control"] as const
  const agentRole = (name: string): string => {
    switch (name) {
      case "dev-lifecycle": return "primary"
      case "developer": return "developer"
      case "architect": return "architect"
      case "reviewer": return "reviewer"
      case "goal-verify": return "goal-verify"
      default: return "reviewer"
    }
  }
  const canUseTool = (role: string, tool: string): boolean => {
    if (role === "goal-verify") return tool === "flow_control"
    switch (tool) {
      case "tdd_checkpoint": return role === "primary" || role === "developer"
      default: return role === "primary"
    }
  }

  for (const [agentName, agent] of Object.entries(config.agent ?? {})) {
    if (!agent || typeof agent !== "object" || Array.isArray(agent)) continue
    const agentConfig = agent as AgentToolConfig
    const role = agentRole(agentName)
    const toolFlags: Record<string, boolean> = {}
    for (const toolName of lifecycleTools) {
      toolFlags[toolName] = canUseTool(role, toolName)
    }
    agentConfig.tools = { ...agentConfig.tools, ...toolFlags }
  }
}

async function queueContinuation(
  client: ReturnType<typeof import("@opencode-ai/sdk/v2").createOpencodeClient>,
  sessionID: string,
  projectDir?: string
) {
  const { goal } = await readGoal(client, sessionID)
  if (!goal || goal.status !== "active") return

  if (projectDir) {
    await updateFlowSession(projectDir, goal.parentIssueNumber, { status: goal.status, continuationCount: goal.continuationCount })
  }

  if (abortedSessions.has(sessionID)) {
    abortedSessions.delete(sessionID)
    goal.status = "paused"
    await writeGoal(client, sessionID, goal)
    if (projectDir) await updateFlowSession(projectDir, goal.parentIssueNumber, { status: "paused" })
    return
  }

  if (goal.continuationCount >= MAX_CONTINUATIONS) {
    goal.status = "paused"
    await writeGoal(client, sessionID, goal)
    if (projectDir) await updateFlowSession(projectDir, goal.parentIssueNumber, { status: "paused" })
    return
  }

  goal.continuationCount++
  await writeGoal(client, sessionID, goal)
  if (projectDir) await updateFlowSession(projectDir, goal.parentIssueNumber, { continuationCount: goal.continuationCount })

  try {
    if (goal.continuationCount > 0 && goal.continuationCount % COMPACTION_THRESHOLD === 0) {
      try {
        await client.session.promptAsync({
          sessionID,
          parts: [{ type: "text" as const, text: "[compact] The session history is growing long. Summarize completed work and continue.", synthetic: true }],
        })
      } catch {}
    }

    const contextBlock = projectDir ? await getContextBlock(projectDir) : null
    const contextText = contextBlock ? `${formatContextBlock(contextBlock)}\n\n` : ""

    await client.session.promptAsync({
      sessionID,
      parts: [{ type: "text" as const, text: contextText + continuationPrompt(goal.parentIssueNumber), synthetic: true }],
    })
  } catch (err) {
    console.error("[cabbage] continuation failed:", err)
  }
}

async function autoResume(client: ReturnType<typeof import("@opencode-ai/sdk/v2").createOpencodeClient>, projectDir: string) {
  const index = await readIndex(projectDir)

  for (const [parentIssueNumber, entry] of Object.entries(index.flows)) {
    if (entry.status !== "active") continue

    const { goal } = await readGoal(client, entry.sessionID)
    if (!goal || goal.status !== "active") {
      await updateFlowSession(projectDir, Number(parentIssueNumber), { status: "paused" })
      continue
    }

    try {
      await client.session.promptAsync({
        sessionID: entry.sessionID,
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
) {
  return tool({
    description: `Control the FlowRun lifecycle: start a FlowRun, transition stages, start tasks, and finalize completed runs.

Operations:
- run-start: Transition FlowRun from planned → running. Binds Goal to FlowRun.
- stage-start: Start a stage (requirements/design/tasks/code). Requires prerequisites met.
- stage-complete: Complete a stage (requirements/design/tasks). Requires all checks pass.
- task-start: Start a task (pending/ready → running). Freezes TDD policy and sets execution binding.
- run-finalize: Mark code→test→review→merge stages as pass, set FlowRun to completed. Requires all Tasks merged. Idempotent.`,
    args: {
      op: tool.schema.enum(["run-start", "stage-start", "stage-complete", "task-start", "run-finalize"]).describe("Flow control operation"),
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
      const op = args.op as string
      const parentIssueNumber = args.parent_issue_number as number

      try {
        switch (op) {
          case "run-start":
            return handleRunStart(broker, parentIssueNumber)
          case "stage-start":
            return handleStageStart(broker, parentIssueNumber, args.stage as string)
          case "stage-complete":
            return handleStageComplete(broker, parentIssueNumber, args.stage as string)
          case "task-start":
            return handleTaskStart(broker, parentIssueNumber, args.task_id as string, args.execution_binding as TaskExecutionBinding | undefined, args.tdd_policy_json as string | undefined)
          case "run-finalize":
            return handleRunFinalize(broker, parentIssueNumber)
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
  parentIssueNumber: number,
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

async function handleRunFinalize(
  broker: FlowBroker,
  parentIssueNumber: number,
): Promise<string> {
  const writeResult = await broker.writeFlowRunWithLock<unknown>(parentIssueNumber, (flowRun) => {
    const res = flowRunFinalize(flowRun)
    if (!res.ok) {
      return { flowRun, result: res.error, shouldPersist: false }
    }
    return {
      flowRun: res.value,
      result: { status: res.value.status, completedAt: res.value.completedAt },
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
    const flowControlTool = createFlowControlTool(broker)

    const agentsDir = path.join(packageRoot, "assets", "agents")

    await initPrompts(packageRoot, projectDir)
    await initBootstrap()
    startPeriodicCleanup()

    autoResume(goalClient, projectDir)

    return {
      tool: {
        goal: goalTool,
        flow_control: flowControlTool,
      },

      config: async (rawConfig) => {
        const config = rawConfig as Record<string, any>

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
        // 渲染 permission 占位符：`<profile-test-command>` → Profile.testCommand 首 token（§9.1）
        const profile = await readProjectProfile(projectDir)
        const testCommandToken = profile.testCommand?.split(" ")[0] ?? ""
        const renderPermission = (perm: Record<string, any> | undefined): Record<string, any> | undefined => {
          if (!perm) return perm
          const renderRules = (rules: Record<string, string> | undefined): Record<string, string> | undefined => {
            if (!rules) return rules
            const out: Record<string, string> = {}
            for (const [pattern, action] of Object.entries(rules)) {
              if (pattern.includes("<profile-test-command>") && testCommandToken === "") {
                // Profile 未配置测试命令 → 删除占位规则，避免渲染成 "*" 覆盖兜底 deny
                continue
              }
              out[pattern.replaceAll("<profile-test-command>", testCommandToken)] = action
            }
            return out
          }
          const out: Record<string, any> = { ...perm }
          if (perm.bash && typeof perm.bash === "object" && !Array.isArray(perm.bash)) {
            out.bash = renderRules(perm.bash as Record<string, string>)
          }
          return out
        }

        for (const agent of loadAgents(agentsDir)) {
          if (config.agent[agent.key]) continue
          config.agent[agent.key] = {
            description: agent.description,
            mode: agent.mode,
            color: agent.color,
            prompt: agent.prompt,
            permission: renderPermission(agent.permission),
            shell: {
              env: createAgentShellEnv(),
            },
          }
        }

        configureGoalTools(config)
        configureLifecycleTools(config)
      },

      "experimental.chat.messages.transform": async (_input, output) => {
        if (!output.messages.length) return

        const firstUser = output.messages.find(m => m.info.role === "user")
        if (!firstUser || !firstUser.parts.length) return

        if (firstUser.parts.some(p => p.type === "text" && (p.text.includes("EXTREMELY_IMPORTANT") || p.text.includes(CONTEXT_MARKER)))) return

        const sessionID = output.messages[0].info.sessionID as string
        const { goal, session } = await readGoal(goalClient, sessionID)
        const contextBlock = await getContextBlock(projectDir)

        const injection = buildFirstUserInjection({
          hasGoal: goal?.status === "active",
          isSubAgent: !!session?.parentID,
          contextBlock,
          bootstrap: getBootstrapContent(),
        })
        if (injection) {
          firstUser.parts.unshift({ type: "text", text: injection } as typeof firstUser.parts[number])
        }
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
                  text: `[auto-retry] Previous attempt failed. Try a different approach.\n\n${formatGoal(goal)}`,
                  synthetic: true,
                }],
              })
            } else if (action === "skip" && goal) {
              await goalClient.session.promptAsync({
                sessionID,
                parts: [{
                  type: "text" as const,
                  text: `[skip] Skipping failed step. Continue with remaining work.\n\n${formatGoal(goal)}`,
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
              await updateFlowSession(projectDir, goal.parentIssueNumber, { status: "completed" })
            }
          }
        }
      },
    }
  }
}

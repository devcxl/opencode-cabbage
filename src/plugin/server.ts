import type { Plugin } from "@opencode-ai/plugin"
import path from "node:path"

import { initPrompts } from "./prompts.js"
import { initBootstrap, getBootstrapContent } from "./bootstrap.js"
import { loadCommands } from "./commands.js"
import { setupSkillsDir } from "./skills.js"
import { loadAgents } from "./agents.js"
import { createAgentShellEnv } from "./shell.js"
import { createGoalClient, createGoalTool, readGoal, writeGoal, MAX_CONTINUATIONS, continuationPrompt, formatGoal } from "./goal.js"
import { readIndex, updateFlowSession } from "../kernel/session-index.js"
import { getContextBlock, formatContextBlock, CONTEXT_MARKER } from "../kernel/context.js"
import type { ContextBlock } from "../kernel/context.js"
import { readProjectProfile } from "../kernel/profile.js"

const abortedSessions = new Set<string>()
const continuationInFlight = new Set<string>()
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

async function queueContinuation(
  client: ReturnType<typeof import("@opencode-ai/sdk/v2").createOpencodeClient>,
  sessionID: string,
  projectDir?: string
) {
  const { goal } = await readGoal(client, sessionID)
  if (!goal || goal.status !== "active") return

  if (continuationInFlight.has(sessionID)) return
  continuationInFlight.add(sessionID)

  if (projectDir) {
    await updateFlowSession(projectDir, goal.parentIssueNumber, { status: goal.status, continuationCount: goal.continuationCount })
  }

  if (abortedSessions.has(sessionID)) {
    abortedSessions.delete(sessionID)
    continuationInFlight.delete(sessionID)
    goal.status = "paused"
    await writeGoal(client, sessionID, goal)
    if (projectDir) await updateFlowSession(projectDir, goal.parentIssueNumber, { status: "paused" })
    return
  }

  if (goal.continuationCount >= MAX_CONTINUATIONS) {
    continuationInFlight.delete(sessionID)
    goal.status = "paused"
    await writeGoal(client, sessionID, goal)
    if (projectDir) await updateFlowSession(projectDir, goal.parentIssueNumber, { status: "paused" })
    return
  }

  try {
    if (goal.continuationCount > 0 && goal.continuationCount % COMPACTION_THRESHOLD === 0) {
      try {
        await client.session.promptAsync({
          sessionID,
          parts: [{ type: "text" as const, text: "[compact] The session history is growing long. Summarize completed work and continue.", synthetic: true }],
        })
      } catch (err) {
        console.warn("[cabbage] compaction prompt failed:", err)
      }
    }

    const contextBlock = projectDir ? await getContextBlock(projectDir) : null
    const contextText = contextBlock ? `${formatContextBlock(contextBlock)}\n\n` : ""

    // abort 二次检查：idle 与 abort 事件并发时，避免对已 abort 的会话发出续接
    if (abortedSessions.has(sessionID)) {
      abortedSessions.delete(sessionID)
      goal.status = "paused"
      await writeGoal(client, sessionID, goal)
      return
    }

    // 先发续接 prompt，成功后递增计数（失败不消耗配额）
    await client.session.promptAsync({
      sessionID,
      parts: [{ type: "text" as const, text: contextText + continuationPrompt(goal.parentIssueNumber), synthetic: true }],
      ...(goal.sessionProfile ? { agent: goal.sessionProfile.agent, model: goal.sessionProfile.model } : {}),
    })

    goal.continuationCount++
    await writeGoal(client, sessionID, goal)
    if (projectDir) await updateFlowSession(projectDir, goal.parentIssueNumber, { continuationCount: goal.continuationCount })
  } catch (err) {
    console.error("[cabbage] continuation failed:", err)
  } finally {
    continuationInFlight.delete(sessionID)
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
        ...(goal.sessionProfile ? { agent: goal.sessionProfile.agent, model: goal.sessionProfile.model } : {}),
      })
    } catch (err) {
      console.error("[cabbage] auto-resume failed:", err)
    }
  }
}

const ABORTED_SESSION_CLEANUP_INTERVAL = 1000 * 60 * 30
let abortedCleanupTimer: ReturnType<typeof setInterval> | null = null

function startPeriodicCleanup() {
  if (abortedCleanupTimer) clearInterval(abortedCleanupTimer)
  abortedCleanupTimer = setInterval(() => {
    abortedSessions.clear()
  }, ABORTED_SESSION_CLEANUP_INTERVAL)
}


export function createOpencodeCabbage(packageRoot: string): Plugin {
  return async (ctx, _options) => {
    const sourceSkillsDir = path.join(packageRoot, "assets", "skills")
    const promptsDir = path.join(packageRoot, "assets", "prompts")
    const commandsDir = path.join(packageRoot, "assets", "commands")
    const skillsDir = await setupSkillsDir(sourceSkillsDir, promptsDir)

    const projectDir = ctx.worktree || ctx.directory
    const v1Client = (ctx.client as unknown as V1ClientContainer)._client
    const goalClient = createGoalClient(ctx.serverUrl, v1Client)
    const goalTool = createGoalTool(goalClient, projectDir)

    const agentsDir = path.join(packageRoot, "assets", "agents")

    await initPrompts(packageRoot, projectDir)
    await initBootstrap()
    startPeriodicCleanup()

    void autoResume(goalClient, projectDir).catch(err => {
      console.error("[cabbage] auto-resume failed:", err)
    })

    return {
      tool: {
        goal: goalTool,
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
            try {
              const result = await goalClient.session.get({ sessionID }) as unknown as SessionGetResponse
              if (result?.data?.parentID) return
            } catch (err) {
              console.error("[cabbage] session lookup failed:", err)
              return
            }
            await queueContinuation(goalClient, sessionID, projectDir).catch(err => {
              console.error("[cabbage] continuation failed:", err)
            })
          }
        }

        if (evt.type === "message.updated" && evt.properties?.info?.role === "user") {
          const sessionID: string | undefined = evt.properties.sessionID
          if (sessionID && !continuationInFlight.has(sessionID)) {
            abortedSessions.delete(sessionID)
            const { goal, session } = await readGoal(goalClient, sessionID)
            if (goal) {
              goal.continuationCount = 0
              // 刷新用户最后使用的 agent/模型快照（用户在 TUI 切换 agent/模型后发消息）
              const info = evt.properties.info as { agent?: string; model?: { providerID: string; modelID: string } }
              if (info?.agent) {
                goal.sessionProfile = {
                  agent: info.agent,
                  model: info.model?.providerID ? { providerID: info.model.providerID, modelID: info.model.modelID } : goal.sessionProfile?.model,
                }
              }
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

import type { Plugin } from "@opencode-ai/plugin"
import path from "node:path"

import { initPrompts } from "./prompts.js"
import { initBootstrap, getBootstrapContent } from "./bootstrap.js"
import { loadCommands } from "./commands.js"
import { setupSkillsDir } from "./skills.js"
import { loadAgents } from "./agents.js"
import { createAgentShellEnv } from "./shell.js"
import { createGoalClient, createGoalTool, readGoal, mutateGoal, MAX_CONTINUATIONS, continuationPrompt, formatGoal, isBlockedReport, isDoneReport, snapshotTokenTotal, budgetReached } from "./goal.js"
import { readIndex, updateFlowSession, removeFlowSession } from "../kernel/session-index.js"
import { getContextBlock, formatContextBlock, CONTEXT_MARKER } from "../kernel/context.js"
import type { ContextBlock } from "../kernel/context.js"
import { readProjectProfile } from "../kernel/profile.js"

const abortedSessions = new Set<string>()
const continuationInFlight = new Set<string>()
const COMPACTION_THRESHOLD = 20
/** autoResume 跳过窗口：索引 30s 内更新过的 flow 不恢复（可能刚续接过，立即恢复会双发） */
const AUTO_RESUME_SKIP_WINDOW_MS = 30_000

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
 * 子会话活动闸：后台 subagent 运行时父会话保持 idle（结果稍后注入父会话）。
 * 此时续接会压过子代理结果注入，必须跳过本次续接，等子代理结束后父会话的
 * 下一次 busy→idle 循环再触发。查询失败视为 unknown → 保守跳过（不续接）。
 */
async function hasWorkingChildren(
  client: ReturnType<typeof import("@opencode-ai/sdk/v2").createOpencodeClient>,
  sessionID: string,
): Promise<boolean> {
  try {
    const childrenResult = await client.session.children({ sessionID }) as unknown as { data?: Array<{ id?: string }> }
    const children = Array.isArray(childrenResult?.data) ? childrenResult.data : []
    if (children.length === 0) return false
    const statusResult = await client.session.status() as unknown as { data?: Record<string, { type?: string }> }
    const statuses = statusResult?.data
    if (!statuses || typeof statuses !== "object") return true
    return children.some((child) => {
      const status = child?.id ? statuses[child.id] : null
      return status?.type === "busy" || status?.type === "retry"
    })
  } catch (error) {
    // 查询失败 → 保守跳过（fail-closed）；告警使长期故障可观测（否则续接会静默永久停止）
    console.warn(`[cabbage] child-session check failed for ${sessionID}:`, (error as Error | null)?.message ?? error)
    return true
  }
}

export async function queueContinuation(
  client: ReturnType<typeof import("@opencode-ai/sdk/v2").createOpencodeClient>,
  sessionID: string,
  projectDir?: string
) {
  if (continuationInFlight.has(sessionID)) return
  continuationInFlight.add(sessionID)

  try {
    const decision = await mutateGoal(client, sessionID, async (goal): Promise<{
      goal: typeof goal
      value: { proceed: boolean; goal: typeof goal } | null
    }> => {
      // 读改写与 message.updated 同锁串行，杜绝续接计数/状态被并发覆盖
      if (!goal || goal.status !== "active") return { goal, value: null }

      if (projectDir) {
        await updateFlowSession(projectDir, goal.parentIssueNumber, { status: goal.status, continuationCount: goal.continuationCount })
      }

      if (abortedSessions.has(sessionID)) {
        abortedSessions.delete(sessionID)
        goal.status = "paused"
        if (projectDir) await updateFlowSession(projectDir, goal.parentIssueNumber, { status: "paused" })
        return { goal, value: null }
      }

      if (goal.continuationCount >= MAX_CONTINUATIONS) {
        goal.status = "paused"
        if (projectDir) await updateFlowSession(projectDir, goal.parentIssueNumber, { status: "paused" })
        return { goal, value: null }
      }

      // 子会话活动闸：后台 subagent 仍 busy/retry 时跳过续接（父会话 idle 不代表任务静默）
      if (await hasWorkingChildren(client, sessionID)) {
        return { goal, value: null }
      }

      // 尾部静默检查：idle 事件可能竞态了后续消息/未落盘的回复。
      // 最后一条是 user 消息、或最后 assistant 未完成（无 completed 时间）→
      // 会话正在或即将忙碌，等下一次 idle 事件重新触发；无 assistant 消息则无 provider/model 可续。
      const messagesResult = await client.session.messages({ sessionID, limit: 40 }) as unknown as {
        data?: Array<{ info?: Record<string, unknown> }>
      }
      const messages = Array.isArray(messagesResult?.data) ? messagesResult.data : null
      if (!messages) return { goal, value: null }
      const lastMessageInfo = messages.length > 0 ? messages[messages.length - 1]?.info : null
      if (lastMessageInfo?.role === "user") return { goal, value: null }
      let lastAssistantMessage: { info?: Record<string, unknown>; parts?: Array<{ type?: string; text?: string }> } | null = null
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const message = messages[i]
        if (message?.info?.role === "assistant") {
          lastAssistantMessage = message
          break
        }
      }
      const lastAssistantInfo = lastAssistantMessage?.info ?? null
      const assistantCompleted = typeof lastAssistantInfo?.time === "object"
        && lastAssistantInfo.time !== null
        && (lastAssistantInfo.time as { completed?: number }).completed
        && (lastAssistantInfo.time as { completed?: number }).completed! > 0
      if (!lastAssistantInfo) return { goal, value: null }
      if (!assistantCompleted && !lastAssistantInfo.error) return { goal, value: null }
      if (!lastAssistantInfo.id) return { goal, value: null }

      // [BLOCKED:] 阻塞报告 / [DONE:] 完成报告：agent 明确信号 → 暂停 goal 请用户/验证介入
      // （防空转烧 token；完成报告后应由 dev-lifecycle 派 goal-verify 做最终独立验证）。
      // resume 后首次 tick 豁免（statusReason='resumed' 被消费清除），
      // 否则 resume 会立即被上一轮旧报告再次暂停成死路。
      const assistantText = (lastAssistantMessage?.parts ?? [])
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text!)
        .join("\n")
      const agentSignaled = isBlockedReport(assistantText) || isDoneReport(assistantText)
      if (agentSignaled) {
        if (goal.statusReason === "resumed") {
          goal.statusReason = ""
        } else {
          goal.status = "paused"
          goal.statusReason = isBlockedReport(assistantText) ? "blocked report" : "done report"
          if (projectDir) await updateFlowSession(projectDir, goal.parentIssueNumber, { status: "paused" })
          return { goal, value: null }
        }
      } else if (goal.statusReason === "resumed") {
        // 豁免消费：resume 后的首次 tick 无论是否命中信号都清除 kickoff 标记。
        // 若不消费，首 tick 正常推进后 statusReason 残留，后续真实信号会被误豁免一次。
        goal.statusReason = ""
      }

      // Token 记账（快照法）：最新完成 assistant 轮的 input+cache.read+output 即整段成本
      // （OpenCode 每轮 cache.read 已含此前所有付费 token）。goal 相对化：首次 tick
      // 用创建时刻前最后完成的 assistant 轮初始化 baseline；单调不减，context 收缩不回退。
      // compaction 不做分段（预算为护栏非账单）。
      let tokensBaseline = goal.tokensBaseline ?? 0
      if (!(tokensBaseline > 0) && typeof goal.createdAt === "number") {
        for (const message of messages) {
          const info = message?.info
          if (info?.role !== "assistant") continue
          const completed = (info.time as { completed?: number } | undefined)?.completed
          if (!(completed && completed > 0) || completed > goal.createdAt) continue
          tokensBaseline = Math.max(tokensBaseline, snapshotTokenTotal(info.tokens))
        }
      }
      const tokensUsed = Math.max(
        goal.tokensUsed ?? 0,
        Math.max(0, snapshotTokenTotal(lastAssistantInfo.tokens) - tokensBaseline),
      )
      goal.tokensBaseline = tokensBaseline
      goal.tokensUsed = tokensUsed

      // token 预算护栏：达限即暂停（用户需提高预算后 resume，护栏优先）
      if (budgetReached(goal)) {
        goal.status = "paused"
        goal.statusReason = "token budget reached"
        if (projectDir) await updateFlowSession(projectDir, goal.parentIssueNumber, { status: "paused" })
        return { goal, value: null }
      }

      // 先写计数后发 prompt：崩溃窗口只会"少发一次续接"（等下次 idle 重试），
      // 不会"prompt 已发但计数未落盘"导致重启 autoResume 双发。
      goal.continuationCount++
      if (projectDir) await updateFlowSession(projectDir, goal.parentIssueNumber, {
        continuationCount: goal.continuationCount,
        lastContinuedAt: Date.now(),
      })
      return { goal, value: { proceed: true, goal } }
    })

    if (!decision?.proceed || !decision.goal) return

    // abort 二次检查：idle 与 abort 事件并发时，避免对已 abort 的会话发出续接
    if (abortedSessions.has(sessionID)) {
      abortedSessions.delete(sessionID)
      await mutateGoal(client, sessionID, async (goal) => {
        if (!goal) return { goal, value: null }
        goal.status = "paused"
        goal.continuationCount = Math.max(0, goal.continuationCount - 1)
        if (projectDir) await updateFlowSession(projectDir, goal.parentIssueNumber, { status: "paused" })
        return { goal, value: null }
      }).catch(() => undefined)
      return
    }

    // 每 20 次续接主动 compact 会话历史（压缩失败不阻塞续接）
    if (decision.goal.continuationCount > 0 && decision.goal.continuationCount % COMPACTION_THRESHOLD === 0) {
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

    try {
      await client.session.promptAsync({
        sessionID,
        parts: [{ type: "text" as const, text: contextText + continuationPrompt(decision.goal.parentIssueNumber), synthetic: true }],
        ...(decision.goal.sessionProfile ? { agent: decision.goal.sessionProfile.agent, model: decision.goal.sessionProfile.model } : {}),
      })
    } catch (err) {
      // 发送失败 → 回滚计数（尽力；回滚失败只会少一次续接，方向安全）
      console.error("[cabbage] continuation prompt failed, rolling back counter:", err)
      await mutateGoal(client, sessionID, async (goal) => {
        if (!goal) return { goal, value: null }
        goal.continuationCount = Math.max(0, goal.continuationCount - 1)
        if (projectDir) await updateFlowSession(projectDir, goal.parentIssueNumber, { continuationCount: goal.continuationCount })
        return { goal, value: null }
      }).catch(() => undefined)
    }
  } catch (err) {
    console.error("[cabbage] continuation failed:", err)
  } finally {
    continuationInFlight.delete(sessionID)
  }
}

export async function autoResume(client: ReturnType<typeof import("@opencode-ai/sdk/v2").createOpencodeClient>, projectDir: string) {
  const index = await readIndex(projectDir)

  for (const [parentIssueNumber, entry] of Object.entries(index.flows)) {
    if (entry.status !== "active") continue

    // 重启双发防护：仅跳过"最近实际续接过"的 flow（lastContinuedAt 在发送续接时写入）。
    // 不用 updatedAt——它被 queueContinuation 开头的索引心跳无条件刷新，反映"最近 idle"，
    // 崩溃前频繁 idle 的 flow 会被误跳过且无再武装（静默卡住）。
    // 无 lastContinuedAt 的旧 entry 不跳过（兼容升级前索引）。跳过时告警保证可观测。
    if (entry.lastContinuedAt && Date.now() - entry.lastContinuedAt < AUTO_RESUME_SKIP_WINDOW_MS) {
      console.warn(`[cabbage] auto-resume: skip #${parentIssueNumber} (continued ${Math.round((Date.now() - entry.lastContinuedAt) / 1000)}s ago; next idle event re-arms)`)
      continue
    }

    const { goal } = await readGoal(client, entry.sessionID)
    // 索引一致性自愈：entry 指向的 goal 已是别的 Flow（edit 换 Flow 后旧 entry 残留/rebind 失败）→
    // 删除陈旧 entry，防止每次重启对同一会话重复续接
    if (goal && goal.parentIssueNumber !== Number(parentIssueNumber)) {
      console.warn(`[cabbage] auto-resume: index #${parentIssueNumber} points to goal of Flow #${goal.parentIssueNumber}; removing stale entry`)
      await removeFlowSession(projectDir, Number(parentIssueNumber))
      continue
    }
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
            const info = evt.properties.info as { agent?: string; model?: { providerID: string; modelID: string } }
            await mutateGoal(goalClient, sessionID, async (goal) => {
              if (!goal) return { goal, value: undefined }
              goal.continuationCount = 0
              // 刷新用户最后使用的 agent/模型快照（用户在 TUI 切换 agent/模型后发消息）
              if (info?.agent) {
                goal.sessionProfile = {
                  agent: info.agent,
                  model: info.model?.providerID ? { providerID: info.model.providerID, modelID: info.model.modelID } : goal.sessionProfile?.model,
                }
              }
              return { goal, value: undefined }
            })
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

import type { Plugin } from "@opencode-ai/plugin"
import path from "node:path"
import { readFile, writeFile, mkdir } from "node:fs/promises"
import { existsSync } from "node:fs"

import { initPrompts } from "./prompts.js"
import { initBootstrap, getBootstrapContent } from "./bootstrap.js"
import { loadCommands } from "./commands.js"
import { setupSkillsDir } from "./skills.js"
import { loadAgents } from "./agents.js"
import { createGoalClient, createGoalTool, readGoal, writeGoal, MAX_CONTINUATIONS, continuationPrompt, verifyAgentPrompt, formatGoal } from "./goal.js"

const abortedSessions = new Set<string>()
const errorRetryCount = new Map<string, number>()
const COMPACTION_THRESHOLD = 20

interface V1ClientContainer {
  _client?: { getConfig?: () => Record<string, unknown> }
}

interface SessionGetResponse {
  data?: { parentID?: string | null; metadata?: Record<string, unknown> }
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
  if (abortedCleanupTimer) return
  abortedCleanupTimer = setInterval(() => {
    abortedSessions.clear()
    errorRetryCount.clear()
  }, ABORTED_SESSION_CLEANUP_INTERVAL)
}

export function createOpencodeCabbage(packageRoot: string): Plugin {
  return async (ctx, _options) => {
    const sourceSkillsDir = path.join(packageRoot, "assets", "skills")
    const contextDir = path.join(packageRoot, "assets", "context")
    const commandsDir = path.join(packageRoot, "assets", "commands")
    const skillsDir = await setupSkillsDir(sourceSkillsDir, contextDir)

    const projectDir = ctx.worktree || ctx.directory
    const v1Client = (ctx.client as unknown as V1ClientContainer)._client
    const goalClient = createGoalClient(ctx.serverUrl, v1Client)
    const goalTool = createGoalTool(goalClient)

    const agentsDir = path.join(packageRoot, "assets", "agents")

    await initPrompts(packageRoot, projectDir)
    await initBootstrap()
    startPeriodicCleanup()

    autoResume(goalClient, projectDir)

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
        for (const agent of loadAgents(agentsDir)) {
          if (config.agent[agent.key]) continue
          config.agent[agent.key] = {
            description: agent.description,
            mode: agent.mode,
            color: agent.color,
            prompt: agent.prompt,
            tools: agent.tools ?? { read: true, bash: true, write: true, edit: true },
          }
        }

        if (!config.agent["goal-verify"]) {
          config.agent["goal-verify"] = {
            mode: "subagent",
            description: "Goal verification agent. Verifies completion independently.",
            prompt: verifyAgentPrompt(),
            tools: { read: true, bash: true, write: false, edit: false },
          }
        }
      },

      "experimental.chat.messages.transform": async (_input, output) => {
        const bootstrap = getBootstrapContent()
        if (!output.messages.length) return

        const firstUser = output.messages.find(m => m.info.role === "user")
        if (!firstUser || !firstUser.parts.length) return

        if (firstUser.parts.some(p => p.type === "text" && p.text.includes("EXTREMELY_IMPORTANT"))) return

        firstUser.parts.unshift({ type: "text", text: bootstrap } as typeof firstUser.parts[number])
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

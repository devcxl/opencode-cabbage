import type { Plugin } from "@opencode/plugin"
import path from "node:path"
import { readFileSync } from "node:fs"

import { initPrompts } from "./prompts.js"
import { initBootstrap, getBootstrapContent } from "./bootstrap.js"
import { loadCommands } from "./commands.js"
import { setupSkillsDir, loadSkillEntries } from "./skills.js"
import { buildAgentPayloads } from "./agents.js"
import { createAgentShellEnv } from "./shell.js"
import { buildGoalTool, GOAL_ALLOWED_AGENTS } from "./goal.js"
import { mutateGoal } from "./goal.js"
import { createSessionGoalStore } from "./goal-store.js"
import { setupCabbageCli } from "./cabbage-cli.js"
import { buildCabbageTool } from "./cabbage-tool.js"
import { queueContinuation, autoResume, SessionActivityTracker } from "./continuation.js"
import { markAborted, clearAborted, clearAllAborted } from "./session-abort.js"
import { getContextBlock, CONTEXT_MARKER } from "../kernel/context.js"
import type { ContextBlock } from "../kernel/context.js"
import { readProjectProfile } from "../kernel/profile.js"

type Context = Plugin.Context

/** bootstrap 注入标记（重复注入检测用） */
const BOOTSTRAP_MARKER = "EXTREMELY_IMPORTANT"

const ABORTED_SESSION_CLEANUP_INTERVAL = 1000 * 60 * 30

/** 从插件包根读取版本号（skills 安装目录按版本隔离） */
function readPluginVersion(packageRoot: string): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as { version?: string }
    return typeof pkg.version === "string" && pkg.version !== "" ? pkg.version : "0.0.0"
  } catch {
    return "0.0.0"
  }
}

export interface FirstUserInjectionInput {
  hasGoal: boolean
  isSubAgent: boolean
  contextBlock: ContextBlock | null
  bootstrap: string
}

/**
 * 决定系统上下文注入内容：
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

interface V2EventLike {
  type?: string
  data?: Record<string, unknown>
}

/**
 * 刷新 goal 的会话配置快照（用户切换 agent/模型、或用户新输入时调用）。
 * 数据源为 SessionInfo.agent/model（当前会话选择），V2 形状 {providerID, id, variant?}。
 */
async function refreshSessionProfile(
  store: ReturnType<typeof createSessionGoalStore>,
  sessionID: string,
): Promise<void> {
  await mutateGoal(store, sessionID, async (goal, session) => {
    if (!goal) return { goal, value: undefined }
    const agent = session?.agent ?? goal.sessionProfile?.agent
    if (!agent) return { goal, value: undefined }
    const sessionModel = session?.model
    const model = sessionModel && sessionModel.providerID && sessionModel.id
      ? { providerID: sessionModel.providerID, id: sessionModel.id, ...(sessionModel.variant ? { variant: sessionModel.variant } : {}) }
      : goal.sessionProfile?.model
    goal.sessionProfile = { agent, ...(model ? { model } : {}) }
    return { goal, value: undefined }
  }).catch((err) => {
    console.warn("[cabbage] session profile refresh failed:", (err as Error | null)?.message ?? err)
  })
}

/**
 * 事件分发（V2 事件词汇）：
 * - execution.* → 子会话活动跟踪 + 轮次结束驱动续接
 * - execution.interrupted(reason=user) → 中断即持久化暂停（不依赖内存标记）
 * - inbox.enqueued(user) → 重置计数 + 刷新 profile + 清除中断标记
 * - session.created → 父子关系跟踪
 */
async function dispatchEvent(
  ctx: Context,
  store: ReturnType<typeof createSessionGoalStore>,
  tracker: SessionActivityTracker,
  projectDir: string,
  evt: V2EventLike,
): Promise<void> {
  const data = evt.data ?? {}
  const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined

  switch (evt.type) {
    case "session.created": {
      if (sessionID) tracker.onCreated(sessionID, typeof data.parentID === "string" ? data.parentID : undefined)
      return
    }

    case "session.execution.started":
    case "session.retry.scheduled": {
      if (sessionID) tracker.onBusy(sessionID)
      return
    }

    case "session.execution.succeeded": {
      if (!sessionID) return
      tracker.onIdle(sessionID)
      const { session, goal } = await store.read(sessionID)
      if (!session || session.parentID) return
      if (!goal || goal.status !== "active") return
      await queueContinuation(ctx, store, sessionID, projectDir, tracker)
      return
    }

    case "session.execution.failed": {
      // 普通轮次错误不自动续接（与 V1 口径一致：[BLOCKED:] 协议覆盖卡点检测，
      // 错误可能自愈，空转续接反而烧 token；若实测发现卡死再补 error 暂停）
      if (sessionID) tracker.onIdle(sessionID)
      return
    }

    case "session.execution.interrupted": {
      if (!sessionID) return
      tracker.onIdle(sessionID)
      // 用户中断的两种 reason（v2.0.26 实测，v2.0.28 复验）：API session.interrupt → "user"；TUI Esc → "shutdown"。
      // 两者都视为用户中断并暂停 goal；服务端关闭走 execution.failed（不命中本分支），
      // 因此不会误暂停 autoResume 可恢复的 goal（详见 ADR 0010）。
      if (data.reason !== "user" && data.reason !== "shutdown") return
      markAborted(sessionID)
      // abort 立即持久化 pause：不依赖内存标记。
      // 否则 30 分钟清理窗口内无轮次结束事件、或插件重启时标记丢失，
      // 用户主动中断的 goal 会被下次轮次/autoResume 自动续接（继续烧 token）。
      void mutateGoal(store, sessionID, async (goal) => {
        if (!goal || goal.status !== "active") return { goal, value: undefined }
        goal.status = "paused"
        goal.statusReason = "aborted by user"
        return { goal, value: undefined }
      }).catch((err) => {
        console.warn("[cabbage] abort pause failed:", (err as Error | null)?.message ?? err)
      })
      return
    }

    case "session.inbox.enqueued": {
      if (!sessionID) return
      const item = data.item as { type?: string } | undefined
      if (item?.type !== "user") return
      clearAborted(sessionID)
      await mutateGoal(store, sessionID, async (goal) => {
        if (!goal) return { goal, value: undefined }
        goal.continuationCount = 0
        return { goal, value: undefined }
      }).catch(() => undefined)
      await refreshSessionProfile(store, sessionID)
      return
    }

    case "session.agent.selected":
    case "session.model.selected": {
      if (sessionID) await refreshSessionProfile(store, sessionID)
      return
    }

    default:
      return
  }
}

export async function setupCabbage(ctx: Context, packageRoot: string): Promise<() => void> {
  const sourceSkillsDir = path.join(packageRoot, "assets", "skills")
  const promptsDir = path.join(packageRoot, "assets", "prompts")
  const commandsDir = path.join(packageRoot, "assets", "commands")
  const agentsDir = path.join(packageRoot, "assets", "agents")
  const projectDir = ctx.location.directory

  const pluginVersion = readPluginVersion(packageRoot)
  const skillsDir = await setupSkillsDir(sourceSkillsDir, promptsDir, pluginVersion)

  // 预读磁盘内容：transform 回调是同步的，所有 IO 必须先完成
  const skillEntries = await loadSkillEntries(skillsDir)
  const commands = loadCommands(commandsDir, skillsDir)
  const profile = await readProjectProfile(projectDir)
  const testCommandToken = profile.testCommand?.split(" ")[0] ?? ""
  const agentPayloads = buildAgentPayloads(agentsDir, testCommandToken)

  initPrompts(packageRoot, projectDir)
  await initBootstrap()

  const store = createSessionGoalStore(ctx.session)
  const tracker = new SessionActivityTracker()

  // 内置 Cabbage 引擎（阶段二）：按插件版本释放捆绑的 Python 包；
  // 缺 Python 时工具返回可读错误，其余功能不受影响。
  const cabbage = await setupCabbageCli(packageRoot, pluginVersion)
  if (!cabbage.available) {
    console.warn(`[cabbage] built-in change records unavailable: ${cabbage.reason}`)
  }

  // ── skills：注册为原生 skill（内容指向按版本隔离的安装目录，references 可解析） ──
  await ctx.skill.transform((editor) => {
    for (const skill of skillEntries) {
      editor.add({
        id: skill.id,
        name: skill.name,
        ...(skill.description ? { description: skill.description } : {}),
        path: skill.path,
        content: skill.content,
      } as never)
    }
  })

  // ── commands：execute 式注册（模板文本作为 user prompt 投递，保留 delivery） ──
  await ctx.command.transform((editor) => {
    for (const cmd of commands) {
      editor.add({
        name: cmd.name,
        ...(cmd.description ? { description: cmd.description } : {}),
        execute: async ({ sessionID, prompt, delivery }) => {
          if (cmd.agent) {
            await ctx.session.switchAgent({ sessionID, agent: cmd.agent }).catch((err) => {
              console.warn(`[cabbage] command /${cmd.name}: switchAgent failed:`, (err as Error | null)?.message ?? err)
            })
          }
          if (cmd.model || cmd.subtask) {
            console.warn(`[cabbage] command /${cmd.name}: model/subtask frontmatter is not supported on OpenCode V2; ignoring`)
          }
          const args = (prompt?.text ?? "").trim()
          const text = args ? `${cmd.template}\n\n${args}` : cmd.template
          await ctx.session.prompt({ sessionID, text, delivery })
        },
      })
    }
  })

  // ── agents：缺失则新增（保留用户已存在的同名 agent），并为所有 agent 装配 goal 权限规则 ──
  // 依赖 editor.update 对缺失 id 的 upsert 语义（新增 agent）：该语义未见于 V2 文档，
  // 是 v2.0.16 / v2.0.26 / v2.0.28 的实测行为，单测按同语义锁定 mock。若宿主改为忽略缺失 id，
  // 下方注册校验会告警（可观测）。决策与替代方案见 ADR 0010。
  await ctx.agent.transform((editor) => {
    for (const payload of agentPayloads) {
      if (editor.get(payload.key)) continue
      editor.update(payload.key, (agent) => {
        Object.assign(agent, payload.fields)
      })
    }
    const ids = new Set<string>([
      ...editor.list().map((a) => String(a.id)),
      ...agentPayloads.map((p) => p.key),
    ])
    // 工具门控双层策略的规则层：按 action 指定允许名单，其余 agent 显式 deny（后匹配优先）
    const toolAccess: Array<{ action: string; allowed: Set<string> }> = [
      { action: "goal", allowed: GOAL_ALLOWED_AGENTS },
      { action: "cabbage", allowed: new Set(["dev-lifecycle"]) },
    ]
    for (const id of ids) {
      editor.update(id, (agent) => {
        const permissions = Array.isArray(agent.permissions) ? agent.permissions : []
        let changed = false
        for (const { action, allowed } of toolAccess) {
          if (permissions.some((rule) => rule?.action === action)) continue
          permissions.push({ action, resource: "*", effect: allowed.has(id) ? "allow" : "deny" })
          changed = true
        }
        if (changed) agent.permissions = permissions
      })
    }
  })

  // 注册校验：自有 agent 必须全部出现在宿主注册表中（兜住 upsert 语义变化的宿主升级）
  try {
    const registered = await ctx.agent.list()
    const registeredIDs = new Set((registered?.data ?? []).map((agent) => String(agent.id)))
    const missing = agentPayloads.map((payload) => payload.key).filter((key) => !registeredIDs.has(key))
    if (missing.length > 0) {
      console.warn(
        `[cabbage] agent registration incomplete (missing: ${missing.join(", ")}); ` +
        "the host may have changed the undocumented update-upsert semantics (see ADR 0010)",
      )
    }
  } catch (err) {
    console.warn("[cabbage] agent registration verification failed:", (err as Error | null)?.message ?? err)
  }

  // ── goal 工具与内置 cabbage 引擎：JSON Schema 输入 + permission gating + 工具内授权自检 ──
  await ctx.tool.transform((editor) => {
    editor.add(buildGoalTool(store, projectDir) as never)
    editor.add(buildCabbageTool(cabbage, projectDir) as never)
  })

  // ── shell 环境：非交互 git、禁用凭据提示（V2 的 shell hook 为全局作用域） ──
  await ctx.shell.hook("create.before", (event) => {
    Object.assign(event.env, createAgentShellEnv())
  })

  // ── 系统上下文注入：goal 会话注入 bootstrap；goal/子 agent 注入 Project Context 块 ──
  await ctx.session.hook("context", async (event) => {
    let hasGoal = false
    let isSubAgent = false
    try {
      const { goal, session } = await store.read(event.sessionID)
      hasGoal = goal?.status === "active"
      isSubAgent = !!session?.parentID
    } catch {
      return
    }
    const contextBlock = await getContextBlock(projectDir)
    const injection = buildFirstUserInjection({
      hasGoal,
      isSubAgent,
      contextBlock,
      bootstrap: getBootstrapContent(),
    })
    if (!injection) return
    // 幂等：每个模型请求重建 system 数组时，已含标记则跳过（防重复膨胀）
    const alreadyInjected = event.system.some((part) =>
      typeof part.text === "string" && (part.text.includes(BOOTSTRAP_MARKER) || part.text.includes(CONTEXT_MARKER)))
    if (alreadyInjected) return
    event.system.push({ type: "text", text: injection })
  })

  // ── 事件订阅：单一流驱动子会话跟踪与自动续接 ──
  const controller = new AbortController()
  void (async () => {
    try {
      for await (const evt of ctx.event.subscribe({ signal: controller.signal })) {
        await dispatchEvent(ctx, store, tracker, projectDir, evt as V2EventLike).catch((err) => {
          console.error("[cabbage] event dispatch failed:", err)
        })
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        console.error("[cabbage] event stream ended:", err)
      }
    }
  })()

  // ── 启动恢复：扫描索引，续接插件重启前处于 active 的 goal ──
  void (async () => {
    try {
      await autoResume(ctx, store, projectDir)
    } catch (err) {
      console.error("[cabbage] auto-resume failed:", err)
    }
  })()

  // 中断标记定期清理（防长生命周期进程内存泄漏）
  const abortedCleanupTimer = setInterval(() => {
    clearAllAborted()
  }, ABORTED_SESSION_CLEANUP_INTERVAL)

  return () => {
    controller.abort()
    clearInterval(abortedCleanupTimer)
  }
}

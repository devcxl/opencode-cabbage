import type { Plugin } from "@opencode/plugin"
import path from "node:path"
import { readFileSync } from "node:fs"

import { initPrompts } from "./prompts.js"
import { initBootstrap, getBootstrapContent } from "./bootstrap.js"
import { loadCommands } from "./commands.js"
import { setupSkillsDir, loadSkillEntries } from "./skills.js"
import { buildAgentPayloads } from "./agents.js"
import { createAgentShellEnv } from "./shell.js"
import { buildCabbageTool, CABBAGE_ALLOWED_AGENTS } from "./cabbage-tool.js"
import { createBuiltinGoalReader, handleExperimentalIdle } from "./builtin-goal.js"
import { getContextBlock, CONTEXT_MARKER } from "../kernel/context.js"
import type { ContextBlock } from "../kernel/context.js"
import { readProjectProfile } from "../kernel/profile.js"

type Context = Plugin.Context

/** bootstrap 注入标记（重复注入检测用） */
const BOOTSTRAP_MARKER = "EXTREMELY_IMPORTANT"

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
 * - Primary（内置 `/goal` 激活或处于 `@dev-lifecycle` 编排器）→ bootstrap + Project Context 块
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

export async function setupCabbage(ctx: Context, packageRoot: string): Promise<() => void> {
  const sourceSkillsDir = path.join(packageRoot, "assets", "skills")
  const commandsDir = path.join(packageRoot, "assets", "commands")
  const agentsDir = path.join(packageRoot, "assets", "agents")
  const projectDir = ctx.location.directory

  const pluginVersion = readPluginVersion(packageRoot)
  const skillsDir = await setupSkillsDir(sourceSkillsDir, pluginVersion)

  // 预读磁盘内容：transform 回调是同步的，所有 IO 必须先完成
  const skillEntries = await loadSkillEntries(skillsDir)
  const commands = loadCommands(commandsDir)
  const profile = await readProjectProfile(projectDir)
  const testCommand = profile.testCommand ?? ""
  const agentPayloads = buildAgentPayloads(agentsDir, testCommand)

  initPrompts(packageRoot, projectDir)
  await initBootstrap()

  const goalReader = createBuiltinGoalReader(ctx)

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

  // ── commands：/flow-* 命令注册（避让 OpenCode v2.3 内置 /review、/goal、/init） ──
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
          const args = (prompt?.text ?? "").trim()
          const text = args ? `${cmd.template}\n\n${args}` : cmd.template
          await ctx.session.prompt({ sessionID, text, delivery })
        },
      })
    }
  })

  // ── agents：缺失则新增（保留用户已存在的同名 agent），并装配 cabbage 工具权限规则 ──
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
    for (const id of ids) {
      editor.update(id, (agent) => {
        const permissions = Array.isArray(agent.permissions) ? agent.permissions : []
        if (permissions.some((rule) => rule?.action === "cabbage")) return
        permissions.push({
          action: "cabbage",
          resource: "*",
          effect: CABBAGE_ALLOWED_AGENTS.has(id) ? "allow" : "deny",
        })
        agent.permissions = permissions
      })
    }
  })

  // 注册校验：自有 agent 必须全部出现在宿主注册表中
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

  // ── 纯 TS cabbage 变更记录引擎工具 ──
  await ctx.tool.transform((editor) => {
    editor.add(buildCabbageTool(projectDir) as never)
  })

  // ── shell 环境：非交互 git、禁用凭据提示 ──
  await ctx.shell.hook("create.before", (event) => {
    Object.assign(event.env, createAgentShellEnv())
  })

  // ── 系统上下文注入：内置 /goal 激活或 @dev-lifecycle 注入 bootstrap + Project Context；子 agent 注入 Project Context ──
  await ctx.session.hook("context", async (event) => {
    let isGoalOrOrchestrator = event.agent === "dev-lifecycle"
    let isSubAgent = false
    try {
      const session = await ctx.session.get({ sessionID: event.sessionID })
      isSubAgent = !!session?.parentID
      if (!isGoalOrOrchestrator && !isSubAgent) {
        isGoalOrOrchestrator = session?.agent === "dev-lifecycle" || await goalReader.isGoalActive(event.sessionID)
      }
    } catch {
      return
    }
    const contextBlock = await getContextBlock(projectDir)
    const injection = buildFirstUserInjection({
      hasGoal: isGoalOrOrchestrator && !isSubAgent,
      isSubAgent,
      contextBlock,
      bootstrap: getBootstrapContent(),
    })
    if (!injection) return
    const alreadyInjected = event.system.some((part) =>
      typeof part.text === "string" && (part.text.includes(BOOTSTRAP_MARKER) || part.text.includes(CONTEXT_MARKER)))
    if (alreadyInjected) return
    event.system.push({ type: "text", text: injection })
  })

  // ── 原生 experimental.idle 钩子：感知后台任务与内置 `/goal` 状态 ──
  await ctx.session.hook("experimental.idle", async (event) => {
    await handleExperimentalIdle(goalReader, event)
  })

  // ── 订阅内置 opencode.goal 状态变更事件，实时更新缓存 ──
  const controller = new AbortController()
  void goalReader.watchEvents(controller.signal)

  return () => {
    controller.abort()
  }
}

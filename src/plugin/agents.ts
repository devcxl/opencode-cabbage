import { readFileSync, readdirSync, existsSync } from "node:fs"
import path from "node:path"
import { parse as parseYaml } from "yaml"

/**
 * Agent frontmatter 的 permission 解析。
 * 值可为字符串（如 "deny"、"npm test|git push"）或嵌套规则对象
 * （OpenCode 语义：pattern → action，如 bash: { "*": "deny", "npm *": "allow" }）。
 * V2 注册时转换为规则数组（见 buildAgentRules）。
 */
export interface AgentPermission {
  [key: string]: string | Record<string, string> | undefined
}

export interface AgentEntry {
  key: string
  description?: string
  mode?: "subagent" | "primary" | "all"
  color?: string
  permission?: AgentPermission
  /** V1 tools 启停映射（write/edit/bash/read…）；false 表示禁用该工具 */
  tools?: Record<string, boolean>
  prompt: string
}

/** V2 permission 规则（@opencode/schema PermissionRule 子集） */
export interface AgentRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

/** V1 tools 名 → V2 permission action（write 工具的权限 action 实测为 "edit"） */
const TOOLS_TO_PERMISSION_ACTION: Record<string, string> = {
  write: "edit",
  edit: "edit",
  bash: "bash",
  read: "read",
  glob: "glob",
  grep: "grep",
  webfetch: "webfetch",
  websearch: "websearch",
  todowrite: "todowrite",
  task: "subagent",
}

function normalizeEffect(value: string): AgentRule["effect"] {
  return value === "allow" ? "allow" : value === "deny" ? "deny" : "ask"
}

/**
 * 渲染规则中的 `<profile-test-command>` 占位符为 Profile 测试命令首 token。
 * Profile 未配置（token 为空）时返回 null 表示删除该规则（避免渲染成 "*" 覆盖兜底 deny）。
 */
function renderPlaceholder(pattern: string, testCommandToken: string): string | null {
  if (!pattern.includes("<profile-test-command>")) return pattern
  if (testCommandToken === "") return null
  return pattern.replaceAll("<profile-test-command>", testCommandToken)
}

/**
 * 将 agent 的 V1 风格 permission/tools 转换为 V2 规则数组。
 * 顺序保持声明序（V2 最后匹配优先）；tools 禁用规则置于末尾（V1 语义：工具整体禁用不可被白名单恢复）。
 */
export function buildAgentRules(entry: AgentEntry, testCommandToken: string): AgentRule[] {
  const rules: AgentRule[] = []
  for (const [action, value] of Object.entries(entry.permission ?? {})) {
    if (typeof value === "string") {
      rules.push({ action, resource: "*", effect: normalizeEffect(value) })
      continue
    }
    if (!value) continue
    for (const [pattern, raw] of Object.entries(value)) {
      const rendered = renderPlaceholder(pattern, testCommandToken)
      if (rendered === null) continue
      rules.push({ action, resource: rendered, effect: normalizeEffect(raw) })
    }
  }
  const deniedActions = new Set<string>()
  for (const [tool, enabled] of Object.entries(entry.tools ?? {})) {
    if (enabled !== false) continue
    const action = TOOLS_TO_PERMISSION_ACTION[tool] ?? tool
    if (deniedActions.has(action)) continue
    deniedActions.add(action)
    rules.push({ action, resource: "*", effect: "deny" })
  }
  return rules
}

/** V2 agent 注册载荷：缺失时新增，已存在则保留用户版本（V1 的 skip-if-exists 语义） */
export interface AgentPayload {
  key: string
  fields: Record<string, unknown>
}

export function buildAgentPayloads(agentsDir: string, testCommandToken: string): AgentPayload[] {
  return loadAgents(agentsDir).map((entry) => ({
    key: entry.key,
    fields: {
      name: entry.key,
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.mode ? { mode: entry.mode } : {}),
      ...(entry.color ? { color: entry.color } : {}),
      system: entry.prompt,
      permissions: buildAgentRules(entry, testCommandToken),
    },
  }))
}

function parseAgentFile(filePath: string): AgentEntry | null {
  const content = readFileSync(filePath, "utf8")
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return null

  const frontmatterStr = match[1]
  const body = match[2].trim()

  let parsed: Record<string, unknown>
  try {
    parsed = parseYaml(frontmatterStr) as Record<string, unknown>
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== "object") return null
  const name = String(parsed.name ?? "")
  if (!name) return null

  const permissionRaw = parsed.permission
  const permission: AgentPermission | undefined =
    permissionRaw && typeof permissionRaw === "object" && !Array.isArray(permissionRaw)
      ? Object.fromEntries(
          Object.entries(permissionRaw as Record<string, unknown>)
            .map(([key, value]) => {
              if (typeof value === "string") return [key, value]
              if (value && typeof value === "object" && !Array.isArray(value)) {
                const rules: Record<string, string> = {}
                for (const [pattern, action] of Object.entries(value as Record<string, unknown>)) {
                  if (typeof action === "string") rules[pattern] = action
                }
                return [key, rules]
              }
              return [key, undefined]
            })
            .filter(([, v]) => v !== undefined)
        )
      : undefined

  const toolsRaw = parsed.tools
  const tools = toolsRaw && typeof toolsRaw === "object" && !Array.isArray(toolsRaw)
    ? Object.fromEntries(
        Object.entries(toolsRaw as Record<string, unknown>)
          .filter(([, v]) => typeof v === "boolean")
          .map(([k, v]) => [k, v as boolean]),
      )
    : undefined

  return {
    key: name,
    description: parsed.description as string | undefined,
    mode: parsed.mode as AgentEntry["mode"],
    color: parsed.color as string | undefined,
    permission,
    tools,
    prompt: body,
  }
}

export function loadAgents(agentsDir: string): AgentEntry[] {
  const result: AgentEntry[] = []

  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const agent = parseAgentFile(path.join(agentsDir, entry.name))
        if (agent) result.push(agent)
      }
    }
  }

  const teamDir = path.join(agentsDir, "team")
  if (existsSync(teamDir)) {
    for (const entry of readdirSync(teamDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const agent = parseAgentFile(path.join(teamDir, entry.name))
        if (agent) result.push(agent)
      }
    }
  }

  return result
}

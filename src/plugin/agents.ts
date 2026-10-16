import { readFileSync, readdirSync, existsSync } from "node:fs"
import path from "node:path"
import { parse as parseYaml } from "yaml"

/** V2 permission 规则（@opencode/schema PermissionRule 子集） */
export interface AgentRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

/** Agent frontmatter 解析结果（V2 原生 `permissions: PermissionRule[]` 结构） */
export interface AgentEntry {
  key: string
  description?: string
  mode?: "subagent" | "primary" | "all"
  color?: string
  /** V2 原生权限规则数组（顺序即优先级：最后匹配优先） */
  permissions?: AgentRule[]
  prompt: string
}

const VALID_EFFECTS = new Set<string>(["allow", "deny", "ask"])

/** 规则 resource 中的 Profile 测试命令占位符（注册时按 Profile 渲染） */
const TEST_COMMAND_PLACEHOLDER = "<profile-test-command>"

/**
 * 渲染 resource 中的 `<profile-test-command>` 占位符为 Profile 测试命令的安全前缀：
 * - 含 `{testPaths}` → 取占位符前的固定前缀 + 空格（`"npm test -- {testPaths}"` → `"npm test -- "`，
 *   配合规则中的 `*` 形成 `"npm test -- *"`，只放行该前缀后的测试参数）
 * - 不含占位符 → 原样返回命令（`"pytest"`，配合 `*` 形成 `"pytest*"`）
 * - 命令为空、或 `{testPaths}` 前无可用的固定前缀 → 返回 null，调用方丢弃该规则
 *   （避免退化为 `*` 放行；杜绝 `"npm*"` 式首 token 权限放大）
 */
function renderPlaceholder(pattern: string, testCommand: string): string | null {
  if (!pattern.includes(TEST_COMMAND_PLACEHOLDER)) return pattern
  const command = testCommand.trim()
  if (command === "") return null
  const testPathsIndex = command.indexOf("{testPaths}")
  const prefix = testPathsIndex >= 0 ? `${command.slice(0, testPathsIndex).trimEnd()} ` : command
  if (prefix.trim() === "") return null
  return pattern.replaceAll(TEST_COMMAND_PLACEHOLDER, prefix)
}

/** 渲染规则数组中的占位符；渲染为 null 的规则被丢弃 */
function renderRules(rules: AgentRule[], testCommand: string): AgentRule[] {
  const rendered: AgentRule[] = []
  for (const rule of rules) {
    const resource = renderPlaceholder(rule.resource, testCommand)
    if (resource === null) continue
    rendered.push(rule.resource === resource ? rule : { ...rule, resource })
  }
  return rendered
}

/** V2 agent 注册载荷：缺失时新增，已存在则保留用户版本（V1 的 skip-if-exists 语义） */
export interface AgentPayload {
  key: string
  fields: Record<string, unknown>
}

export function buildAgentPayloads(agentsDir: string, testCommand: string): AgentPayload[] {
  return loadAgents(agentsDir).map((entry) => ({
    key: entry.key,
    fields: {
      name: entry.key,
      ...(entry.description ? { description: entry.description } : {}),
      ...(entry.mode ? { mode: entry.mode } : {}),
      ...(entry.color ? { color: entry.color } : {}),
      system: entry.prompt,
      permissions: renderRules(entry.permissions ?? [], testCommand),
    },
  }))
}

/** 解析 V2 原生 permissions 数组；非数组返回 undefined，结构不完整的规则被跳过 */
function parsePermissions(raw: unknown): AgentRule[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const rules: AgentRule[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const { action, resource, effect } = item as Record<string, unknown>
    if (typeof action !== "string" || typeof resource !== "string") continue
    if (typeof effect !== "string" || !VALID_EFFECTS.has(effect)) continue
    rules.push({ action, resource, effect: effect as AgentRule["effect"] })
  }
  return rules
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

  return {
    key: name,
    description: parsed.description as string | undefined,
    mode: parsed.mode as AgentEntry["mode"],
    color: parsed.color as string | undefined,
    permissions: parsePermissions(parsed.permissions),
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

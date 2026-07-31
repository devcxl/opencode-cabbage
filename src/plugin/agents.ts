import { readFileSync, readdirSync, existsSync } from "node:fs"
import path from "node:path"
import { parse as parseYaml } from "yaml"

/**
 * Agent frontmatter 的 permission 解析。
 * 值可为字符串（如 "deny"、"npm test|git push"）或嵌套规则对象
 * （OpenCode 语义：pattern → action，如 bash: { "*": "deny", "npm *": "allow" }）。
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
  prompt: string
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

  return {
    key: name,
    description: parsed.description as string | undefined,
    mode: parsed.mode as AgentEntry["mode"],
    color: parsed.color as string | undefined,
    permission,
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

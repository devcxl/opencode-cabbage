import { readFileSync, readdirSync, existsSync } from "node:fs"
import path from "node:path"
import { parse as parseYaml } from "yaml"

export interface AgentTools {
  read?: boolean
  bash?: boolean
  write?: boolean
  edit?: boolean
}

export interface AgentCapabilities {
  create_pr: boolean
  merge_pr: boolean
  modify_files: boolean
  run_tests: boolean
  push_branch: boolean
  approve_review: boolean
  complete_goal: boolean
}

export interface AgentEntry {
  key: string
  description?: string
  mode?: "subagent" | "primary" | "all"
  color?: string
  tools?: AgentTools
  capabilities?: AgentCapabilities
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

  const toolsRaw = parsed.tools
  const tools: AgentTools | undefined =
    toolsRaw && typeof toolsRaw === "object" && !Array.isArray(toolsRaw)
      ? {
          read: Boolean((toolsRaw as Record<string, unknown>).read),
          bash: Boolean((toolsRaw as Record<string, unknown>).bash),
          write: Boolean((toolsRaw as Record<string, unknown>).write),
          edit: Boolean((toolsRaw as Record<string, unknown>).edit),
        }
      : undefined

  const capabilitiesRaw = parsed.capabilities
  const capabilities: AgentCapabilities | undefined =
    capabilitiesRaw && typeof capabilitiesRaw === "object" && !Array.isArray(capabilitiesRaw)
      ? {
          create_pr: Boolean((capabilitiesRaw as Record<string, unknown>).create_pr),
          merge_pr: Boolean((capabilitiesRaw as Record<string, unknown>).merge_pr),
          modify_files: Boolean((capabilitiesRaw as Record<string, unknown>).modify_files),
          run_tests: Boolean((capabilitiesRaw as Record<string, unknown>).run_tests),
          push_branch: Boolean((capabilitiesRaw as Record<string, unknown>).push_branch),
          approve_review: Boolean((capabilitiesRaw as Record<string, unknown>).approve_review),
          complete_goal: Boolean((capabilitiesRaw as Record<string, unknown>).complete_goal),
        }
      : undefined

  return {
    key: name,
    description: parsed.description as string | undefined,
    mode: parsed.mode as AgentEntry["mode"],
    color: parsed.color as string | undefined,
    tools,
    capabilities,
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

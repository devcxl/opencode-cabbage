import { readFileSync, readdirSync, existsSync } from "node:fs"
import path from "node:path"

interface AgentMeta {
  name: string
  description?: string
  mode?: "subagent" | "primary" | "all"
  color?: string
}

export interface AgentEntry {
  key: string
  description?: string
  mode?: "subagent" | "primary" | "all"
  color?: string
  prompt: string
}

function parseAgentFile(filePath: string): AgentEntry | null {
  const content = readFileSync(filePath, "utf8")
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return null

  const frontmatterStr = match[1]
  const body = match[2].trim()

  const meta: Record<string, string> = {}
  for (const line of frontmatterStr.split("\n")) {
    const colonIdx = line.indexOf(":")
    if (colonIdx > 0) {
      const key = line.slice(0, colonIdx).trim()
      const value = line.slice(colonIdx + 1).trim().replace(/^["']|["']$/g, "")
      meta[key] = value
    }
  }

  const name = meta.name
  if (!name) return null

  return {
    key: name,
    description: meta.description,
    mode: meta.mode as AgentMeta["mode"],
    color: meta.color,
    prompt: body,
  }
}

export function loadAgents(agentsDir: string): AgentEntry[] {
  const result: AgentEntry[] = []

  // Load primary agents from agentsDir root
  if (existsSync(agentsDir)) {
    for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        const agent = parseAgentFile(path.join(agentsDir, entry.name))
        if (agent) result.push(agent)
      }
    }
  }

  // Load team/subagents from agentsDir/team/
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

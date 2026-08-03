/**
 * Cabbage Session Start Hook — loads project context and dev-lifecycle agent prompt.
 * Runs on Codex SessionStart lifecycle event.
 *
 * This hook reads the dev-lifecycle agent prompt and injects it as session context.
 */
import { readFileSync, existsSync } from "node:fs"
import { join, dirname } from "node:path"

const PLUGIN_ROOT = process.env.PLUGIN_ROOT || process.cwd()
const PROJECT_DIR = process.cwd()

function getDevLifecyclePrompt(): string {
  const agentPath = join(PLUGIN_ROOT, "assets", "agents", "dev-lifecycle.md")
  if (!existsSync(agentPath)) return ""
  const content = readFileSync(agentPath, "utf8")
  // Strip frontmatter
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/)
  return match ? match[1].trim() : content.trim()
}

function getProjectContext(): string {
  const agentsMd = join(PROJECT_DIR, "AGENTS.md")
  if (existsSync(agentsMd)) {
    const content = readFileSync(agentsMd, "utf8")
    const profileMatch = content.match(/## Project Profile[\s\S]*?(?=##|$)/)
    if (profileMatch) return profileMatch[0].trim()
  }
  return ""
}

function main() {
  const prompt = getDevLifecyclePrompt()
  const context = getProjectContext()

  const parts: string[] = []
  if (prompt) parts.push(prompt)
  if (context) parts.push(`\n## Project Context\n\n${context}`)

  if (parts.length > 0) {
    console.log(parts.join("\n\n"))
  }
}

main()
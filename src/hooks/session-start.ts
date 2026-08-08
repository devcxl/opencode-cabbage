/**
 * Cabbage Session Start Hook — loads plugin overview and project context.
 * Runs on Codex SessionStart lifecycle event (matcher: startup|resume).
 * Compiled to dist/hooks/session-start.js by tsc.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

// PLUGIN_ROOT is set by Codex hooks runtime
const PROJECT_DIR = process.cwd()
const MAX_OUTPUT_LENGTH = 12000

function getHeader(): string {
  return `## Cabbage Development Plugin

This plugin provides a full development lifecycle orchestration system.
Load skills by name: @agent-dev-lifecycle, @agent-architect, @agent-developer, @agent-reviewer, @agent-goal-verify, @agent-researcher

### Available Flow Skills
- \`@flow-setup\` — 初始化项目开发环境
- \`@flow-requirements\` — 需求分析产出 PRD
- \`@flow-design\` — 技术方案与 ADR
- \`@flow-tasks\` — DAG 任务拆解
- \`@flow-research\` — 调研/事实核查
- \`@flow-code\` — 编码实现（TDD）
- \`@flow-tdd\` — TDD 协议参考
- \`@flow-review\` — 代码审查
- \`@flow-release\` — 发布流程

### Available Agent Skills
- \`@agent-dev-lifecycle\` — 全流程编排器（主 agent，场景分诊）
- \`@agent-architect\` — 架构设计
- \`@agent-developer\` — 编码实现
- \`@agent-reviewer\` — 代码审查
- \`@agent-goal-verify\` — 目标验证
- \`@agent-researcher\` — 独立调研
`
}

function readProjectProfile(): string {
  // Try root AGENTS.md from project directory
  const agentsMd = join(PROJECT_DIR, "AGENTS.md")
  if (!existsSync(agentsMd)) return ""

  let content: string
  try {
    content = readFileSync(agentsMd, "utf8")
  } catch {
    return ""
  }

  // Match only the exact "## Project Profile" heading line (not "## Project Profile Notes"),
  // and stop at the next "## " heading or end of file.
  const lines = content.split("\n")
  const start = lines.findIndex((line) => line.trim() === "## Project Profile")
  if (start === -1) return ""

  const end = lines.findIndex((line, i) => i > start && /^##\s/.test(line.trim()))
  const slice = end === -1 ? lines.slice(start) : lines.slice(start, end)
  return slice.join("\n").trim()
}

function main() {
  const header = getHeader()
  const profile = readProjectProfile()

  const parts = [header]
  if (profile) parts.push(`## Project Context\n\n${profile}`)

  let output = parts.join("\n\n")
  if (output.length > MAX_OUTPUT_LENGTH) {
    output = `${output.slice(0, MAX_OUTPUT_LENGTH)}\n\n[context truncated — output exceeds ${MAX_OUTPUT_LENGTH} chars]`
  }

  console.log(output)
}

main()

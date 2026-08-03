/**
 * Cabbage Session Start Hook — loads dev-lifecycle agent prompt and project context.
 * Runs on Codex SessionStart lifecycle event.
 */
import { readFileSync, existsSync } from "node:fs"
import { join } from "node:path"

const PLUGIN_ROOT = process.env.PLUGIN_ROOT || process.cwd()
const PROJECT_DIR = process.cwd()

function getHeader(): string {
  return `## Cabbage Development Plugin

This plugin provides a full development lifecycle orchestration system.
Load skills by name: @agent-dev-lifecycle, @agent-architect, @agent-developer, @agent-reviewer, @agent-goal-verify

### Available Flow Skills
- \`@flow-setup\` — 初始化项目开发环境
- \`@flow-requirements\` — 需求分析产出 PRD
- \`@flow-design\` — 技术方案与 ADR
- \`@flow-tasks\` — DAG 任务拆解
- \`@flow-code\` — 编码实现（TDD）
- \`@flow-tdd\` — TDD 协议参考
- \`@flow-review\` — 代码审查
- \`@flow-release\` — 发布流程

### Available Agent Skills
- \`@agent-dev-lifecycle\` — 全流程编排器（主 agent）
- \`@agent-architect\` — 架构设计
- \`@agent-developer\` — 编码实现
- \`@agent-reviewer\` — 代码审查
- \`@agent-goal-verify\` — 目标验证
`
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
  const header = getHeader()
  const context = getProjectContext()

  const parts = [header]
  if (context) parts.push(`## Project Context\n\n${context}`)

  console.log(parts.join("\n\n"))
}

main()
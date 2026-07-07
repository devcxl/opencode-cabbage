import type { Plugin } from "@opencode-ai/plugin"
import path from "node:path"

import { ensureDocsStructure } from "../util/paths.js"
import { initPrompts } from "./prompts.js"
import { initBootstrap, getBootstrapContent } from "./bootstrap.js"
import { loadCommands } from "./commands.js"
import { setupSkillsDir } from "./skills.js"
import { loadAgents } from "./agents.js"

export function createOpencodeCabbage(packageRoot: string): Plugin {
  return async (ctx, _options) => {
    const sourceSkillsDir = path.join(packageRoot, "assets", "skills")
    const contextDir = path.join(packageRoot, "assets", "context")
    const commandsDir = path.join(packageRoot, "assets", "commands")
    const skillsDir = await setupSkillsDir(sourceSkillsDir, contextDir)

    const projectDir = ctx.worktree || ctx.directory

    await initPrompts(packageRoot, projectDir)
    await initBootstrap()

    return {
      config: async (rawConfig) => {
        const config = rawConfig as Record<string, any>

        config.skills = config.skills || {}
        config.skills.paths = config.skills.paths || []
        if (!config.skills.paths.includes(skillsDir)) {
          config.skills.paths.push(skillsDir)
        }

        config.command = config.command || {}
        for (const cmd of loadCommands(commandsDir, skillsDir)) {
          if (config.command[cmd.name]) continue
          config.command[cmd.name] = {
            template: cmd.template,
            description: cmd.description,
            agent: cmd.agent,
            model: cmd.model,
            subtask: cmd.subtask,
          }
        }

        config.agent = config.agent || {}
        const agentsDir = path.join(packageRoot, "assets", "agents")
        for (const agent of loadAgents(agentsDir)) {
          if (config.agent[agent.key]) continue
          config.agent[agent.key] = {
            description: agent.description,
            mode: agent.mode,
            color: agent.color,
            prompt: agent.prompt,
            tools: { read: true, bash: true, write: true, edit: true },
          }
        }
      },

      "experimental.chat.messages.transform": async (_input, output) => {
        const bootstrap = getBootstrapContent()
        if (!output.messages.length) return

        const firstUser = output.messages.find(m => m.info.role === "user")
        if (!firstUser || !firstUser.parts.length) return

        if (firstUser.parts.some(p => p.type === "text" && p.text.includes("EXTREMELY_IMPORTANT"))) return

        firstUser.parts.unshift({ type: "text", text: bootstrap } as typeof firstUser.parts[number])
      },
    }
  }
}

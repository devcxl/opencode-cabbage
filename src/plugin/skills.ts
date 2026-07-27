import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

/**
 * skills 固定安装路径，确保跨会话稳定。
 * 用 env CABBAGE_SKILLS_DIR 可覆盖，方便测试。
 */
function resolveSkillsPath(): string {
  if (process.env.CABBAGE_SKILLS_DIR) {
    return process.env.CABBAGE_SKILLS_DIR
  }
  return path.join(homedir(), ".config", "opencode", "cabbage", "skills")
}

export async function setupSkillsDir(sourceSkillsDir: string, contextDir?: string, promptsDir?: string): Promise<string> {
  const destDir = resolveSkillsPath()

  // 清理旧内容，确保与插件版本一致
  await rm(destDir, { recursive: true, force: true })
  await mkdir(destDir, { recursive: true })

  await cp(sourceSkillsDir, destDir, { recursive: true })

  if (contextDir) {
    try {
      await cp(contextDir, path.join(destDir, "_context"), { recursive: true })
    } catch {}
  }

  if (promptsDir) {
    try {
      await cp(promptsDir, path.join(destDir, "_prompts"), { recursive: true })
    } catch {}
  }

  async function processDir(dir: string) {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await processDir(fullPath)
        continue
      }
      if (entry.name === "SKILL.md") {
        let content = await readFile(fullPath, "utf8")
        content = content.replaceAll(".opencode/skills/", `${destDir}/`)
        await writeFile(fullPath, content, "utf8")
      }
    }
  }

  await processDir(destDir)

  return destDir
}

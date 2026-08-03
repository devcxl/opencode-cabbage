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

export async function setupSkillsDir(sourceSkillsDir: string, promptsDir?: string): Promise<string> {
  const destDir = resolveSkillsPath()

  // 已安装且完整（目录列表与源一致）→ 跳过全量重建；否则重建（防多实例并发踩踏与无谓 IO）
  const sourceDirs = (await readdir(sourceSkillsDir, { withFileTypes: true }))
    .filter(e => e.isDirectory()).map(e => e.name)
  let installed = false
  try {
    const destDirs = (await readdir(destDir, { withFileTypes: true }))
      .filter(e => e.isDirectory()).map(e => e.name)
    installed = sourceDirs.every(d => destDirs.includes(d)) && destDirs.length === sourceDirs.length
  } catch {
    installed = false
  }

  if (!installed) {
    await rm(destDir, { recursive: true, force: true })
    await mkdir(destDir, { recursive: true })
    await cp(sourceSkillsDir, destDir, { recursive: true })
  }

  if (promptsDir) {
    const promptsDest = path.join(destDir, "_prompts")
    try {
      // 同步 _prompts：先清空再拷贝，保证源中删除的文件不残留
      await rm(promptsDest, { recursive: true, force: true })
      await cp(promptsDir, promptsDest, { recursive: true })
    } catch (err) {
      console.warn("[cabbage] failed to copy prompts dir into skills:", err)
    }
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

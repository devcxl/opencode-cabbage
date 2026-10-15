import { readdir, readFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

import { extractAndStripFrontmatter } from "./commands.js"
import { ensureInstalledDir } from "./install-dir.js"

/** V2 skill 注册条目（ctx.skill.transform add 用） */
export interface SkillEntry {
  id: string
  name: string
  description?: string
  /** skill 目录绝对路径（references 等文件按此解析） */
  path: string
  /** SKILL.md 全文（模型加载时读取） */
  content: string
}

/**
 * 读取已安装 skills 目录，产出 V2 注册条目。
 * 跳过以下划线开头的辅助目录；无 SKILL.md 的目录忽略。
 */
export async function loadSkillEntries(skillsDir: string): Promise<SkillEntry[]> {
  const entries: SkillEntry[] = []
  let dirs
  try {
    dirs = await readdir(skillsDir, { withFileTypes: true })
  } catch {
    return entries
  }
  for (const entry of dirs) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue
    const dirPath = path.join(skillsDir, entry.name)
    let content: string
    try {
      content = await readFile(path.join(dirPath, "SKILL.md"), "utf8")
    } catch {
      continue
    }
    const { frontmatter } = extractAndStripFrontmatter(content)
    entries.push({
      id: entry.name,
      name: frontmatter.name || entry.name,
      ...(frontmatter.description ? { description: frontmatter.description } : {}),
      path: dirPath,
      content,
    })
  }
  return entries
}

/**
 * skills 固定安装路径（按插件版本隔离，skills@<version>）。
 * 用 env CABBAGE_SKILLS_DIR 可覆盖，方便测试。
 */
function resolveSkillsPath(version: string): string {
  if (process.env.CABBAGE_SKILLS_DIR) {
    return path.join(process.env.CABBAGE_SKILLS_DIR, `skills@${version}`)
  }
  return path.join(homedir(), ".config", "opencode", "cabbage", `skills@${version}`)
}

/**
 * 安装目录结构完整（目录列表与源一致）→ 跳过全量重建；否则重建。
 * - 目录带插件版本号（skills@<version>）：升级插件后自动重装新版本内容，
 *   且同一机器上不同版本插件共存时互不覆盖（P2-4 多版本踩踏修复）。
 * - 重建在锁内执行（mkdir 原子锁 + 锁内二次检查），防多实例并发 rm+cp 竞态。
 */
export async function setupSkillsDir(sourceSkillsDir: string, version = "0.0.0"): Promise<string> {
  const destDir = resolveSkillsPath(version)

  const sourceDirs = (await readdir(sourceSkillsDir, { withFileTypes: true }))
    .filter(e => e.isDirectory()).map(e => e.name)
  await ensureInstalledDir({
    sourceDir: sourceSkillsDir,
    destDir,
    isComplete: async (dir) => {
      try {
        const destDirs = (await readdir(dir, { withFileTypes: true }))
          .filter(e => e.isDirectory()).map(e => e.name)
        return sourceDirs.every(d => destDirs.includes(d)) && destDirs.length === sourceDirs.length
      } catch {
        return false
      }
    },
  })

  return destDir
}

import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"

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

/** 安装锁：mkdir 原子性互斥，防多实例并发 rm+cp 踩踏（超时放弃而非死等） */
async function acquireLock(lockPath: string, timeoutMs = 10_000): Promise<() => Promise<void>> {
  await mkdir(path.dirname(lockPath), { recursive: true })
  const start = Date.now()
  for (;;) {
    try {
      await mkdir(lockPath)
      return async () => {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined)
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err
      if (Date.now() - start > timeoutMs) {
        throw new Error(`[cabbage] timed out waiting for skills install lock: ${lockPath}`)
      }
      await new Promise(r => setTimeout(r, 100))
    }
  }
}

/**
 * 安装目录结构完整（目录列表与源一致）→ 跳过全量重建；否则重建。
 * - 目录带插件版本号（skills@<version>）：升级插件后自动重装新版本内容，
 *   且同一机器上不同版本插件共存时互不覆盖（P2-4 多版本踩踏修复）。
 * - 重建在锁内执行（mkdir 原子锁 + 锁内二次检查），防多实例并发 rm+cp 竞态。
 */
export async function setupSkillsDir(sourceSkillsDir: string, promptsDir?: string, version = "0.0.0"): Promise<string> {
  const destDir = resolveSkillsPath(version)

  // 已安装且完整（目录列表与源一致）→ 跳过全量重建（防多实例并发踩踏与无谓 IO）
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
    const release = await acquireLock(`${destDir}.lock`)
    try {
      // 锁内二次检查：等待期间其它实例可能已装好，避免重复 rm+cp
      let recheck = false
      try {
        const destDirs = (await readdir(destDir, { withFileTypes: true }))
          .filter(e => e.isDirectory()).map(e => e.name)
        recheck = sourceDirs.every(d => destDirs.includes(d)) && destDirs.length === sourceDirs.length
      } catch {
        recheck = false
      }
      if (!recheck) {
        await rm(destDir, { recursive: true, force: true })
        await mkdir(destDir, { recursive: true })
        await cp(sourceSkillsDir, destDir, { recursive: true })
      }
    } finally {
      await release()
    }
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

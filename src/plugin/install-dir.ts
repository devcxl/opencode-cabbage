import { cp, mkdir, rm } from "node:fs/promises"
import path from "node:path"

/** 安装锁：mkdir 原子性互斥，防多实例并发 rm+cp 踩踏（超时放弃而非死等） */
export async function acquireLock(lockPath: string, timeoutMs = 10_000): Promise<() => Promise<void>> {
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
        throw new Error(`[cabbage] timed out waiting for install lock: ${lockPath}`)
      }
      await new Promise(r => setTimeout(r, 100))
    }
  }
}

export interface EnsureInstalledOptions {
  sourceDir: string
  destDir: string
  /** 判定目标目录已完整可用（目录缺失/不完整时返回 false） */
  isComplete: (destDir: string) => Promise<boolean>
}

/**
 * 版本化目录安装：完整则跳过；否则在锁内 rm+cp（锁内二次检查防重复重建）。
 * 调用方可依赖返回后 destDir 完整可用。排除 __pycache__/*.pyc（Python 资产复用）。
 */
export async function ensureInstalledDir({ sourceDir, destDir, isComplete }: EnsureInstalledOptions): Promise<void> {
  if (await isComplete(destDir)) return
  const release = await acquireLock(`${destDir}.lock`)
  try {
    if (await isComplete(destDir)) return
    await rm(destDir, { recursive: true, force: true })
    await mkdir(destDir, { recursive: true })
    await cp(sourceDir, destDir, {
      recursive: true,
      filter: (src) => !src.split(path.sep).includes("__pycache__") && !src.endsWith(".pyc"),
    })
  } finally {
    await release()
  }
}

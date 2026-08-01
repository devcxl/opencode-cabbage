import { exec } from "node:child_process"
import { promisify } from "node:util"

const execAsync = promisify(exec)

/**
 * 执行 gh CLI 命令。
 *
 * @param args   gh 子命令及参数
 * @param timeout  超时毫秒数（默认 30s）
 * @param env  可选的环境变量覆盖（如注入 GH_TOKEN）
 */
export function gh(args: string, timeout = 30_000, env?: Record<string, string>): Promise<{ stdout: string; stderr: string }> {
  const execEnv = env ? { ...process.env, ...env } : process.env
  return execAsync(`gh ${args}`, { timeout, env: execEnv })
}

/**
 * 从 gh pr create 的 stdout（PR URL，如 https://github.com/owner/repo/pull/123）解析 PR 编号。
 * gh pr create 不支持 --json/--jq，只能解析 URL 末尾数字；解析失败返回 null。
 */
export function parsePrUrlNumber(stdout: string): number | null {
  const trimmed = stdout.trim()
  const match = trimmed.match(/(\d+)\/?$/)
  if (!match) return null
  const n = Number(match[1])
  return Number.isInteger(n) && n > 0 ? n : null
}

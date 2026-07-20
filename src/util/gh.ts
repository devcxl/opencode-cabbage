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

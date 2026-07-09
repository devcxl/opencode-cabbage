import { exec } from "node:child_process"
import { promisify } from "node:util"

const execAsync = promisify(exec)

export function gh(args: string, timeout = 30_000): Promise<{ stdout: string; stderr: string }> {
  return execAsync(`gh ${args}`, { timeout })
}

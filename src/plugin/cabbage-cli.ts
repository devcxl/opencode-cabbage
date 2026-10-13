import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { promisify } from "node:util"

import { ensureInstalledDir } from "./install-dir.js"

const execFileAsync = promisify(execFile)

/**
 * 内置 Cabbage 引擎运行时（阶段二：先内嵌 Python，后续再评估 TS 移植）。
 *
 * 插件包内置 `vendor/cabbage/cabbage_cli`（由 scripts/sync-cabbage.mjs 固定版本生成），
 * 首次 setup 时按插件版本释放到 `~/.config/opencode/cabbage/cli@<version>/`，
 * 之后所有工具调用以 `python3 -m cabbage_cli` 执行（PYTHONPATH 指向该目录）。
 * 需要 Python 3.10+；缺失时 available=false 且给出原因，工具层返回可读错误。
 */

export interface CabbageCliRuntime {
  available: boolean
  python: string | null
  dir: string | null
  version: string | null
  reason: string | null
}

export interface CabbageRunResult {
  code: number
  stdout: string
  stderr: string
}

/** CLI 释放目录（按插件版本隔离）；env CABBAGE_CLI_DIR 可覆盖，方便测试。 */
function resolveCliDir(version: string): string {
  if (process.env.CABBAGE_CLI_DIR) {
    return path.join(process.env.CABBAGE_CLI_DIR, `cli@${version}`)
  }
  return path.join(homedir(), ".config", "opencode", "cabbage", `cli@${version}`)
}

/** 探测可用的 Python 解释器（python3 优先）；均不可用返回 null。 */
export async function detectPython(): Promise<string | null> {
  for (const candidate of ["python3", "python"]) {
    try {
      await execFileAsync(candidate, ["--version"], { timeout: 5_000 })
      return candidate
    } catch {
      // 尝试下一个候选
    }
  }
  return null
}

function errorMessage(err: unknown): string {
  return (err as Error | null)?.message ?? String(err)
}

export async function setupCabbageCli(packageRoot: string, version: string): Promise<CabbageCliRuntime> {
  const sourceDir = path.join(packageRoot, "vendor", "cabbage", "cabbage_cli")
  const python = await detectPython()
  if (!python) {
    return {
      available: false,
      python: null,
      dir: null,
      version: null,
      reason: "Python 3.10+ not found on PATH; install Python or the bundled cabbage engine cannot run",
    }
  }

  const dir = resolveCliDir(version)
  try {
    // Python 包必须位于 <dir>/cabbage_cli（PYTHONPATH=<dir> 时可按包名导入）
    await ensureInstalledDir({
      sourceDir,
      destDir: path.join(dir, "cabbage_cli"),
      isComplete: async (d) => existsSync(path.join(d, "__main__.py")),
    })
  } catch (err) {
    return { available: false, python, dir: null, version: null, reason: `failed to install the bundled cabbage CLI: ${errorMessage(err)}` }
  }

  try {
    const { stdout } = await execFileAsync(python, ["-m", "cabbage_cli", "--version"], {
      cwd: dir,
      env: { ...process.env, PYTHONPATH: dir },
      timeout: 15_000,
    })
    return { available: true, python, dir, version: stdout.trim(), reason: null }
  } catch (err) {
    return { available: false, python, dir, version: null, reason: `bundled cabbage CLI failed to run: ${errorMessage(err)}` }
  }
}

/**
 * 执行一次 cabbage 子命令。非零退出以结果返回（code/stdout/stderr），
 * 仅进程无法启动（如解释器消失）才抛错——调用方按 CLI 语义处理退出码。
 */
export async function runCabbage(cli: CabbageCliRuntime, args: string[], cwd: string): Promise<CabbageRunResult> {
  if (!cli.available || !cli.python || !cli.dir) {
    throw new Error(cli.reason ?? "cabbage CLI unavailable")
  }
  try {
    const { stdout, stderr } = await execFileAsync(cli.python, ["-m", "cabbage_cli", ...args], {
      cwd,
      env: { ...process.env, PYTHONPATH: cli.dir },
      timeout: 120_000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return { code: 0, stdout: stdout.toString(), stderr: stderr.toString() }
  } catch (err) {
    const e = err as { code?: unknown; stdout?: unknown; stderr?: unknown }
    if (typeof e.code === "number") {
      return { code: e.code, stdout: String(e.stdout ?? ""), stderr: String(e.stderr ?? "") }
    }
    throw err
  }
}

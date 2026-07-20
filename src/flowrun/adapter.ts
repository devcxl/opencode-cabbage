import { createHash } from "node:crypto"
import { spawn } from "node:child_process"
import type { TddRunnerPolicy, TddCommandEvidence, TddFailureKind, VersionedDigest } from "./types.js"

// ─── 类型 ───

export interface VitestOutput {
  exitCode: number | null
  testsCollected: number | null
  testsFailed: number | null
  stdout: string
  stderr: string
  timedOut: boolean
}

/** classifyVitestFailure 的输入 */
export interface FailureInput {
  exitCode: number | null
  testsCollected: number | null
  testsFailed: number | null
  stderr: string
  timedOut?: boolean
}

// ─── Selector 校验 ───

/** 危险字符正则 */
const DANGEROUS_SELECTOR = /[|;&$()`\x00-\x08\x0b\x0c\x0e-\x1f\r\n]/

/**
 * 校验 test selector 语法安全。
 * 拒绝 shell 元字符、命令替换、换行等。
 */
export function validateSelector(selector: string): void {
  if (!selector || !selector.trim()) {
    throw new Error("Selector must not be empty")
  }
  if (DANGEROUS_SELECTOR.test(selector)) {
    throw new Error(`Selector contains invalid or dangerous characters: ${JSON.stringify(selector)}`)
  }
}

// ─── 命令构建 ───

/**
 * 将 baseCommand 字符串解析为 argv 数组并附加 selector。
 */
export function buildVitestArgs(policy: TddRunnerPolicy, selector: string): string[] {
  const args = policy.baseCommand.trim().split(/\s+/).filter(Boolean)
  args.push(selector)
  return args
}

// ─── 进程执行 ───

/**
 * 执行 vitest 命令并捕获输出。
 */
export function executeVitest(args: string[], cwd: string, timeoutMs: number): Promise<VitestOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(args[0], args.slice(1), {
      cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    })

    let stdout = ""
    let stderr = ""
    let timedOut = false

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8")
    })

    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8")
    })

    child.on("error", (err: NodeJS.ErrnoException) => {
      // spawn 本身失败（如找不到命令）
      if (err.code === "ENOENT") {
        resolve({
          exitCode: 127,
          testsCollected: null,
          testsFailed: null,
          stdout,
          stderr: `${stderr}\nCommand not found: ${args[0]}`,
          timedOut: false,
        })
      } else {
        reject(err)
      }
    })

    child.on("close", (code: number | null, signal: string | null) => {
      timedOut = signal === "SIGTERM" || signal === "SIGKILL"
      resolve({
        exitCode: code,
        testsCollected: null, // will be enriched later
        testsFailed: null,
        stdout,
        stderr,
        timedOut,
      })
    })
  })
}

// ─── 输出解析 ───

/**
 * 从 vitest stdout 解析 JSON reporter 输出，提取测试统计数据。
 */
function parseVitestJson(stdout: string): { testsCollected: number; testsFailed: number } | null {
  // 在 stdout 中查找 vitest JSON reporter 的输出（通常是一个 JSON 对象）
  // 支持多行 JSON 输出，查找以 "numTotalTests" 为特征的 JSON
  const jsonMatch = stdout.match(/\{[\s\S]*"numTotalTests"\s*:\s*\d+[\s\S]*\}/)
  if (!jsonMatch) return null

  try {
    const json = JSON.parse(jsonMatch[0])
    const collected = typeof json.numTotalTests === "number" ? json.numTotalTests : null
    const failed = typeof json.numFailedTests === "number" ? json.numFailedTests : null
    if (collected === null || failed === null) return null
    return { testsCollected: collected, testsFailed: failed }
  } catch {
    return null
  }
}

/**
 * 从 stderr 解析 vitest 错误，提取测试计数（兜底解析）。
 */
function parseVitestSummary(stderr: string): { testsCollected: number | null; testsFailed: number | null } {
  // vitest verbose 输出: "Tests  2 passed (2) | 1 failed (1)"
  // 或 "Tests  2 passed (2)"
  const summaryMatch = stderr.match(/Tests\s+\d+\s+failed\s*\((\d+)\)/)
  const totalMatch = stderr.match(/Tests\s+\d+\s+failed[\s\S]*?\|\s*(\d+)\s+passed/)
  const passedMatch = stderr.match(/(\d+)\s+passed/)

  let testsCollected: number | null = null
  let testsFailed: number | null = null

  if (summaryMatch) {
    testsFailed = parseInt(summaryMatch[1], 10)
  } else {
    // 检查是否有 "No test files found" 或 "0 tests"
    if (stderr.includes("No test files found") || stderr.includes("no tests found")) {
      return { testsCollected: 0, testsFailed: 0 }
    }
  }

  // 尝试计算 collected = passed + failed
  const totalPassedMatch = stderr.match(/(\d+)\s+passed/)
  if (totalPassedMatch && testsFailed !== null) {
    testsCollected = parseInt(totalPassedMatch[1], 10) + testsFailed
  } else if (testsFailed === null) {
    // 可能全部通过
    const allPassedMatch = stderr.match(/Tests\s+(\d+)\s+passed/)
    if (allPassedMatch) {
      testsCollected = parseInt(allPassedMatch[1], 10)
      testsFailed = 0
    }
  }

  return { testsCollected, testsFailed }
}

// ─── 失败分类 ───

/**
 * 根据 vitest 输出分类失败类型。
 *
 * 规则：
 * - timeout → "timeout"
 * - 成功启动 + 收集测试 + assertion 失败 → "assertion"（RED）
 * - 成功启动 + 目标代码不存在 → "missing-behavior"（RED）
 * - config/transform/dep 错误 → "infrastructure"
 * - 零测试收集 → "infrastructure"
 */
export function classifyVitestFailure(input: FailureInput): TddFailureKind | null {
  // timeout
  if (input.timedOut) return "timeout"

  // 测试全部通过
  if (input.exitCode === 0 && input.testsFailed === 0) return null

  // 退出码正常但无法判断
  if (input.exitCode === 0 && input.testsFailed === null) return null

  // 失败的退出码
  if (input.exitCode !== null && input.exitCode !== 0) {
    const stderr = input.stderr

    // ── 基础设施错误 ──

    // 配置加载失败
    if (/failed to load config/i.test(stderr) ||
        /cannot find module.*vitest/i.test(stderr) ||
        /cannot find package.*vitest/i.test(stderr)) {
      return "infrastructure"
    }

    // Transform 错误
    if (/transform failed/i.test(stderr) ||
        /unexpected token/i.test(stderr)) {
      return "infrastructure"
    }

    // 依赖缺失（非实现代码的模块）
    if (/cannot find module/i.test(stderr)) {
      // 区分：如果缺失的模块匹配实现文件路径模式，则是 missing-behavior
      // 否则是 infrastructure（缺少外部依赖）
      const moduleMatch = stderr.match(/cannot find module\s+['"]([^'"]+)['"]/i)
      if (moduleMatch) {
        const missingModule = moduleMatch[1]
        // 相对路径导入 → missing-behavior（目标代码不存在）
        if (missingModule.startsWith(".") || missingModule.startsWith("/")) {
          return "missing-behavior"
        }
        // 绝对包名 → infrastructure（缺少依赖）
        return "infrastructure"
      }
      // 无法判断是什么模块，默认为 infrastructure
      return "infrastructure"
    }

    // 零测试收集
    if (input.testsCollected === 0) return "infrastructure"

    // ── assertion 失败 ──
    // 需要 testsCollected > 0 AND testsFailed > 0 才算是 assertion
    if (input.testsCollected !== null && input.testsCollected > 0 &&
        input.testsFailed !== null && input.testsFailed > 0) {
      return "assertion"
    }

    // ── 有测试收集但 testsFailed 为 0/null 且 exitCode 非零 ── 无法确定失败原因
    if (input.testsCollected !== null && input.testsCollected > 0) {
      return "unknown"
    }

    // 无法分类
    return "unknown"
  }

  // 无退出码（被 kill 等）
  if (input.exitCode === null && input.testsCollected !== null && input.testsCollected === 0) {
    return "infrastructure"
  }

  return "unknown"
}

// ─── SHA-256 辅助 ───

function sha256Hex(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex")
}

// ─── 主函数 ───

/**
 * 执行 RED check：运行 vitest focused test，返回 TddCommandEvidence。
 *
 * @param policy - TDD runner policy（含 baseCommand、timeoutMs 等）
 * @param selector - focused test selector（文件路径或 vitest flag）
 * @param cwd - 工作目录
 */
export async function executeRedCheck(
  policy: TddRunnerPolicy,
  selector: string,
  cwd: string,
): Promise<TddCommandEvidence> {
  // 1. 校验 selector
  validateSelector(selector)

  // 2. 构建命令
  const args = buildVitestArgs(policy, selector)
  const commandStr = args.join(" ")

  // 3. 执行
  const startedAt = new Date().toISOString()
  const startMs = Date.now()
  const output = await executeVitest(args, cwd, policy.timeoutMs)
  const durationMs = Date.now() - startMs
  const finishedAt = new Date().toISOString()

  // 4. 解析 vitest 输出获取测试统计数据
  const jsonStats = parseVitestJson(output.stdout)
  const summaryStats = parseVitestSummary(output.stderr)

  const testsCollected = jsonStats?.testsCollected ?? summaryStats.testsCollected ?? null
  const testsFailed = jsonStats?.testsFailed ?? summaryStats.testsFailed ?? null

  // 5. 分类失败
  const failureKind = classifyVitestFailure({
    exitCode: output.exitCode,
    testsCollected,
    testsFailed,
    stderr: output.stderr,
    timedOut: output.timedOut,
  })

  // 6. 计算 outputDigest（stdout + stderr 的 SHA-256）
  const outputDigest: VersionedDigest = {
    algorithm: "sha256-output-v1",
    value: sha256Hex(output.stdout + "\n" + output.stderr),
  }

  // 7. workspaceDigest 和 executionInputDigest 留空（由调用方/broker 填充）
  const placeholderDigest: VersionedDigest = {
    algorithm: "sha256-content-v1",
    value: "0".repeat(64),
  }

  // 8. 构建 summary
  let summary: string
  if (output.timedOut) {
    summary = `Test execution timed out after ${policy.timeoutMs}ms`
  } else if (failureKind === "assertion") {
    summary = `${testsFailed}/${testsCollected} tests failed (assertion)`
  } else if (failureKind === "missing-behavior") {
    summary = `Target code not found: ${selector}`
  } else if (failureKind === "infrastructure") {
    summary = `Infrastructure error: ${output.stderr.slice(0, 200)}`
  } else if (output.exitCode === 0) {
    summary = `${testsCollected ?? "?"} tests passed`
  } else {
    summary = `Exit code ${output.exitCode}: ${output.stderr.slice(0, 200)}`
  }

  return {
    command: commandStr,
    testSelector: selector,
    exitCode: output.exitCode,
    failureKind,
    testsCollected,
    testsFailed,
    startedAt,
    finishedAt,
    durationMs,
    changedFiles: [],
    outputDigest,
    workspaceDigest: placeholderDigest,
    executionInputDigest: placeholderDigest,
    summary,
  }
}

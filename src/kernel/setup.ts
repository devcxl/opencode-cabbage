import { exec } from "node:child_process"
import { promisify } from "node:util"
import { readdir, access, constants, readFile, writeFile, mkdir } from "node:fs/promises"
import { join, basename } from "node:path"
import { readProjectProfile, upsertProjectProfile } from "./profile.js"
import { KeyedMutex } from "./mutex.js"
import { escapeShellArg } from "../util/shell.js"
import { parsePrUrlNumber } from "../util/gh.js"

const execAsync = promisify(exec)

// ─── 可替换的 git/gh executor（用于测试，仿 records.ts） ───

export type CmdResult = { stdout: string; stderr: string }
export type CmdFn = (args: string, cwd?: string) => Promise<CmdResult>

let setupGitExecutor: CmdFn | null = null
let setupGhExecutor: CmdFn | null = null

export function setSetupGitExecutor(fn: CmdFn | null): void {
  setupGitExecutor = fn
}

export function setSetupGhExecutor(fn: CmdFn | null): void {
  setupGhExecutor = fn
}

async function runGit(args: string, cwd?: string): Promise<CmdResult> {
  if (setupGitExecutor) return setupGitExecutor(args, cwd)
  return execAsync(`git ${args}`, { cwd })
}

async function runGh(args: string): Promise<CmdResult> {
  if (setupGhExecutor) return setupGhExecutor(args)
  return execAsync(`gh ${args}`, {})
}

// ─── probe：readiness 探测 ───

export interface SetupProbeReport {
  gitAvailable: boolean
  ghAuthenticated: boolean
  hasRemote: boolean
  defaultBranch: string | null
  profileConfirmed: boolean
  tddCommandExecutable: boolean
  ciWorkflow: string | null
  releaseWorkflow: string | null
  contextMdPresent: boolean
  branchProtection: boolean
  versionRuleConfirmed: boolean
  developmentReady: boolean
  releaseReady: boolean
}

/**
 * 探测项目 setup 就绪度（PRD R10）。
 * development-ready：git/gh + Profile 确认 + TDD 命令可执行 + CI workflow + 分支保护；
 * release-ready：额外版本规则 + release workflow。
 */
export async function probe(projectDir: string): Promise<SetupProbeReport> {
  const gitAvailable = await tryRun(() => runGit("--version", projectDir))
  const ghAuthenticated = await tryRun(() => runGh("auth status"))

  let remoteUrl: string | null = null
  try {
    const { stdout } = await runGit("remote get-url origin", projectDir)
    remoteUrl = stdout.trim() || null
  } catch {
    remoteUrl = null
  }
  const hasRemote = remoteUrl !== null

  let defaultBranch: string | null = null
  try {
    const { stdout } = await runGit("symbolic-ref --short refs/remotes/origin/HEAD", projectDir)
    defaultBranch = stdout.trim() || null
  } catch {
    defaultBranch = null
  }

  const profile = await readProjectProfile(projectDir)
  const profileConfirmed = profile.testCommand !== null
  const versionRuleConfirmed =
    profile.versionBumpRule !== null && profile.versionFile !== null && profile.tagFormat !== null
  const tddCommandExecutable = await isCommandExecutable(profile.testCommand)

  const { ci, release } = await scanWorkflows(projectDir, profile.releaseWorkflowPath)
  const contextMdPresent = await fileExists(join(projectDir, "CONTEXT.md"))

  let branchProtection = false
  const ownerRepo = remoteUrl ? parseGithubRemote(remoteUrl) : null
  if (ownerRepo && defaultBranch) {
    branchProtection = await tryRun(() =>
      runGh(`api repos/${ownerRepo.owner}/${ownerRepo.repo}/branches/${defaultBranch}/protection`),
    )
  }

  const developmentReady =
    gitAvailable && ghAuthenticated && profileConfirmed && tddCommandExecutable && ci !== null && branchProtection
  const releaseReady = developmentReady && versionRuleConfirmed && release !== null

  return {
    gitAvailable,
    ghAuthenticated,
    hasRemote,
    defaultBranch,
    profileConfirmed,
    tddCommandExecutable,
    ciWorkflow: ci,
    releaseWorkflow: release,
    contextMdPresent,
    branchProtection,
    versionRuleConfirmed,
    developmentReady,
    releaseReady,
  }
}

/** 从 git remote URL 解析 GitHub owner/repo；非 GitHub 仓库返回 null */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const patterns = [
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
    /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/,
    /^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/,
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(url)
    if (match) return { owner: match[1], repo: match[2] }
  }
  return null
}

/** 扫描 .github/workflows/：文件名含 ci → CI workflow；含 release 或 Profile 指定路径 → release workflow */
async function scanWorkflows(
  projectDir: string,
  profileReleasePath: string | null,
): Promise<{ ci: string | null; release: string | null }> {
  const workflowsDir = join(projectDir, ".github", "workflows")
  let files: string[] = []
  try {
    files = (await readdir(workflowsDir)).filter(f => f.endsWith(".yml") || f.endsWith(".yaml"))
  } catch {
    files = []
  }

  let ci: string | null = null
  let release: string | null = null
  for (const file of files) {
    const lower = file.toLowerCase()
    if (ci === null && lower.includes("ci")) ci = `.github/workflows/${file}`
    if (release === null && lower.includes("release")) release = `.github/workflows/${file}`
  }

  if (profileReleasePath && (await fileExists(join(projectDir, profileReleasePath)))) {
    release = profileReleasePath
  }
  return { ci, release }
}

/** TDD 命令可执行：首个 token 存在于 PATH（相对路径则直接检查可执行） */
async function isCommandExecutable(testCommand: string | null): Promise<boolean> {
  if (!testCommand) return false
  const firstToken = testCommand.trim().split(/\s+/)[0]
  if (!firstToken) return false
  const candidates = firstToken.includes("/")
    ? [firstToken]
    : (process.env.PATH ?? "").split(":").filter(Boolean).map(dir => join(dir, firstToken))
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return true
  }
  return false
}

async function isExecutable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function tryRun(fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn()
    return true
  } catch {
    return false
  }
}

// ─── generate-workflows：缺失时生成 CI/release 草案 + Setup PR ───

const SETUP_WORKFLOWS_BRANCH = "chore/setup-workflows"

export interface GenerateWorkflowsInput {
  prTitle: string
  defaultBranch?: string | null
  testCommand?: string | null
  tagFormat?: string | null
  releaseWorkflowPath?: string | null
}

export interface GenerateWorkflowsResult {
  ok: boolean
  created: string[]
  updated: string[]
  existing: string[]
  branch: string | null
  prNumber: number | null
  error?: string
}

/** ci.yml 中的测试命令占位符（Profile 未确认时生成） */
const TEST_COMMAND_PLACEHOLDER = "<test-command>"

/**
 * 缺失时生成 CI/release workflow 草案（技术栈无关，不硬编码包管理器），
 * 创建 chore/setup-workflows 分支 + commit + push + Setup PR（人工合入）。
 * 幂等增强：
 * - 已存在的 workflow 含占位符（Profile 未确认时生成）→ 更新注入 test command（updated）
 * - 分支已存在（上次 PR 创建失败残留的 orphan 分支）→ 复用分支，不重复 checkout -b
 * - 分支已有 open PR → 复用 PR 编号，不重复创建（补建场景）
 */
export async function generateWorkflows(
  projectDir: string,
  input: GenerateWorkflowsInput,
): Promise<GenerateWorkflowsResult> {
  const profile = await readProjectProfile(projectDir)
  const testCommand = input.testCommand ?? profile.testCommand
  const tagFormat = input.tagFormat ?? profile.tagFormat
  const releaseWorkflowPath = input.releaseWorkflowPath ?? profile.releaseWorkflowPath

  let defaultBranch = input.defaultBranch ?? null
  if (!defaultBranch) {
    try {
      const { stdout } = await runGit("symbolic-ref --short refs/remotes/origin/HEAD", projectDir)
      defaultBranch = stdout.trim() || null
    } catch {
      defaultBranch = null
    }
  }

  const workflowsDir = join(projectDir, ".github", "workflows")
  await mkdir(workflowsDir, { recursive: true })

  const { ci, release } = await scanWorkflows(projectDir, releaseWorkflowPath)
  const created: string[] = []
  const updated: string[] = []
  const existing: string[] = []

  // ci.yml：缺失 → 创建；存在但含占位符（Profile 未确认时生成）→ 更新注入 test command
  if (ci === null) {
    await writeFile(join(workflowsDir, "ci.yml"), buildCiWorkflow(testCommand, defaultBranch))
    created.push(".github/workflows/ci.yml")
  } else {
    const ciPath = join(projectDir, ci)
    const ciContent = await readFile(ciPath, "utf8").catch(() => "")
    if (ciContent.includes(TEST_COMMAND_PLACEHOLDER)) {
      await writeFile(ciPath, buildCiWorkflow(testCommand, defaultBranch))
      updated.push(ci)
    } else {
      existing.push(ci)
    }
  }

  if (release === null) {
    const fileName = releaseWorkflowPath ? basename(releaseWorkflowPath) : "release.yml"
    await writeFile(join(workflowsDir, fileName), buildReleaseWorkflow(tagFormat))
    created.push(`.github/workflows/${fileName}`)
  } else {
    existing.push(release)
  }

  if (created.length === 0 && updated.length === 0) {
    return { ok: true, created, updated, existing, branch: null, prNumber: null }
  }

  try {
    const prTitle = input.prTitle || "chore: add CI/release workflow drafts"
    const prBody = `Setup generated workflow drafts for manual review:\n\n${[
      ...created.map(f => `- ${f}`),
      ...updated.map(f => `- ${f} (updated: test command injected)`),
    ].join("\n")}`

    // 幂等：分支已存在（上次失败残留的 orphan 分支）→ 复用；否则新建
    const branchExists = await tryRun(() => runGit(`rev-parse --verify refs/heads/${SETUP_WORKFLOWS_BRANCH}`, projectDir))
    if (branchExists) {
      await runGit(`checkout ${SETUP_WORKFLOWS_BRANCH}`, projectDir)
    } else {
      await runGit(`checkout -b ${SETUP_WORKFLOWS_BRANCH}`, projectDir)
    }
    await runGit("add .github/workflows", projectDir)
    await runGit(`commit -m ${shellQuote(prTitle)}`, projectDir).catch(() => {
      // 无新变更（内容一致）时 commit 失败可忽略
    })
    await runGit(`push -u origin ${SETUP_WORKFLOWS_BRANCH}`, projectDir)

    // 幂等：分支已有 open PR → 复用，不重复创建
    const { stdout: prList } = await runGh(
      `pr list --head ${SETUP_WORKFLOWS_BRANCH} --state open --json number --jq '.[0].number'`,
    )
    const existingPr = Number(prList.trim())
    if (Number.isInteger(existingPr) && existingPr > 0) {
      return { ok: true, created, updated, existing, branch: SETUP_WORKFLOWS_BRANCH, prNumber: existingPr }
    }

    const { stdout } = await runGh(
      `pr create --title ${shellQuote(prTitle)} --body ${shellQuote(prBody)} --base ${defaultBranch ?? "main"} --head ${SETUP_WORKFLOWS_BRANCH}`,
    )
    return {
      ok: true,
      created,
      updated,
      existing,
      branch: SETUP_WORKFLOWS_BRANCH,
      // gh pr create 不支持 --json：解析 stdout 中的 PR URL
      prNumber: parsePrUrlNumber(stdout),
    }
  } catch (err) {
    return { ok: false, created, updated, existing, branch: null, prNumber: null, error: String(err) }
  }
}

/** CI workflow 草案：PR check 触发，运行 Profile 的测试命令（无则占位）；纯文档 PR 不触发（paths-ignore，技术栈无关） */
export function buildCiWorkflow(testCommand: string | null, defaultBranch: string | null): string {
  const command = testCommand ?? "<test-command>"
  const branch = defaultBranch ?? "**"
  return [
    "name: CI",
    "",
    "on:",
    "  pull_request:",
    "    branches:",
    `      - '${branch}'`,
    "    paths-ignore:",
    "      - 'docs/**'",
    "      - '**/*.md'",
    "",
    "jobs:",
    "  check:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    `      - run: ${command}`,
    "",
  ].join("\n")
}

/** release workflow 草案：tag 触发，技术栈无关占位步骤 */
export function buildReleaseWorkflow(tagFormat: string | null): string {
  const tag = tagFormat ?? "v*"
  return [
    "name: Release",
    "",
    "on:",
    "  push:",
    "    tags:",
    `      - '${tag}'`,
    "",
    "jobs:",
    "  release:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@v4",
    "      - run: echo \"Define project-specific release steps here (version bump + artifact publish)\"",
    "",
  ].join("\n")
}

function shellQuote(value: string): string {
  return `'${escapeShellArg(value)}'`
}

// ─── confirm-profile：Profile 写回 AGENTS.md ───

export interface ConfirmProfileResult {
  ok: boolean
  block?: string
  code?: string
  message?: string
}

const profileMutex = new KeyedMutex()

/** overrides JSON 键 → Profile 区块行键（§9.1 顺序） */
const PROFILE_KEY_ORDER: Array<{ jsonKey: string; sectionKey: string }> = [
  { jsonKey: "testCommand", sectionKey: "test command" },
  { jsonKey: "regressionCommand", sectionKey: "regression command" },
  { jsonKey: "testFilePatterns", sectionKey: "test file patterns" },
  { jsonKey: "implementationFilePatterns", sectionKey: "implementation file patterns" },
  { jsonKey: "tddDefaultMode", sectionKey: "tdd default mode" },
  { jsonKey: "versionBumpRule", sectionKey: "version bump rule" },
  { jsonKey: "versionFile", sectionKey: "version file" },
  { jsonKey: "tagFormat", sectionKey: "tag format" },
  { jsonKey: "releaseWorkflowPath", sectionKey: "release workflow" },
  { jsonKey: "riskPatterns", sectionKey: "risk patterns" },
]

/** 由用户确认的 overrides 生成完整 `## Project Profile` 区块（未提供的键省略） */
export function buildProfileBlock(overrides: Record<string, unknown>): string {
  const lines: string[] = ["## Project Profile", ""]
  for (const { jsonKey, sectionKey } of PROFILE_KEY_ORDER) {
    const value = overrides[jsonKey]
    if (value === undefined || value === null) continue
    const formatted = Array.isArray(value) ? value.join(", ") : String(value)
    if (formatted === "") continue
    lines.push(`- ${sectionKey}: \`${formatted}\``)
  }
  return lines.join("\n")
}

/**
 * 用户确认后把 Profile 区块写回根 AGENTS.md（§9.3）。
 * 先读后写，按 key 串行（mutex）；testCommand 为必需键。
 */
export async function confirmProjectProfile(
  projectDir: string,
  overridesJson: string,
): Promise<ConfirmProfileResult> {
  let overrides: Record<string, unknown>
  try {
    overrides = JSON.parse(overridesJson) as Record<string, unknown>
  } catch {
    return { ok: false, code: "POLICY_INVALID", message: "profile_overrides is not valid JSON" }
  }
  if (typeof overrides !== "object" || overrides === null || Array.isArray(overrides)) {
    return { ok: false, code: "POLICY_INVALID", message: "profile_overrides must be a JSON object" }
  }
  if (typeof overrides.testCommand !== "string" || overrides.testCommand.trim() === "") {
    return { ok: false, code: "POLICY_INVALID", message: "testCommand is required to confirm the profile" }
  }

  const block = buildProfileBlock(overrides)
  const agentsPath = join(projectDir, "AGENTS.md")

  await profileMutex.runExclusive("agents-md", async () => {
    const markdown = await readFile(agentsPath, "utf8").catch(() => "")
    await writeFile(agentsPath, upsertProjectProfile(markdown, block))
  })

  return { ok: true, block }
}

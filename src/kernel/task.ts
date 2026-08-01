/**
 * Task 生命周期 kernel 逻辑（spec §2.3 task_control）。
 * 八 op：create-task / start-task / submit-task / submit-review /
 *       merge-task / cancel-task / destroy-worktree / status-task。
 * caller：primary 全量；developer 不允许调用 task_control（无门禁绕过面）。
 * gh/git 调用走可注入 executor（测试用）；records/worktree/merge 复用各自模块的 executor。
 */
import { exec } from "node:child_process"
import { promisify } from "node:util"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { gh as ghCli, parsePrUrlNumber } from "../util/gh.js"
import { escapeShellArg } from "../util/shell.js"
import { pathExists } from "../util/fs.js"
import { PLUGIN_ID } from "../util/paths.js"
import { validateTitle, branchFor, worktreeFor } from "./slug.js"
import { readProjectProfile, type ProjectProfile } from "./profile.js"
import { getCompletedStages } from "./flow.js"
import { worktreeStart, destroyWorktree } from "./worktree.js"
import { createTaskRecord, readFlowRecord, readTddEvidenceComment, extractEvidenceBlock } from "./records.js"
import { captureWorkspaceBaseline, type WorkspaceBaseline } from "./tdd/evidence.js"
import { evaluateTddCompliance } from "./tdd/evaluator.js"
// merge 门禁复用 kernel/review.ts 的既有实现（spec §4.1：mergeTaskPR / checkBranchProtection）
import { mergeTaskPR, checkBranchProtection } from "./review.js"
import type {
  AcceptanceCriterion,
  FinalVerificationEvidence,
  TaskRecordRef,
  TddCycleEvidence,
  TddEvidence,
  TddPolicy,
  TddRegressionEvidence,
} from "./types.js"

const execAsync = promisify(exec)

// ─── 常量 ───

/** Task Record 状态标签前缀：cabbage:task:<status> */
export const TASK_STATUS_LABEL_PREFIX = "cabbage:task:"
/** Task 状态标签取值 */
export type TaskStatus = "running" | "reviewing" | "merged" | "cancelled"
/** 默认最大并行 Task 数（PRD R7，Profile 可覆盖但内核按此判定） */
export const MAX_PARALLEL_TASKS = 5
/** 内核内置风险 pattern（spec §12 #12：migrations/auth/permissions/release workflow/密钥/公共 API），与 Profile riskPatterns 合并 */
export const BUILTIN_RISK_PATTERNS = [
  "**/migrations/**",
  "**/auth/**",
  "**/permissions/**",
  ".github/workflows/**",
  "**/.env*",
  "**/*.pem",
  "**/*.key",
  "src/**/api/**",
]

// ─── 可替换的 gh/git executor（测试用，仿 flow.ts） ───

export type CmdResult = { stdout: string; stderr: string }
export type CmdFn = (args: string) => Promise<CmdResult>

let taskGhExecutor: CmdFn | null = null
let taskGitExecutor: CmdFn | null = null

export function setTaskGhExecutor(fn: CmdFn | null): void {
  taskGhExecutor = fn
}

export function setTaskGitExecutor(fn: CmdFn | null): void {
  taskGitExecutor = fn
}

export async function taskGh(args: string, timeout?: number): Promise<CmdResult> {
  if (taskGhExecutor) return taskGhExecutor(args)
  return ghCli(args, timeout)
}

export async function taskGit(args: string): Promise<CmdResult> {
  if (taskGitExecutor) return taskGitExecutor(args)
  return execAsync(`git ${args}`)
}

/** 在指定目录内执行 git（worktree 内 push/status 等） */
async function gitIn(dir: string, args: string): Promise<CmdResult> {
  return taskGit(`-C '${escapeShellArg(dir)}' ${args}`)
}

// ─── Task Record body 模板与解析（纯函数） ───

/**
 * 新建 Task Record 的 body：acceptance criteria + 依赖 + 状态 checklist + Closes 约定。
 * criteria 渲染为 `- [ ] <id>: <description> [<verification>]`，可被 parseCriteriaFromBody 还原。
 */
export function buildTaskBody(slug: string, criteria: AcceptanceCriterion[], dependencies: number[]): string {
  const criteriaLines =
    criteria.length > 0
      ? criteria.map(c => `- [ ] ${c.id}: ${c.description} [${c.verification}]`).join("\n")
      : "- [ ] TBD"
  const depLines = dependencies.length > 0 ? dependencies.map(n => `- #${n}`).join("\n") : "- none"
  return [
    `# Task: ${slug}`,
    "",
    "## Acceptance Criteria",
    "",
    criteriaLines,
    "",
    "## Dependencies",
    "",
    depLines,
    "",
    "## Status",
    "",
    "- [ ] running",
    "- [ ] reviewing",
    "- [ ] merged",
    "",
    "<!-- PR 约定：提交 PR 时 body 必须包含 `Closes #<issueNumber>` 以在合并时关闭本 Sub Issue -->",
    "",
  ].join("\n")
}

/** TDD 跨批协议：Task Record body 内 TDD 上下文块 marker（tdd_checkpoint 工具解析；spec §2.3/§4） */
export const TASK_TDD_TAG = "<!-- cabbage-task-tdd -->"

/** 构造 TDD 上下文块 JSON（policy + criteria + worktreeDir），供 tdd_checkpoint resolveTaskContext 解析 */
export function buildTaskTddBlock(policy: TddPolicy, criteria: AcceptanceCriterion[], worktreePath: string): string {
  return `${TASK_TDD_TAG}\n${JSON.stringify({ schema: 1, policy, criteria, worktreeDir: worktreePath }, null, 2)}`
}

/** 更新 Sub Issue body（保留既有内容，替换/追加 TDD 块） */
async function updateTaskBody(issueNumber: number, newBody: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const bodyArg = escapeShellArg(newBody)
    await taskGh(`api repos/{owner}/{repo}/issues/${issueNumber} -X PATCH -f body='${bodyArg}' --silent`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

/** 解析 create-task 传入的 acceptance_criteria JSON（字符串数组 → AcceptanceCriterion[]）；非法返回 null */
export function parseAcceptanceCriteria(json: string): AcceptanceCriterion[] | null {
  try {
    const parsed = JSON.parse(json) as unknown
    if (!Array.isArray(parsed)) return null
    const criteria: AcceptanceCriterion[] = []
    for (const item of parsed) {
      if (!item || typeof item !== "object") return null
      const { id, description, verification } = item as Record<string, unknown>
      if (
        typeof id !== "string" ||
        typeof description !== "string" ||
        (verification !== "tdd" && verification !== "regression" && verification !== "manual")
      ) {
        return null
      }
      criteria.push({ id, description, verification })
    }
    return criteria
  } catch {
    return null
  }
}

/** 从 Task Record body 还原 acceptance criteria（buildTaskBody 的逆操作） */
export function parseCriteriaFromBody(body: string): AcceptanceCriterion[] {
  const criteria: AcceptanceCriterion[] = []
  for (const line of body.split("\n")) {
    const match = /^-\s+\[\s\]\s+(\S+):\s+(.+)\s+\[(\w+)\]$/.exec(line)
    if (match && (match[3] === "tdd" || match[3] === "regression" || match[3] === "manual")) {
      criteria.push({ id: match[1], description: match[2].trim(), verification: match[3] as AcceptanceCriterion["verification"] })
    }
  }
  return criteria
}

/** 从 Task Record body 的 Dependencies 区块解析依赖 Issue 号 */
export function parseDependenciesFromBody(body: string): number[] {
  const deps: number[] = []
  for (const line of body.split("\n")) {
    const match = /^-\s+#(\d+)$/.exec(line.trim())
    if (match) deps.push(Number(match[1]))
  }
  return deps
}

/** 解析 create-task 的 depends_on 参数："12, 13" 或 "#12,#13" → [12, 13]；空/非法输入返回 [] */
export function parseDependenciesArg(raw: string | undefined): number[] {
  if (!raw || raw.trim() === "") return []
  const deps: number[] = []
  for (const part of raw.split(",")) {
    const n = Number(part.trim().replace(/^#/, ""))
    if (Number.isInteger(n) && n > 0) deps.push(n)
  }
  return deps
}

// ─── TDD policy 冻结（start-task） ───

/** 从 Project Profile 冻结 TDD policy：enforcement 固定 runtime（PRD R6 行为变更强制 Runtime TDD） */
export function freezeTddPolicy(profile: ProjectProfile): TddPolicy {
  const runner = profile.testCommand
    ? {
        adapter: "vitest" as const,
        baseCommand: profile.testCommand,
        timeoutMs: 120_000,
        executionInputPatterns: ["vitest.config.*", "vitest.*.config.*", "jest.config.*", "package.json"],
      }
    : null
  return {
    mode: profile.tddDefaultMode ?? "strict",
    enforcement: "runtime",
    runner,
    testFilePatterns: profile.testFilePatterns,
    implementationFilePatterns: profile.implementationFilePatterns,
    generatedArtifactPatterns: [],
    exception: null,
    source: { manifestPath: "AGENTS.md", revisionSha: "frozen-at-start-task" },
  }
}

// ─── 风险双层判定（merge-task） ───

/** 轻量 glob 匹配（支持 **、*、?），风险 pattern 匹配专用 */
export function matchRiskPattern(filePath: string, pattern: string): boolean {
  const normalized = filePath.replace(/\\/g, "/")
  let regexStr = ""
  let i = 0
  while (i < pattern.length) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      i += 2
      if (i < pattern.length && pattern[i] === "/") {
        regexStr += "(.*/)?"
        i++
      } else {
        regexStr += ".*"
      }
    } else if (pattern[i] === "*") {
      regexStr += "[^/]*"
      i++
    } else if (pattern[i] === ".") {
      regexStr += "\\."
      i++
    } else if (pattern[i] === "?") {
      regexStr += "[^/]"
      i++
    } else {
      if ("+^$(){}[]|\\".includes(pattern[i])) regexStr += "\\" + pattern[i]
      else regexStr += pattern[i]
      i++
    }
  }
  return new RegExp(`^${regexStr}$`).test(normalized)
}

/**
 * 风险双层判定：模型初判 + 内核按实际 diff 升级，只升不降（PRD R8 / spec §12 #12）。
 * modelRisk 为 high → high；否则 diff 命中任一 risk pattern → high；否则 low。
 */
export function escalateRisk(modelRisk: "low" | "high", changedFiles: string[], riskPatterns: string[]): "low" | "high" {
  if (modelRisk === "high") return "high"
  const hit = changedFiles.some(file => riskPatterns.some(pattern => matchRiskPattern(file, pattern)))
  return hit ? "high" : "low"
}

// ─── evidence comment 解析（submit-task 门禁） ───

export interface ParsedEvidenceBlock {
  stage: string
  fields: Record<string, string>
}

/** 解析受控 evidence comment 为结构化 blocks；无 marker 或畸形返回 null */
export function parseEvidenceComment(body: string): ParsedEvidenceBlock[] | null {
  const extracted = extractEvidenceBlock(body)
  if (!extracted) return null
  const blocks: ParsedEvidenceBlock[] = []
  const sections = extracted.content.split(/^### stage: /m)
  for (const section of sections) {
    if (section.trim() === "") continue
    const lines = section.split("\n")
    const stage = lines[0].trim()
    if (stage === "") continue
    const fields: Record<string, string> = {}
    for (const line of lines.slice(1)) {
      const match = /^-\s+([a-zA-Z]+):\s*(.*)$/.exec(line.trim())
      if (match) fields[match[1]] = match[2].trim()
    }
    blocks.push({ stage, fields })
  }
  return blocks
}

/** 把受控 comment 还原为 TddEvidence（供 evaluateTddCompliance 判定）；无 marker 返回 null */
export function evidenceCommentToTddEvidence(comment: { id: number; body: string; revision: number }): TddEvidence | null {
  const blocks = parseEvidenceComment(comment.body)
  if (!blocks) return null
  const cycles: TddCycleEvidence[] = []
  let regression: TddRegressionEvidence = { status: "pending", headSha: null, treeSha: null, reworkRevision: 0, runs: [] }
  let verification: FinalVerificationEvidence = { status: "pending", headSha: null, treeSha: null, runs: [] }
  let index = 0
  for (const block of blocks) {
    const status = mapEvidenceStatus(block.fields.status)
    if (block.stage === "red" || block.stage === "green") {
      index++
      cycles.push({
        cycleId: block.fields.cycle ?? `cycle-${index}`,
        criterionId: block.fields.criterion ?? "c1",
        reworkRevision: 0,
        status: block.stage === "green" && status === "pass" ? "pass" : "failed",
        startWorkspaceDigest: { algorithm: "sha256-content-v1", value: "unknown" },
        testFiles: [],
        redTestDigest: null,
        redAttempts: [],
        greenAttempts: [],
      })
    } else if (block.stage === "final-regression") {
      regression = { status, headSha: null, treeSha: null, reworkRevision: 0, runs: [] }
    } else if (block.stage === "final-verification") {
      verification = { status, headSha: null, treeSha: null, runs: [] }
    }
  }
  const overall: TddEvidence["status"] =
    verification.status === "pass" && regression.status === "pass"
      ? "pass"
      : verification.status === "fail" || regression.status === "fail"
        ? "fail"
        : "in-progress"
  return {
    revision: comment.revision,
    reworkRevision: 0,
    status: overall,
    taskStart: { status: "pass", headSha: null, treeSha: null, startedAt: null },
    cycles,
    regression,
    verification,
    alternativeValidation: [],
    reworks: [],
    warnings: [],
    updatedAt: null,
  }
}

function mapEvidenceStatus(value?: string): "pass" | "fail" | "pending" {
  if (value === "pass") return "pass"
  if (value === "fail") return "fail"
  return "pending"
}

// ─── Task 运行时状态持久化（start-task 写 / submit/merge 读） ───

export interface TaskRuntimeState {
  slug: string
  parentIssueNumber: number
  issueNumber: number
  branch: string
  worktreePath: string
  policy: TddPolicy
  baseline: WorkspaceBaseline
  startedAt: string
}

export function taskStatePath(projectDir: string, slug: string): string {
  return join(projectDir, ".opencode", PLUGIN_ID, "task-state", `${slug}.json`)
}

export async function writeTaskState(projectDir: string, state: TaskRuntimeState): Promise<void> {
  const target = taskStatePath(projectDir, state.slug)
  const tmp = `${target}.tmp`
  await mkdir(join(projectDir, ".opencode", PLUGIN_ID, "task-state"), { recursive: true })
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8")
  await rename(tmp, target)
}

export async function readTaskState(projectDir: string, slug: string): Promise<TaskRuntimeState | null> {
  try {
    return JSON.parse(await readFile(taskStatePath(projectDir, slug), "utf8")) as TaskRuntimeState
  } catch {
    return null
  }
}

// ─── Task Record 解析（Sub Issue → issueNumber / body） ───

/** 按 title（task slug）解析 Parent 下的 Sub Issue 号 */
async function resolveTaskIssue(parentIssueNumber: number, taskId: string): Promise<number | null> {
  const { stdout } = await taskGh(
    `issue list --parent ${parentIssueNumber} --state all --json number,title --jq '[.[] | select(.title == ${JSON.stringify(taskId)}) | .number] | first'`,
  )
  const trimmed = stdout.trim()
  if (trimmed === "" || trimmed === "null") return null
  const n = Number(trimmed)
  return Number.isInteger(n) ? n : null
}

/** 读 Task Record body（供依赖解析与 criteria 解析） */
async function readTaskBody(issueNumber: number): Promise<string> {
  const { stdout } = await taskGh(`issue view ${issueNumber} --json body --jq .body`)
  return stdout
}

/** 设置 Task Record 状态标签（移除其它 cabbage:task:*，添加当前） */
export async function setTaskStatusLabel(
  issueNumber: number,
  status: TaskStatus,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const { stdout } = await taskGh(`issue view ${issueNumber} --json labels --jq '[.labels[].name] | join(" ") | tostring'`)
    const current = stdout.trim() === "" ? [] : stdout.trim().split(" ")
    const target = `${TASK_STATUS_LABEL_PREFIX}${status}`
    const stale = current.filter(l => l.startsWith(TASK_STATUS_LABEL_PREFIX) && l !== target)
    const args: string[] = []
    for (const label of stale) args.push(`--remove-label '${escapeShellArg(label)}'`)
    args.push(`--add-label '${escapeShellArg(target)}'`)
    await taskGh(`issue edit ${issueNumber} ${args.join(" ")}`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: String(err) }
  }
}

/** 读仓库默认分支 */
async function readDefaultBranch(): Promise<string> {
  const { stdout } = await taskGh(`repo view --json defaultBranchRef --jq .defaultBranchRef.name`)
  return stdout.trim()
}

// ─── create-task ───

export interface CreateTaskInput {
  projectDir: string
  parentIssueNumber: number
  title: string
  acceptanceCriteriaJson?: string
  dependencies?: number[]
}

export type CreateTaskResult =
  | { ok: true; ref: TaskRecordRef }
  | { ok: false; code: string; message: string }

/**
 * create-task（spec §2.3）：validateTitle → slug → 未完成同名冲突检查（branch/worktree 已存在）→
 * createTaskRecord（Sub Issue，body 含 acceptance criteria、依赖、Closes 约定）关联 Parent。
 */
export async function createTask(input: CreateTaskInput): Promise<CreateTaskResult> {
  const validated = validateTitle(input.title)
  if (!validated.ok) {
    return { ok: false, code: validated.code, message: validated.message }
  }

  const slug = validated.slug
  const worktreeDir = join(input.projectDir, worktreeFor(slug))
  if (await pathExists(worktreeDir)) {
    return { ok: false, code: "TASK_SLUG_CONFLICT", message: `worktree ${worktreeDir} already exists; choose a different title` }
  }
  if (await branchExists(branchFor(slug, "feat"))) {
    return { ok: false, code: "TASK_SLUG_CONFLICT", message: `branch ${branchFor(slug, "feat")} already exists; choose a different title` }
  }

  let criteria: AcceptanceCriterion[] = []
  if (input.acceptanceCriteriaJson !== undefined) {
    const parsed = parseAcceptanceCriteria(input.acceptanceCriteriaJson)
    if (parsed === null) {
      return { ok: false, code: "POLICY_INVALID", message: "acceptance_criteria must be a JSON array of {id, description, verification}" }
    }
    criteria = parsed
  }

  const body = buildTaskBody(slug, criteria, input.dependencies ?? [])
  const created = await createTaskRecord({ title: slug, body, parentIssueNumber: input.parentIssueNumber })
  if (!created.ok) {
    return { ok: false, code: "ISSUE_CREATE_FAILED", message: created.error }
  }
  return { ok: true, ref: created.ref }
}

/** 本地分支是否已存在（rev-parse 成功且有输出） */
async function branchExists(branch: string): Promise<boolean> {
  try {
    const { stdout } = await taskGit(`rev-parse --verify 'refs/heads/${escapeShellArg(branch)}'`)
    return stdout.trim() !== ""
  } catch {
    return false
  }
}

// ─── start-task ───

export type StartTaskResult =
  | {
      ok: true
      issueNumber: number
      branch: string
      worktreePath: string
      policy: TddPolicy
      baseline: WorkspaceBaseline
    }
  | { ok: false; code: string; message: string }

/**
 * start-task（spec §2.3）：前置门禁（Planning Baseline 已合并、依赖 Task 已 merged、并行数 <5）→
 * worktree-start → captureWorkspaceBaseline → freezeTddPolicy → 写 Task Record 状态。
 */
export async function startTask(
  projectDir: string,
  parentIssueNumber: number,
  taskId: string,
): Promise<StartTaskResult> {
  const issueNumber = await resolveTaskIssue(parentIssueNumber, taskId)
  if (issueNumber === null) {
    return { ok: false, code: "TASK_NOT_FOUND", message: `no sub issue with title "${taskId}" under parent #${parentIssueNumber}` }
  }

  const taskBody = await readTaskBody(issueNumber)
  const profile = await readProjectProfile(projectDir)

  // 门禁 1：Planning Baseline 已合并（design 阶段完成 = Planning PR 已合入）
  const record = await readFlowRecord(parentIssueNumber)
  if (!record.ok || !getCompletedStages(record.body).includes("design")) {
    return {
      ok: false,
      code: "PLANNING_BASELINE_NOT_MERGED",
      message: "Planning Baseline (design stage) must be merged before starting tasks",
    }
  }

  // 门禁 2：依赖 Task 已 merged（依赖 Issue 须已关闭且带 merged 标签——被取消的任务同样 CLOSED，不得放行）
  const deps = parseDependenciesFromBody(taskBody)
  for (const dep of deps) {
    const depStatus = await readIssueStateAndLabels(dep)
    if (depStatus.state !== "CLOSED" || !depStatus.labels.includes(`${TASK_STATUS_LABEL_PREFIX}merged`)) {
      return {
        ok: false,
        code: "DEPENDENCY_NOT_MERGED",
        message: `dependency task #${dep} is not merged (state: ${depStatus.state}, merged label: ${depStatus.labels.includes(`${TASK_STATUS_LABEL_PREFIX}merged`)})`,
      }
    }
  }

  // 门禁 3：并行数 < 5（running/reviewing 标签计数）
  const running = await countRunningTasks(parentIssueNumber)
  if (running >= MAX_PARALLEL_TASKS) {
    return {
      ok: false,
      code: "PARALLEL_LIMIT_REACHED",
      message: `parallel task limit (${MAX_PARALLEL_TASKS}) reached (${running} running/reviewing)`,
    }
  }

  const policy = freezeTddPolicy(profile)
  const base = await readDefaultBranch()
  const wt = await worktreeStart({ projectDir, slug: taskId, base })
  if (!wt.ok) {
    return { ok: false, code: wt.code, message: wt.message }
  }

  const baseline = await captureWorkspaceBaseline(wt.path, {
    testFilePatterns: policy.testFilePatterns,
    implementationFilePatterns: policy.implementationFilePatterns,
    generatedArtifactPatterns: policy.generatedArtifactPatterns,
  })

  // 跨批协议：将 policy/criteria/worktree 写入 Task Record body 的 cabbage-task-tdd 块（tdd_checkpoint 解析）
  const criteria = parseCriteriaFromBody(taskBody)
  const tddBlock = buildTaskTddBlock(policy, criteria, wt.path)
  const updatedBody = taskBody.includes(TASK_TDD_TAG)
    ? taskBody
    : `${taskBody}\n${tddBlock}\n`
  const bodyUpdate = await updateTaskBody(issueNumber, updatedBody)
  if (!bodyUpdate.ok) {
    // TDD 块写入失败：清理刚创建的 worktree（best effort），避免失败残留
    await gitIn(projectDir, `worktree remove '${escapeShellArg(wt.path)}'`).catch(() => null)
    return { ok: false, code: "TASK_TDD_BLOCK_WRITE_FAILED", message: bodyUpdate.error ?? "failed to write TDD block" }
  }

  await writeTaskState(projectDir, {
    slug: taskId,
    parentIssueNumber,
    issueNumber,
    branch: wt.branch,
    worktreePath: wt.path,
    policy,
    baseline,
    startedAt: new Date().toISOString(),
  })

  const label = await setTaskStatusLabel(issueNumber, "running")
  if (!label.ok) {
    return { ok: false, code: "LABEL_UPDATE_FAILED", message: label.error ?? "label update failed" }
  }

  return { ok: true, issueNumber, branch: wt.branch, worktreePath: wt.path, policy, baseline }
}

/** 读 Issue 状态与标签（依赖门禁用：CLOSED 且 merged 标签才算已合并） */
async function readIssueStateAndLabels(issueNumber: number): Promise<{ state: string; labels: string[] }> {
  const { stdout } = await taskGh(`issue view ${issueNumber} --json state,labels --jq '{state, labels: [.labels[].name]}'`)
  return JSON.parse(stdout) as { state: string; labels: string[] }
}

/** 统计 flow 下 running/reviewing 的 Task 数（并行门禁）；已关闭 Issue 不计（防取消/归档任务占名额） */
async function countRunningTasks(parentIssueNumber: number): Promise<number> {
  const { stdout } = await taskGh(
    `issue list --parent ${parentIssueNumber} --state open --json number,labels --jq '[.[] | {number, labels: [.labels[].name]}]'`,
  )
  const issues = JSON.parse(stdout) as Array<{ labels: string[] }>
  return issues.filter(i =>
    i.labels.some(l => l === `${TASK_STATUS_LABEL_PREFIX}running` || l === `${TASK_STATUS_LABEL_PREFIX}reviewing`),
  ).length
}

// ─── submit-task ───

export type SubmitTaskResult =
  | { ok: true; prNumber: number; evidenceRevision: number; warning?: string }
  | { ok: false; code: string; message: string; missing?: string[] }

/**
 * submit-task（spec §4.4）：TDD 硬门禁——evidence 不完整（无 comment、regression 未 pass、
 * compliance 未 pass）→ 拒绝创建 PR；通过后 push 分支 → gh pr create（body 引用 Task Record +
 * evidence comment 链接，含 Closes 约定）→ 标记 reviewing。
 */
export async function submitTask(
  projectDir: string,
  parentIssueNumber: number,
  taskId: string,
): Promise<SubmitTaskResult> {
  const issueNumber = await resolveTaskIssue(parentIssueNumber, taskId)
  if (issueNumber === null) {
    return { ok: false, code: "TASK_NOT_FOUND", message: `no sub issue with title "${taskId}" under parent #${parentIssueNumber}` }
  }

  const state = await readTaskState(projectDir, taskId)
  if (!state) {
    return { ok: false, code: "TASK_NOT_STARTED", message: `task "${taskId}" was not started (run start-task first)` }
  }

  const taskBody = await readTaskBody(issueNumber)
  const criteria = parseCriteriaFromBody(taskBody)

  // TDD 硬门禁（§4.4）：evidence comment 存在且状态可解析；waived（豁免）放行
  const comment = await readTddEvidenceComment(issueNumber)
  if (!comment) {
    return {
      ok: false,
      code: "TDD_EVIDENCE_INCOMPLETE",
      message: "no TDD evidence comment found on the task record",
      missing: ["evidence-comment"],
    }
  }

  // 跨批协议（与 tdd_checkpoint 一致）：先提取 evidence block 内容（不含 end marker），
  // 再解析其中 JSON 状态块（cabbage-tdd-state，取最后一个）；失败则回退旧 markdown 有损解析
  const evidenceBlock = extractEvidenceBlock(comment.body)
  const evidence =
    (evidenceBlock ? parseJsonStateEvidence(evidenceBlock.content) : null) ?? evidenceCommentToTddEvidence(comment)
  if (!evidence || evidence.revision < 1) {
    return {
      ok: false,
      code: "TDD_EVIDENCE_INCOMPLETE",
      message: "evidence comment is malformed or has no revision",
      missing: ["evidence-revision"],
    }
  }

  // 豁免语义：not-applicable / exempt-request → waived → 放行
  if (evidence.status === "waived") {
    return submitPr(state, issueNumber, comment, evidence.revision, evidence, taskId)
  }

  const compliance = evaluateTddCompliance(state.policy, evidence, criteria)
  if (compliance.status !== "pass") {
    return {
      ok: false,
      code: "TDD_EVIDENCE_INCOMPLETE",
      message: `TDD compliance not met: ${compliance.warnings.join("; ")}`,
      missing: compliance.warnings.length > 0 ? compliance.warnings : ["tdd-compliance"],
    }
  }

  return submitPr(state, issueNumber, comment, evidence.revision, evidence, taskId)
}

/** 解析 evidence comment 内 JSON 状态块（TDD_STATE_TAG，取最后一个），失败返回 null；schema 必须为 1 */
function parseJsonStateEvidence(body: string): TddEvidence | null {
  const marker = "<!-- cabbage-tdd-state -->"
  const idx = body.lastIndexOf(marker)
  if (idx === -1) return null
  try {
    const parsed = JSON.parse(body.slice(idx + marker.length).trim()) as { schema?: number; evidence?: TddEvidence }
    if (parsed.schema !== 1 || !parsed?.evidence) return null
    return { ...parsed.evidence, revision: parsed.evidence.revision ?? 1 }
  } catch {
    return null
  }
}

/** 创建 PR 的公共流程（evidence 通过后） */
async function submitPr(
  state: TaskRuntimeState,
  issueNumber: number,
  comment: { id: number },
  revision: number,
  _evidence: TddEvidence,
  taskId: string,
): Promise<SubmitTaskResult> {
  // push 分支（工具内以宿主凭据执行）
  try {
    await gitIn(state.worktreePath, `push -u origin '${escapeShellArg(state.branch)}'`)
  } catch (err) {
    return { ok: false, code: "PUSH_FAILED", message: String(err) }
  }

  // 创建 PR：body 引用 Task Record + evidence comment 链接 + Closes 约定
  const base = await readDefaultBranch()
  const { stdout: repoOut } = await taskGh("repo view --json nameWithOwner --jq .nameWithOwner")
  const repo = repoOut.trim()
  const evidenceLink = `https://github.com/${repo}/issues/${issueNumber}#issuecomment-${comment.id}`
  const prTitle = `feat: ${taskId}`
  const prBody = [`# ${taskId}`, "", `- Task Record: #${issueNumber}`, `- TDD evidence: ${evidenceLink}`, "", `Closes #${issueNumber}`, ""].join("\n")
  const { stdout: prOut } = await taskGh(
    `pr create --title '${escapeShellArg(prTitle)}' --body '${escapeShellArg(prBody)}' --base '${escapeShellArg(base)}' --head '${escapeShellArg(state.branch)}'`,
  )
  // gh pr create 不支持 --json：解析 stdout 中的 PR URL
  const prNumber = parsePrUrlNumber(prOut)
  if (prNumber === null) {
    return { ok: false, code: "PR_CREATE_FAILED", message: `invalid PR create output: ${prOut}` }
  }

  // PR 已创建成功；状态标签失败仅降级 warning（不把已建 PR 报为整体失败）
  const label = await setTaskStatusLabel(issueNumber, "reviewing")
  if (!label.ok) {
    return {
      ok: true,
      prNumber,
      evidenceRevision: revision,
      warning: `reviewing label update failed: ${label.error ?? "unknown"}`,
    }
  }

  return { ok: true, prNumber, evidenceRevision: revision }
}

// ─── submit-review ───

export type SubmitReviewResult =
  | { ok: true; prNumber: number; verdict: "approve" | "request-changes" }
  | { ok: false; code: string; message: string }

/** submit-review（spec §2.3）：primary 提交 reviewer 双轴审查结果（reviewer 本身只读） */
export async function submitReview(
  prNumber: number,
  verdict: "approve" | "request-changes",
  comment?: string,
): Promise<SubmitReviewResult> {
  try {
    if (verdict === "approve") {
      await taskGh(`pr review ${prNumber} --approve`)
    } else {
      const body = comment ? ` --body '${escapeShellArg(comment)}'` : ""
      await taskGh(`pr review ${prNumber} --request-changes${body}`)
    }
    return { ok: true, prNumber, verdict }
  } catch (err) {
    return { ok: false, code: "REVIEW_SUBMIT_FAILED", message: String(err) }
  }
}

// ─── merge-task ───

export type MergeTaskResult =
  | { ok: true; prNumber: number; risk: "low" | "high"; warning?: string }
  | { ok: false; code: string; message: string }

/**
 * merge-task（spec §2.3 + PRD R8）：CI checks 通过 + 分支保护 + 风险双层判定（只升不降）+
 * 高风险需非作者人类 approval → mergeTaskPR（--match-head-commit）→ 关闭 Sub Issue →
 * worktree 干净销毁。
 */
export async function mergeTask(
  projectDir: string,
  parentIssueNumber: number,
  taskId: string,
  modelRisk: "low" | "high",
): Promise<MergeTaskResult> {
  const issueNumber = await resolveTaskIssue(parentIssueNumber, taskId)
  if (issueNumber === null) {
    return { ok: false, code: "TASK_NOT_FOUND", message: `no sub issue with title "${taskId}" under parent #${parentIssueNumber}` }
  }
  const state = await readTaskState(projectDir, taskId)
  if (!state) {
    return { ok: false, code: "TASK_NOT_STARTED", message: `task "${taskId}" was not started (run start-task first)` }
  }

  // 1. 定位 open PR（head 分支）
  const { stdout: prOut } = await taskGh(
    `pr list --head '${escapeShellArg(state.branch)}' --state open --json number,headRefOid,author --jq '[.[] | {number, headRefOid, author}] | first'`,
  )
  if (prOut.trim() === "" || prOut.trim() === "null") {
    return { ok: false, code: "PR_NOT_FOUND", message: `no open PR for branch ${state.branch}` }
  }
  const pr = JSON.parse(prOut) as { number: number; headRefOid: string; author: { login: string } }

  // 2. CI checks 全部 SUCCESS
  const checks = await readPrChecks(pr.number)
  const failing = checks.filter(c => c.state !== "SUCCESS")
  if (failing.length > 0) {
    return {
      ok: false,
      code: "CI_CHECKS_NOT_PASSED",
      message: `CI checks not passed: ${failing.map(c => `${c.name}:${c.state}`).join(", ")}`,
    }
  }

  // 3. 分支保护存在
  const { stdout: repoOut } = await taskGh("repo view --json nameWithOwner --jq .nameWithOwner")
  const [owner, repo] = repoOut.trim().split("/")
  const protection = await checkBranchProtection(owner, repo)
  if (!protection.exists) {
    return { ok: false, code: "BRANCH_PROTECTION_REQUIRED", message: "branch protection is not enabled on the default branch" }
  }

  // 4. 风险双层判定：模型初判 + 内核按实际 diff 升级（只升不降）
  const profile = await readProjectProfile(projectDir)
  const changedFiles = await readPrChangedFiles(pr.number)
  const risk = escalateRisk(modelRisk, changedFiles, [...BUILTIN_RISK_PATTERNS, ...profile.riskPatterns])

  // 5. 高风险需非作者人类 approval
  if (risk === "high") {
    const approved = await hasNonAuthorHumanApproval(pr.number)
    if (!approved) {
      return {
        ok: false,
        code: "HIGH_RISK_APPROVAL_REQUIRED",
        message: `high-risk PR requires a non-author human approval (author: ${pr.author.login})`,
      }
    }
  }

  // 6. merge（--match-head-commit 防偷换）
  const merged = await mergeTaskPR(pr.number, pr.headRefOid)
  if (!merged.success) {
    return { ok: false, code: "MERGE_FAILED", message: merged.error ?? "merge failed" }
  }

  // 7. 关闭 Sub Issue + 状态 merged（PR 已合并，后续步骤独立容错，失败仅降级 warning）
  const warnings: string[] = []
  try {
    await taskGh(`issue close ${issueNumber}`)
  } catch (err) {
    warnings.push(`issue close failed: ${String(err)}`)
  }
  const mergedLabel = await setTaskStatusLabel(issueNumber, "merged")
  if (!mergedLabel.ok) {
    warnings.push(`merged label update failed: ${mergedLabel.error ?? "unknown"}`)
  }

  // 8. worktree 干净销毁（PR 已合并且干净 → 自动）；失败仅警告，不阻塞合并结果
  const cleanup = await destroyWorktree({ worktreeDir: state.worktreePath, branch: state.branch, prMerged: true, userConfirmed: false })
  if (!cleanup.ok && cleanup.reason === "DIRTY_WORKTREE") {
    warnings.push("PR merged but worktree has uncommitted changes; clean it manually")
  }

  return { ok: true, prNumber: pr.number, risk, ...(warnings.length > 0 ? { warning: warnings.join("; ") } : {}) }
}

/** 读 PR 的 statusCheckRollup 精简列表（CheckRun 用 conclusion、StatusContext 用 state） */
async function readPrChecks(prNumber: number): Promise<Array<{ name: string; state: string }>> {
  const { stdout } = await taskGh(
    `pr view ${prNumber} --json statusCheckRollup --jq '[.[] | {name: (.name // .context // "check"), state: (.state // .conclusion // "PENDING")}]'`,
  )
  return JSON.parse(stdout) as Array<{ name: string; state: string }>
}

/** 将原始 statusCheckRollup 映射为 {name, state}（纯函数，供测试直接验证 jq 语义） */
export function mapCheckRollup(raw: unknown[]): Array<{ name: string; state: string }> {
  return raw.map(item => {
    const obj = (item ?? {}) as Record<string, unknown>
    return {
      name: String(obj.name ?? obj.context ?? "check"),
      state: String(obj.state ?? obj.conclusion ?? "PENDING"),
    }
  })
}

/** 读 PR 变更文件路径列表（风险判定用） */
async function readPrChangedFiles(prNumber: number): Promise<string[]> {
  const { stdout } = await taskGh(`pr view ${prNumber} --json files --jq '[.files[].path]'`)
  return JSON.parse(stdout) as string[]
}

/** 是否存在非作者的人类 APPROVED review（高风险门禁） */
async function hasNonAuthorHumanApproval(prNumber: number): Promise<boolean> {
  const { stdout } = await taskGh(
    `pr view ${prNumber} --json author,reviews --jq '{author: .author.login, reviews: [.reviews[] | {state: .state, login: .author.login, type: .author.type}]}'`,
  )
  const data = JSON.parse(stdout) as {
    author: string
    reviews: Array<{ state: string; login: string; type: string }>
  }
  return data.reviews.some(r => r.state === "APPROVED" && r.login !== data.author && r.type === "User")
}

// ─── cancel-task / destroy-worktree / status-task ───

export type TaskLifecycleResult =
  | { ok: true; issueNumber: number }
  | { ok: false; code: string; message: string }

export type DestroyTaskWorktreeResult =
  | { ok: true; reason: string }
  | { ok: false; code: string; message: string }

export interface TaskStatusReport {
  task: { issueNumber: number; slug: string; state: string; labels: string[] }
  pullRequests: Array<{ number: number; state: string; headRefName: string; checks: Array<{ name: string; state: string }> }>
}

export type TaskStatusResult =
  | { ok: true; report: TaskStatusReport }
  | { ok: false; code: string; message: string }

/** cancel-task：受控取消（user_confirmed）→ 关闭 Sub Issue + 状态标签 cancelled */
export async function cancelTask(
  _projectDir: string,
  parentIssueNumber: number,
  taskId: string,
  userConfirmed: boolean,
): Promise<TaskLifecycleResult> {
  if (!userConfirmed) {
    return {
      ok: false,
      code: "USER_CONFIRMATION_REQUIRED",
      message: "Cancelling a task requires user confirmation (user_confirmed: true)",
    }
  }
  const issueNumber = await resolveTaskIssue(parentIssueNumber, taskId)
  if (issueNumber === null) {
    return { ok: false, code: "TASK_NOT_FOUND", message: `no sub issue with title "${taskId}" under parent #${parentIssueNumber}` }
  }
  try {
    await taskGh(`issue close ${issueNumber}`)
    await setTaskStatusLabel(issueNumber, "cancelled")
    return { ok: true, issueNumber }
  } catch (err) {
    return { ok: false, code: "GITHUB_ERROR", message: String(err) }
  }
}

/** destroy-worktree：preflight 销毁（§3.3），需 user_confirmed（除非 PR 已合并且干净） */
export async function destroyTaskWorktree(
  projectDir: string,
  parentIssueNumber: number,
  taskId: string,
  userConfirmed: boolean,
): Promise<DestroyTaskWorktreeResult> {
  const issueNumber = await resolveTaskIssue(parentIssueNumber, taskId)
  if (issueNumber === null) {
    return { ok: false, code: "TASK_NOT_FOUND", message: `no sub issue with title "${taskId}" under parent #${parentIssueNumber}` }
  }
  const state = await readTaskState(projectDir, taskId)
  if (!state) {
    return { ok: false, code: "TASK_NOT_STARTED", message: `task "${taskId}" was not started (run start-task first)` }
  }

  const prMerged = await isPrMerged(state.branch)
  const result = await destroyWorktree({
    worktreeDir: state.worktreePath,
    branch: state.branch,
    prMerged,
    userConfirmed,
  })
  if (!result.ok) {
    return { ok: false, code: result.reason, message: result.message }
  }
  return { ok: true, reason: result.reason }
}

/** 分支是否有已合并的 PR */
async function isPrMerged(branch: string): Promise<boolean> {
  const { stdout } = await taskGh(`pr list --head '${escapeShellArg(branch)}' --state merged --json number --jq 'length'`)
  return Number(stdout.trim()) > 0
}

/** status-task：读 Task Record + PR + checks 汇总 */
export async function readTaskStatus(
  _projectDir: string,
  parentIssueNumber: number,
  taskId: string,
): Promise<TaskStatusResult> {
  const issueNumber = await resolveTaskIssue(parentIssueNumber, taskId)
  if (issueNumber === null) {
    return { ok: false, code: "TASK_NOT_FOUND", message: `no sub issue with title "${taskId}" under parent #${parentIssueNumber}` }
  }
  try {
    const { stdout: issueOut } = await taskGh(
      `issue view ${issueNumber} --json number,title,state,labels,body --jq '{number, title, state, labels: [.labels[].name], body}'`,
    )
    const issue = JSON.parse(issueOut) as { state: string; labels: string[] }

    const branch = `feat/${taskId}`
    const { stdout: prsOut } = await taskGh(
      `pr list --head '${escapeShellArg(branch)}' --state all --json number,state,headRefName --jq '[.[] | {number, state, headRefName}]'`,
    )
    const prs = JSON.parse(prsOut) as Array<{ number: number; state: string; headRefName: string }>

    const pullRequests: TaskStatusReport["pullRequests"] = []
    for (const pr of prs) {
      const checks = await readPrChecks(pr.number)
      pullRequests.push({ ...pr, checks })
    }

    return {
      ok: true,
      report: { task: { issueNumber, slug: taskId, state: issue.state, labels: issue.labels }, pullRequests },
    }
  } catch (err) {
    const message = String(err)
    return message.includes("Could not resolve") || message.includes("not found")
      ? { ok: false, code: "NOT_FOUND", message }
      : { ok: false, code: "GITHUB_ERROR", message }
  }
}

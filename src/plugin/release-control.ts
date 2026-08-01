import { exec } from "node:child_process"
import { promisify } from "node:util"
import { readFile, writeFile } from "node:fs/promises"
import { join, resolve, sep } from "node:path"
import { tool } from "@opencode-ai/plugin/tool"
import { gh as ghCli } from "../util/gh.js"
import { escapeShellArg } from "../util/shell.js"
import { readProjectProfile } from "../kernel/profile.js"
import type { ProjectProfile } from "../kernel/profile.js"
import { requireCaller } from "../kernel/caller.js"
import type { CallerSessionClient } from "../kernel/caller.js"
import {
  classifyChanges,
  buildTag,
  buildReleaseNotes,
  parseVersion,
  parseVersionFileSpec,
  proposeVersion,
  readVersionFromJson,
  updateVersionInJson,
  latestTag,
  listCommitsSinceTag,
  validateTagImmutability,
  validateTagName,
} from "../kernel/release.js"
import type { GhFn, ReleaseChange } from "../kernel/release.js"

// ─── 可替换 executor（用于测试） ───

export type GitFn = (args: string, cwd: string) => Promise<{ stdout: string; stderr: string }>

let releaseGhExecutor: GhFn | null = null
let releaseGitExecutor: GitFn | null = null

export function setReleaseControlGhExecutor(fn: GhFn | null): void {
  releaseGhExecutor = fn
}

export function setReleaseControlGitExecutor(fn: GitFn | null): void {
  releaseGitExecutor = fn
}

const execAsync = promisify(exec)

async function runGh(args: string): Promise<{ stdout: string; stderr: string }> {
  if (releaseGhExecutor) return releaseGhExecutor(args)
  return ghCli(args)
}

async function runGit(cwd: string, args: string): Promise<{ stdout: string; stderr: string }> {
  if (releaseGitExecutor) return releaseGitExecutor(args, cwd)
  return execAsync(`git ${args}`, { cwd })
}

// ─── 内部辅助 ───

export type ReleaseControlOp = "propose-version" | "open-release-pr" | "merge-release-pr" | "monitor"

export interface ReleaseControlDeps {
  projectDir: string
  sessionClient: CallerSessionClient
}

function releaseBranch(version: string): string {
  return `release/v${version}`
}

/** 聚合上一 tag 后 main 的变更并分类；无 tag 时返回空变更集 */
async function collectChanges(profile: ProjectProfile): Promise<{ tag: string | null; changes: ReleaseChange[] }> {
  const tag = await latestTag(runGh)
  if (!tag) return { tag: null, changes: [] }
  const commits = await listCommitsSinceTag(tag, "main", runGh)
  return { tag, changes: classifyChanges(commits) }
}

/** version file path 是否落在 projectDir 内（防 Profile 配置路径穿越） */
function versionFilePath(profile: ProjectProfile, projectDir: string): string | null {
  const spec = parseVersionFileSpec(profile.versionFile ?? "")
  if (!spec) return null
  const abs = resolve(projectDir, spec.path)
  const root = resolve(projectDir)
  if (!abs.startsWith(root + sep) && abs !== root) {
    return null
  }
  return abs
}

async function readCurrentVersion(profile: ProjectProfile, projectDir: string): Promise<string | null> {
  const spec = parseVersionFileSpec(profile.versionFile ?? "")
  if (!spec) return null
  try {
    const raw = await readFile(join(projectDir, spec.path), "utf8")
    return readVersionFromJson(raw, spec.key)
  } catch {
    return null
  }
}

async function writeVersionFile(profile: ProjectProfile, projectDir: string, version: string): Promise<string | null> {
  const spec = parseVersionFileSpec(profile.versionFile ?? "")
  if (!spec) return "Error: Profile version file 配置无效（期望 `path[ $.key]`，如 `package.json $.version`）"
  try {
    const path = versionFilePath(profile, projectDir)
    if (path === null) return "Error: version file 路径越界（必须位于项目目录内）"
    const raw = await readFile(path, "utf8")
    await writeFile(path, updateVersionInJson(raw, spec.key, version))
    return null
  } catch (err) {
    return `Error: 无法更新版本文件：${String(err)}`
  }
}

// ─── 工具 ───

/**
 * release_control — 版本提议 / Release PR / 合并打 tag / release workflow 监控。
 * 技术栈无关：版本读写规则与 tag 格式全部来自 Profile（§9.1），不硬编码 npm。
 */
export function createReleaseControlTool(deps: ReleaseControlDeps) {
  return tool({
    description: `Control the release lifecycle (R9, tech-stack agnostic).

Ops:
- propose-version: aggregate all changes on main since the last tag, classify them
  (feature/fix/maintenance/docs + breaking), and propose a SemVer bump.
  Unclassified changes block the proposal until classified. Returns the proposed
  version and its tag.
- open-release-pr: create the release branch, bump the version file (per Profile
  version write rule), generate Release Notes, push, and open a Release PR.
- merge-release-pr: after CI passes and human approval, merge the Release PR,
  verify the merge SHA, and push the tag (tags are immutable, never re-pointed).
- monitor: poll the project GitHub Actions release workflow run until success;
  a failed run is rerun once.`,
    args: {
      op: tool.schema.enum(["propose-version", "open-release-pr", "merge-release-pr", "monitor"])
        .describe("Release control operation"),
      proposed_version: tool.schema.string().describe("Proposed semantic version (x.y.z), required for open-release-pr / merge-release-pr"),
      release_notes: tool.schema.string().describe("Optional override for the Release Notes body"),
      user_confirmed: tool.schema.boolean().describe("Human approval — required for merge-release-pr (release is a manual flow)"),
    },
    async execute(args: Record<string, any>, ctx: any): Promise<string> {
      try {
        const op = args.op as ReleaseControlOp

        // caller 门禁：release 为人工流程，仅 primary 可调用（§2.2/§2.3），fail-closed
        const denied = await requireCaller(
          { agent: ctx.agent, sessionID: ctx.sessionID },
          ["primary"],
          op,
          deps.sessionClient,
        )
        if (denied) return `Error: ${denied}`

        const profile = await readProjectProfile(deps.projectDir)

        switch (op) {
          case "propose-version":
            return proposeVersionOp(profile, deps.projectDir)
          case "open-release-pr":
            return openReleasePrOp(profile, args, deps.projectDir)
          case "merge-release-pr":
            return mergeReleasePrOp(profile, args)
          case "monitor":
            return monitorOp(profile)
          default:
            return `Error: unknown operation "${op}"`
        }
      } catch (err) {
        return `Error: INTERNAL_ERROR — ${String(err)}`
      }
    },
  })
}

async function proposeVersionOp(profile: ProjectProfile, projectDir: string): Promise<string> {
  if (!profile.versionFile) {
    return "Error: Profile 缺少 version file 配置（先运行 /setup 确认 Release Profile）"
  }

  const current = await readCurrentVersion(profile, projectDir)
  if (current === null) {
    return `Error: 无法从版本文件（${profile.versionFile}）读取当前版本`
  }

  const { tag, changes } = await collectChanges(profile)
  if (!tag) {
    return "Error: 仓库尚无 tag，无法聚合上一 tag 后的变更；请先人工创建基线 tag"
  }

  const unclassified = changes.filter(c => c.category === "unclassified")
  if (unclassified.length > 0) {
    const list = unclassified.map(c => `${c.sha.slice(0, 7)} ${c.title}`).join("\n")
    return `Error: ${unclassified.length} 个未分类变更，版本提议前必须分类（propose-version 不产出版本号）：\n${list}`
  }

  const result = proposeVersion(current, changes)
  if (!result.ok) {
    return `Error: ${result.message}`
  }

  const tagFormat = profile.tagFormat ?? "v{version}"
  const nextTag = buildTag(result.proposed, tagFormat)
  const summary = changes
    .filter(c => c.category !== "unclassified")
    .reduce<Record<string, number>>((acc, c) => {
      acc[c.category] = (acc[c.category] ?? 0) + 1
      return acc
    }, {})
  return [
    `Version proposal: ${current} → ${result.proposed} (${result.type} bump)`,
    `Tag: ${nextTag}`,
    `Changes since ${tag}: ${changes.length} (${Object.entries(summary).map(([k, v]) => `${k}: ${v}`).join(", ")})`,
    "",
    buildReleaseNotes(result.proposed, changes),
  ].join("\n")
}

async function openReleasePrOp(profile: ProjectProfile, args: Record<string, any>, projectDir: string): Promise<string> {
  const version = String(args.proposed_version ?? "")
  const parsed = parseVersion(version)
  if (!parsed) {
    return "Error: proposed_version 必填且必须为 x.y.z（先调用 propose-version 获取提议版本）"
  }
  if (!profile.versionFile) {
    return "Error: Profile 缺少 version file 配置（先运行 /setup 确认 Release Profile）"
  }

  const tagFormat = profile.tagFormat ?? "v{version}"
  const tag = buildTag(version, tagFormat)
  if (!validateTagName(tag)) {
    return `Error: tag 名含非法字符（${tag}），拒绝继续（可能由 Profile tag format 引起）`
  }
  const branch = releaseBranch(version)

  const mainSha = (await runGh(`api repos/{owner}/{repo}/commits/main --jq .sha`)).stdout.trim()
  const immutability = await validateTagImmutability(tag, mainSha, runGh)
  if (!immutability.ok) {
    return `Error: ${immutability.message}`
  }

  try {
    await runGit(projectDir, "fetch origin")
    await runGit(projectDir, `checkout -b '${escapeShellArg(branch)}' origin/main`)
  } catch (err) {
    return `Error: 创建 release branch 失败：${String(err)}`
  }

  const writeError = await writeVersionFile(profile, projectDir, version)
  if (writeError) return writeError

  try {
    const spec = parseVersionFileSpec(profile.versionFile ?? "")
    if (spec === null || versionFilePath(profile, projectDir) === null) {
      return "Error: version file 配置无效"
    }
    await runGit(projectDir, `add '${escapeShellArg(spec.path)}'`)
    await runGit(projectDir, `commit -m 'release: ${escapeShellArg(tag)}'`)
  } catch (err) {
    return `Error: 提交版本更新失败：${String(err)}`
  }

  let notes = String(args.release_notes ?? "")
  if (notes === "") {
    const { changes } = await collectChanges(profile)
    notes = buildReleaseNotes(version, changes)
  }

  try {
    await runGit(projectDir, `push -u origin '${escapeShellArg(branch)}'`)
  } catch (err) {
    return `Error: push release branch 失败：${String(err)}`
  }

  try {
    const { stdout } = await runGh(
      `pr create --base main --head '${escapeShellArg(branch)}' --title 'release: ${escapeShellArg(tag)}' --body '${escapeShellArg(notes)}' --json number --jq .number`,
    )
    return `Release PR created: #${stdout.trim()} (branch ${branch}, tag ${tag})`
  } catch (err) {
    return `Error: 创建 Release PR 失败：${String(err)}`
  }
}

async function mergeReleasePrOp(profile: ProjectProfile, args: Record<string, any>): Promise<string> {
  const version = String(args.proposed_version ?? "")
  if (!parseVersion(version)) {
    return "Error: proposed_version 必填且必须为 x.y.z"
  }

  // 人工批准门禁：release 为人工流程（R9），必须显式 user_confirmed
  if (args.user_confirmed !== true) {
    return "Error: merge-release-pr 需要人工批准（user_confirmed: true）。请先审查 Release PR 与版本提议后再确认。"
  }

  const branch = releaseBranch(version)
  const prNumber = (await runGh(`pr list --head '${escapeShellArg(branch)}' --json number --jq '.[0].number'`)).stdout.trim()
  if (!prNumber || prNumber === "null") {
    return "Error: 未找到对应 Release PR（branch: " + branch + "）"
  }

  // CI 校验：读取 statusCheckRollup；进行中项显式标记 IN_PROGRESS，不得放行
  const rollup = (await runGh(
    `pr view ${prNumber} --json statusCheckRollup --jq '[.statusCheckRollup[] | if .conclusion == null then "IN_PROGRESS" else .conclusion end] | unique'`,
  )).stdout.trim()
  let conclusions: string[]
  try {
    conclusions = JSON.parse(rollup) as string[]
  } catch {
    return `Error: 无法解析 PR #${prNumber} 的 CI checks 状态`
  }
  if (conclusions.length === 0) {
    return `Error: PR #${prNumber} 没有任何 CI checks 报告，无法自动合并（需要 CI 或人工介入）`
  }
  if (conclusions.includes("IN_PROGRESS")) {
    return `Error: PR #${prNumber} 的 CI checks 尚未全部完成，请等待完成后再重试`
  }
  if (conclusions.includes("FAILURE") || conclusions.includes("CANCELLED") || conclusions.includes("ACTION_REQUIRED")) {
    return `Error: PR #${prNumber} 的 CI checks 存在失败项（${conclusions.join(", ")}），无法合并`
  }
  if (!conclusions.every(c => c === "SUCCESS" || c === "NEUTRAL" || c === "SKIPPED")) {
    return `Error: PR #${prNumber} 的 CI checks 存在未知结论（${conclusions.join(", ")}），无法合并`
  }

  try {
    await runGh(`pr merge ${prNumber} --squash --delete-branch`)
  } catch (err) {
    return `Error: 合并 Release PR 失败：${String(err)}`
  }

  const mergeSha = (await runGh(`pr view ${prNumber} --json mergeCommit --jq '.mergeCommit.oid'`)).stdout.trim()
  if (!mergeSha || mergeSha === "null") {
    return "Error: 无法读取 merge commit SHA"
  }

  const tagFormat = profile.tagFormat ?? "v{version}"
  const tag = buildTag(version, tagFormat)
  if (!validateTagName(tag)) {
    return `Error: tag 名含非法字符（${tag}），拒绝打 tag`
  }
  if (!/^[0-9a-f]{40}$/i.test(mergeSha)) {
    return "Error: merge commit SHA 非法（应为 40 位 hex）"
  }
  const immutability = await validateTagImmutability(tag, mergeSha, runGh)
  if (!immutability.ok) {
    return `Error: ${immutability.message}`
  }

  try {
    await runGh(`api repos/{owner}/{repo}/git/refs -f ref=refs/tags/'${escapeShellArg(tag)}' -f sha='${escapeShellArg(mergeSha)}'`)
  } catch (err) {
    return `Error: 打 tag 失败（可能已存在）：${String(err)}`
  }

  return `Merged #${prNumber} and tagged ${tag} @ ${mergeSha.slice(0, 7)}`
}

async function monitorOp(profile: ProjectProfile): Promise<string> {
  const workflow = profile.releaseWorkflowPath
  if (!workflow) {
    return "Error: Profile 缺少 release workflow 配置（release-ready 未满足，先运行 /setup）"
  }

  const { stdout } = await runGh(
    `run list --workflow '${escapeShellArg(workflow)}' --limit 1 --json databaseId,status,conclusion,headBranch --jq '.[0]'`,
  )
  const runJson = stdout.trim()
  if (!runJson || runJson === "null") {
    return "No release workflow runs found yet."
  }

  let run: { databaseId: number; status: string; conclusion: string | null; headBranch: string }
  try {
    run = JSON.parse(runJson) as { databaseId: number; status: string; conclusion: string | null; headBranch: string }
  } catch {
    return "Error: 无法解析 release workflow run 状态（gh 输出异常）"
  }
  if (run.status !== "completed") {
    return `Release workflow run #${run.databaseId} is ${run.status} (branch ${run.headBranch}) — not finished, check again later`
  }

  if (run.conclusion === "success") {
    return `Release workflow run #${run.databaseId} succeeded — release complete`
  }

  if (run.conclusion === "failure") {
    try {
      await runGh(`run rerun ${run.databaseId}`)
      return `Release workflow run #${run.databaseId} failed — rerun triggered, check again later`
    } catch (err) {
      return `Release workflow run #${run.databaseId} failed and rerun failed: ${String(err)}`
    }
  }

  return `Release workflow run #${run.databaseId} ${run.conclusion} — needs human intervention (Corrective Flow + new version)`
}

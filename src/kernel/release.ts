import { gh as ghCli } from "../util/gh.js"

// ─── 类型 ───

export type ChangeCategory = "feature" | "fix" | "maintenance" | "docs" | "unclassified"
export type VersionType = "major" | "minor" | "patch"

export interface ReleaseChange {
  sha: string
  title: string
  category: ChangeCategory
  breaking: boolean
}

export interface Version {
  major: number
  minor: number
  patch: number
}

// ─── 版本文件读写（Profile §9.1，技术栈无关） ───

export interface VersionFileSpec {
  path: string
  key: string
}

/**
 * 解析版本文件规则（Profile `version file` 值）：
 * 形如 `package.json`（默认 $.version）或 `lib/version.json $.version`；
 * json 路径必须为 `$.<key>` 形式，否则返回 null。
 */
export function parseVersionFileSpec(spec: string): VersionFileSpec | null {
  const trimmed = spec.trim()
  if (trimmed === "") return null

  const parts = trimmed.split(/\s+/)
  if (parts.length === 1) {
    return { path: parts[0], key: "version" }
  }

  const jsonPath = parts[parts.length - 1]
  const key = jsonPath.startsWith("$.") ? jsonPath.slice(2) : ""
  if (key === "") return null
  return { path: parts.slice(0, -1).join(" "), key }
}

/** 从 JSON 文本按 key 读取版本字符串；非字符串或解析失败返回 null */
export function readVersionFromJson(json: string, key: string): string | null {
  try {
    const value = JSON.parse(json)?.[key]
    return typeof value === "string" ? value : null
  } catch {
    return null
  }
}

/** 更新 JSON 文本中指定 key 的版本；保留缩进风格与结尾换行 */
export function updateVersionInJson(json: string, key: string, version: string): string {
  const parsed = JSON.parse(json) as Record<string, unknown>
  parsed[key] = version
  const updated = JSON.stringify(parsed, null, 2)
  return json.endsWith("\n") ? `${updated}\n` : updated
}

// ─── 版本纯函数 ───

const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/

export function parseVersion(raw: string): Version | null {
  const match = VERSION_PATTERN.exec(raw.trim())
  if (!match) return null
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) }
}

export function formatVersion(v: Version): string {
  return `${v.major}.${v.minor}.${v.patch}`
}

/** SemVer bump：major 重置 minor/patch，minor 重置 patch，patch +1 */
export function bumpVersion(current: Version, type: VersionType): Version {
  switch (type) {
    case "major":
      return { major: current.major + 1, minor: 0, patch: 0 }
    case "minor":
      return { major: current.major, minor: current.minor + 1, patch: 0 }
    case "patch":
      return { major: current.major, minor: current.minor, patch: current.patch + 1 }
  }
}

/** 取最高 bump 级别：major > minor > patch */
export function highestBumpType(types: VersionType[]): VersionType {
  if (types.includes("major")) return "major"
  if (types.includes("minor")) return "minor"
  return "patch"
}

// ─── 变更分类 ───

type Classified = { category: ChangeCategory; breaking: boolean }

const CONVENTIONAL_PATTERN = /^([a-z]+)(!)?(\([^)]*\))?:/

const MAINTENANCE_TYPES = new Set(["chore", "refactor", "build", "ci", "perf", "test", "merge"])

/**
 * 从 commit message 分类（conventional commits，关联 Flow/Task type）：
 * - breaking：`type!:` 或 body 含 `BREAKING CHANGE`
 * - feat→feature、fix→fix、docs→docs、chore/refactor/build/ci/perf/test/merge→maintenance
 * - 其余 → unclassified
 */
export function classifyCommitTitle(title: string): Classified {
  const firstLine = title.split("\n")[0]
  const breaking = /^[a-z]+!(:|\()/.test(firstLine) || title.includes("BREAKING CHANGE")

  if (firstLine.startsWith("Merge ")) {
    return { category: "maintenance", breaking }
  }

  const match = CONVENTIONAL_PATTERN.exec(firstLine)
  if (!match) return { category: "unclassified", breaking }
  const type = match[1]

  switch (type) {
    case "feat":
      return { category: "feature", breaking }
    case "fix":
      return { category: "fix", breaking }
    case "docs":
      return { category: "docs", breaking }
    default:
      if (MAINTENANCE_TYPES.has(type)) return { category: "maintenance", breaking }
      return { category: "unclassified", breaking }
  }
}

export function classifyChanges(commits: { sha: string; title: string }[]): ReleaseChange[] {
  return commits.map(commit => {
    const { category, breaking } = classifyCommitTitle(commit.title)
    return { sha: commit.sha, title: commit.title.split("\n")[0], category, breaking }
  })
}

// ─── 版本提议（未分类门禁） ───

export type ProposeVersionResult =
  | { ok: true; proposed: string; type: VersionType }
  | { ok: false; code: "INVALID_VERSION"; message: string }
  | { ok: false; code: "UNCLASSIFIED_CHANGES"; unclassified: { sha: string; title: string }[]; message: string }

/**
 * SemVer 提议：breaking→major（含 0.x）、feature→minor、fix/maintenance/docs→patch；
 * 多变更取最高级别；存在未分类变更时拒绝（版本提议前必须分类）。
 */
export function proposeVersion(currentVersion: string, changes: ReleaseChange[]): ProposeVersionResult {
  const current = parseVersion(currentVersion)
  if (!current) {
    return { ok: false, code: "INVALID_VERSION", message: `Invalid current version: ${currentVersion}` }
  }

  const unclassified = changes
    .filter(c => c.category === "unclassified")
    .map(c => ({ sha: c.sha, title: c.title }))
  if (unclassified.length > 0) {
    return {
      ok: false,
      code: "UNCLASSIFIED_CHANGES",
      unclassified,
      message: `Unclassified changes must be classified before proposing a version (${unclassified.length} change(s))`,
    }
  }

  const breaking = changes.some(c => c.breaking)
  const types: VersionType[] = []
  for (const c of changes) {
    if (c.category === "feature") types.push("minor")
    else if (c.category === "fix" || c.category === "maintenance" || c.category === "docs") types.push("patch")
  }
  if (breaking) types.push("major")

  const type = highestBumpType(types)
  return { ok: true, proposed: formatVersion(bumpVersion(current, type)), type }
}

// ─── tag ───

/** 按 tag 格式（如 v{version}）构建 tag；缺省 v{version} */
export function buildTag(version: string, tagFormat: string): string {
  if (tagFormat.includes("{version}")) {
    return tagFormat.replace("{version}", version)
  }
  return `v${version}`
}

/** tag 是否匹配格式（替换 {version} 为语义版本正则后整体匹配） */
export function validateTagFormat(tag: string, tagFormat: string): boolean {
  const escaped = tagFormat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace("\\{version\\}", "(\\d+\\.\\d+\\.\\d+)")
  return new RegExp(`^${escaped}$`).test(tag)
}

// ─── Release Notes ───

const SECTION_TITLES: [ChangeCategory, string][] = [
  ["feature", "Features"],
  ["fix", "Fixes"],
  ["maintenance", "Maintenance"],
  ["docs", "Documentation"],
]

/** 按分类聚合生成 Release Notes markdown；breaking 变更单独列出 */
export function buildReleaseNotes(version: string, changes: ReleaseChange[]): string {
  const lines: string[] = [`## ${version}`]
  const breaking = changes.filter(c => c.breaking)
  if (breaking.length > 0) {
    lines.push("", "### BREAKING CHANGES")
    for (const c of breaking) lines.push(`- ${c.title}`)
  }
  for (const [category, title] of SECTION_TITLES) {
    const group = changes.filter(c => c.category === category)
    if (group.length === 0) continue
    lines.push("", `### ${title}`)
    for (const c of group) lines.push(`- ${c.title}`)
  }
  return lines.join("\n")
}

// ─── gh 聚合 / tag 校验（可替换 executor，仿 kernel/records.ts） ───

export type GhFn = (args: string) => Promise<{ stdout: string; stderr: string }>

let releaseGhExecutor: GhFn | null = null

export function setReleaseGhExecutor(fn: GhFn | null): void {
  releaseGhExecutor = fn
}

/** 解析实际 gh 执行函数：显式 executor > 模块级 mock > 真实 gh CLI */
function ghFn(executor?: GhFn): GhFn {
  return executor ?? releaseGhExecutor ?? ghCli
}

/** 仓库上一 tag 名（tags 列表第一个）；无 tag 返回 null */
export async function latestTag(executor?: GhFn): Promise<string | null> {
  const { stdout } = await ghFn(executor)(`api repos/{owner}/{repo}/tags --jq '.[0].name'`)
  const trimmed = stdout.trim()
  if (trimmed === "" || trimmed === "null") return null
  return trimmed
}

/** 聚合上一 tag 之后 base 分支的全部 commit（sha + 首行标题） */
export async function listCommitsSinceTag(
  tag: string,
  baseBranch: string,
  executor?: GhFn,
): Promise<{ sha: string; title: string }[]> {
  const { stdout } = await ghFn(executor)(
    `api repos/{owner}/{repo}/compare/${tag}...${baseBranch} --jq '.commits[] | {sha: .sha, title: (.commit.message | split("\\n")[0])}'`,
  )
  const trimmed = stdout.trim()
  if (trimmed === "" || trimmed === "null") return []
  const commits = JSON.parse(trimmed) as { sha: string; title: string }[]
  // jq 已截断首行，这里再截断一次（mock/调用方绕过 jq 时兜底）
  return commits.map(c => ({ sha: c.sha, title: c.title.split("\n")[0] }))
}

/** 远程已存在 tag 指向的 commit SHA；不存在返回 null */
export async function existingTagSha(tag: string, executor?: GhFn): Promise<string | null> {
  const { stdout } = await ghFn(executor)(`api repos/{owner}/{repo}/tags --jq '.[] | select(.name == "${tag}") | .commit.sha'`)
  const trimmed = stdout.trim()
  if (trimmed === "" || trimmed === "null") return null
  return trimmed
}

export type TagImmutabilityResult =
  | { ok: true; reason?: string }
  | { ok: false; code: "TAG_ALREADY_EXISTS"; message: string }

/**
 * tag 不可变校验：不得删除重打。
 * 远程已存在且指向不同 SHA → 拒绝；指向同一 SHA → 幂等通过；不存在 → 可创建。
 */
export async function validateTagImmutability(
  tag: string,
  expectedSha: string,
  executor?: GhFn,
): Promise<TagImmutabilityResult> {
  const existing = await existingTagSha(tag, executor)
  if (existing === null) {
    return { ok: true }
  }
  if (existing === expectedSha) {
    return { ok: true, reason: "tag already points at the expected commit (idempotent)" }
  }
  return {
    ok: false,
    code: "TAG_ALREADY_EXISTS",
    message: `Tag ${tag} already exists at ${existing}, refusing to re-point it to ${expectedSha} (tags are immutable)`,
  }
}

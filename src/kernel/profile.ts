import { readFile } from "node:fs/promises"
import { join } from "node:path"

/** AGENTS.md 中 Project Profile 区块的固定标题 */
export const PROFILE_SECTION_TITLE = "## Project Profile"

export type TddDefaultMode = "strict" | "relaxed" | "bypass"

/** 解析后的结构化项目 Profile（只含可机检字段） */
export interface ProjectProfile {
  testCommand: string | null
  regressionCommand: string | null
  testFilePatterns: string[]
  implementationFilePatterns: string[]
  tddDefaultMode: TddDefaultMode | null
  versionBumpRule: string | null
  versionFile: string | null
  tagFormat: string | null
  releaseWorkflowPath: string | null
  riskPatterns: string[]
}

export interface ProfileParseResult {
  profile: ProjectProfile
  warnings: string[]
}

/** 无 Profile 时的空值：所有可选字段为 null、列表字段为空数组 */
export function emptyProfile(): ProjectProfile {
  return {
    testCommand: null,
    regressionCommand: null,
    testFilePatterns: [],
    implementationFilePatterns: [],
    tddDefaultMode: null,
    versionBumpRule: null,
    versionFile: null,
    tagFormat: null,
    releaseWorkflowPath: null,
    riskPatterns: [],
  }
}

/** 条目行：`- key: value`，key 仅含小写字母/数字/空格/下划线/连字符 */
const KEY_VALUE_PATTERN = /^- ([a-z0-9 _-]+):\s*(.+)$/

const VALID_TDD_MODES = new Set<string>(["strict", "relaxed", "bypass"])

/**
 * 解析 markdown 中的 `## Project Profile` 区块。
 * 定位标题到下一个 `##` 标题之间的条目行，按白名单提取；
 * 未知 key 记 warning（不阻断），重复 key 取最后（文档语义）。
 */
export function parseProjectProfile(markdown: string): ProfileParseResult {
  const profile = emptyProfile()
  const warnings: string[] = []
  const section = findProfileSection(markdown)
  if (!section) {
    return { profile, warnings }
  }

  const lines = markdown.split("\n")
  for (let i = section.start + 1; i < section.end; i++) {
    const match = KEY_VALUE_PATTERN.exec(lines[i])
    if (!match) continue
    applyKey(profile, warnings, match[1], cleanValue(match[2]))
  }
  return { profile, warnings }
}

/** 从项目根目录读取 AGENTS.md 并解析；文件缺失或区块缺失返回空 Profile，不抛错 */
export async function readProjectProfile(projectDir: string): Promise<ProjectProfile> {
  let markdown: string
  try {
    markdown = await readFile(join(projectDir, "AGENTS.md"), "utf8")
  } catch {
    return emptyProfile()
  }
  return parseProjectProfile(markdown).profile
}

/**
 * 确认回写辅助：将 profileBlock（完整 `## Project Profile` 区块）写入 markdown。
 * 已存在区块则整块替换，否则追加到末尾。
 */
export function upsertProjectProfile(markdown: string, profileBlock: string): string {
  const section = findProfileSection(markdown)
  if (!section) {
    const trimmed = markdown.trimEnd()
    if (trimmed === "") return profileBlock.trimStart()
    return `${trimmed}\n\n${profileBlock}`
  }

  const lines = markdown.split("\n")
  const before = lines.slice(0, section.start).join("\n").trimEnd()
  const after = lines.slice(section.end).join("\n").trimStart()
  return [before, profileBlock.trim(), after].filter(part => part !== "").join("\n\n")
}

/** 定位 Profile 区块：标题行索引与结束行索引（下一个 `##` 标题，含；无则到文件末尾） */
function findProfileSection(markdown: string): { start: number; end: number } | null {
  const lines = markdown.split("\n")
  const start = lines.findIndex(line => line.trim() === PROFILE_SECTION_TITLE)
  if (start === -1) return null

  let end = lines.length
  for (let i = start + 1; i < lines.length; i++) {
    if (/^#{2,}\s/.test(lines[i])) {
      end = i
      break
    }
  }
  return { start, end }
}

/** 去掉值中的反引号与两端空白 */
function cleanValue(raw: string): string {
  return raw.replaceAll("`", "").trim()
}

/**
 * 逗号分隔的模式列表：trim 并过滤空项。
 * 忽略 glob 花括号组内的逗号（如 test 文件的 ts/tsx 花括号写法不得被拆开）。
 */
function splitPatterns(value: string): string[] {
  return value
    .split(/,(?![^{}]*})/)
    .map(part => part.trim())
    .filter(part => part !== "")
}

function applyKey(profile: ProjectProfile, warnings: string[], key: string, value: string): void {
  switch (key) {
    case "test command":
      profile.testCommand = value
      return
    case "regression command":
      profile.regressionCommand = value
      return
    case "test file patterns":
      profile.testFilePatterns = splitPatterns(value)
      return
    case "implementation file patterns":
      profile.implementationFilePatterns = splitPatterns(value)
      return
    case "tdd default mode":
      if (VALID_TDD_MODES.has(value)) {
        profile.tddDefaultMode = value as TddDefaultMode
      } else {
        warnings.push(`Invalid tdd default mode: ${value}`)
      }
      return
    case "version bump rule":
      profile.versionBumpRule = value
      return
    case "version file":
      profile.versionFile = value
      return
    case "tag format":
      if (value.includes("{version}")) {
        profile.tagFormat = value
      } else {
        warnings.push(`tag format must contain {version} placeholder: ${value}`)
      }
      return
    case "release workflow":
      profile.releaseWorkflowPath = value
      return
    case "risk patterns":
      profile.riskPatterns = splitPatterns(value)
      return
    default:
      warnings.push(`Unknown profile key: ${key}`)
  }
}

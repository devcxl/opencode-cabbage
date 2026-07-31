export const MAX_SLUG_LENGTH = 60

export type BranchType = "feat" | "fix" | "chore" | "docs"

export type SlugValidationResult =
  | { ok: true; slug: string }
  | { ok: false; code: "EMPTY_TITLE" | "INVALID_FORMAT" | "SLUG_TOO_LONG" | "GENERIC_TITLE"; message: string }

/** 合法 slug：小写字母/数字分段，段间单个连字符 */
const SLUG_FORMAT = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** 泛化/占位词：与数字或其他泛化词组合时无法表达具体功能 */
const GENERIC_WORDS = new Set([
  "add", "bug", "bugs", "chore", "create", "delete", "docs", "feature",
  "features", "fix", "fixes", "implement", "issue", "issues", "refactor",
  "remove", "support", "task", "tasks", "test", "tests", "update", "wip",
])

/**
 * 严格 slug 派生：沿用 util/paths.ts slugify 的归一化规则，
 * 但不做 "doc" 兜底——无意义输入返回空串，由调用方判定。
 */
export function deriveSlug(value: string): string {
  let slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/--+/g, "-")

  if (slug.length > MAX_SLUG_LENGTH) {
    const sliced = slug.slice(0, MAX_SLUG_LENGTH)
    const lastDash = sliced.lastIndexOf("-")
    slug = lastDash > MAX_SLUG_LENGTH / 2 ? sliced.slice(0, lastDash) : sliced
  }

  return slug
}

/**
 * 校验功能标题（须已是 kebab-case slug）：
 * - 空标题、非法字符（大写/下划线/空格/连续连字符/首尾连字符）、过长（>60）→ 格式拒绝
 * - 纯序号或全部由泛化词组成（task-001、implement-task、fix-bug）→ GENERIC_TITLE
 */
export function validateTitle(title: string): SlugValidationResult {
  if (title.trim() === "") {
    return { ok: false, code: "EMPTY_TITLE", message: "Title must not be empty" }
  }
  if (title.length > MAX_SLUG_LENGTH) {
    return { ok: false, code: "SLUG_TOO_LONG", message: `Title must be at most ${MAX_SLUG_LENGTH} characters` }
  }
  if (!SLUG_FORMAT.test(title)) {
    return {
      ok: false,
      code: "INVALID_FORMAT",
      message: "Title must be a kebab-case slug: lowercase letters, digits, and single hyphens between segments",
    }
  }
  if (isGenericSlug(title)) {
    return {
      ok: false,
      code: "GENERIC_TITLE",
      message: "Title is too generic: use a functional slug that describes the concrete behavior",
    }
  }
  return { ok: true, slug: title }
}

/** 纯序号，或所有分段均为泛化词/数字 → 无法描述具体功能 */
function isGenericSlug(slug: string): boolean {
  const segments = slug.split("-")
  return segments.every(seg => /^\d+$/.test(seg) || GENERIC_WORDS.has(seg))
}

export function branchFor(slug: string, type: BranchType): string {
  return `${type}/${slug}`
}

export function worktreeFor(slug: string): string {
  return `.worktree/${slug}`
}

/**
 * 从 gh pr create 的 stdout（PR URL，如 https://github.com/owner/repo/pull/123）解析 PR 编号。
 * gh pr create 不支持 --json/--jq，只能解析 URL 末尾数字；解析失败返回 null。
 */
export function parsePrUrlNumber(stdout: string): number | null {
  const trimmed = stdout.trim()
  const match = trimmed.match(/(\d+)\/?$/)
  if (!match) return null
  const n = Number(match[1])
  return Number.isInteger(n) && n > 0 ? n : null
}

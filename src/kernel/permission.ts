/**
 * OpenCode permission 匹配纯函数（spec §7.2）。
 *
 * 语义与 OpenCode 当前实现对齐：
 * - bash 模式规则：pattern 支持 `*` 通配（`*` 兜底、`cmd*` 前缀匹配）
 * - 最后匹配优先：后声明的规则覆盖先声明的同命中规则
 * - auto 模式：仅 allow 放行，deny/ask 均拒绝
 */

export type PermissionAction = "allow" | "deny" | "ask"

/** 含 `**` 的 pattern 按 glob 语义匹配（`**` 跨目录、`*` 单段，对齐引擎 edit/read 路径规则） */
function globPatternMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&")
  const regex = new RegExp(`^${escaped.replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`)
  return regex.test(value)
}

/** pattern 是否命中 command：含 `/` 的路径规则走 glob（`**` 跨目录、`*` 单段，对齐引擎 edit/read 语义）；否则 bash 规则：`*` 全匹配、`前缀*` 前缀匹配、无通配精确匹配 */
export function permissionPatternMatches(pattern: string, command: string): boolean {
  if (pattern.includes("/")) return globPatternMatches(pattern, command)
  if (pattern === "*") return true
  if (pattern.endsWith("*")) return command.startsWith(pattern.slice(0, -1))
  return command === pattern
}

/**
 * 按规则集解析 command 的最终动作。
 * 按声明顺序遍历，命中即记录，后命中覆盖先前 → 最后匹配优先。
 * 无任何命中返回 "ask"（默认询问，auto 模式下等效拒绝）。
 */
export function matchPermission(rules: Record<string, string>, command: string): PermissionAction {
  let action: PermissionAction = "ask"
  for (const [pattern, raw] of Object.entries(rules)) {
    if (!permissionPatternMatches(pattern, command)) continue
    action = raw === "allow" ? "allow" : raw === "deny" ? "deny" : "ask"
  }
  return action
}

/**
 * auto 模式门禁：仅 allow 放行；deny 与 ask（无命中）均拒绝。
 */
export function isAllowedInAutoMode(rules: Record<string, string>, command: string): boolean {
  return matchPermission(rules, command) === "allow"
}

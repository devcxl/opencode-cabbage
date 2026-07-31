/**
 * OpenCode permission 匹配纯函数（spec §7.2）。
 *
 * 语义与 OpenCode 当前实现对齐：
 * - bash 模式规则：pattern 支持 `*` 通配（`*` 兜底、`cmd*` 前缀匹配）
 * - 最后匹配优先：后声明的规则覆盖先声明的同命中规则
 * - auto 模式：仅 allow 放行，deny/ask 均拒绝
 */

export type PermissionAction = "allow" | "deny" | "ask"

/** pattern 是否命中 command：`*` 全匹配，`前缀*` 前缀匹配，否则精确匹配 */
export function permissionPatternMatches(pattern: string, command: string): boolean {
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
    action = raw === "allow" ? "allow" : "deny"
  }
  return action
}

/**
 * auto 模式门禁：仅 allow 放行；deny 与 ask（无命中）均拒绝。
 */
export function isAllowedInAutoMode(rules: Record<string, string>, command: string): boolean {
  return matchPermission(rules, command) === "allow"
}

/**
 * OpenCode permission 匹配纯函数（spec §7.2）。
 *
 * 语义与 OpenCode 当前实现对齐：
 * - bash 模式规则：pattern 支持 `*` 通配（`*` 兜底、`cmd*` 前缀匹配）
 * - 最后匹配优先：后声明的规则覆盖先声明的同命中规则
 */

export type PermissionAction = "allow" | "deny" | "ask"

/** V2 原生权限规则（宿主 `permissions: PermissionRule[]` 子集） */
export interface PermissionRuleLike {
  action: string
  resource: string
  effect: string
}

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
  return matchPermissionRules(
    Object.entries(rules).map(([resource, effect]) => ({ action: "", resource, effect })),
    command,
  )
}

/**
 * 按 V2 原生规则数组解析 value 的最终动作（`permissions: PermissionRule[]`）。
 * 规则序即优先级：action 相同且 resource 命中的规则后写覆盖先写（最后匹配优先）。
 * 指定 action 时先过滤该 action 的规则（不同 action 的 `*` 规则不得互相干扰）；
 * 缺省 action 时不做过滤（V1 记录式规则集语义，见 matchPermission）。
 * 无任何命中返回 "ask"。
 */
export function matchPermissionRules(
  rules: readonly PermissionRuleLike[],
  value: string,
  action?: string,
): PermissionAction {
  let result: PermissionAction = "ask"
  for (const rule of rules) {
    if (action !== undefined && rule.action !== action) continue
    if (!permissionPatternMatches(rule.resource, value)) continue
    result = rule.effect === "allow" ? "allow" : rule.effect === "deny" ? "deny" : "ask"
  }
  return result
}

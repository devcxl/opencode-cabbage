/**
 * 工具调用者校验原语（spec §2.2）。
 *
 * 判定：`ctx.agent` 为 agent 名；session 无 parentID（经 session client 检查）→ primary；
 * 子会话按 agent 名映射角色，未知 agent 保守视为 reviewer（最低权限）。
 */

export type CallerRole = "primary" | "developer" | "architect" | "reviewer" | "goal-verify"

/** requireCaller 拒绝时的错误码 */
export const CALLER_NOT_AUTHORIZED = "CALLER_NOT_AUTHORIZED"

/** 工具 execute 上下文的最小可见面（ToolContext 的子集） */
export interface CallerContext {
  agent: string
  sessionID: string
}

/** session client 的最小可见面（goalClient 的子集） */
export interface CallerSessionClient {
  session: {
    get(input: { sessionID: string }): Promise<{ data?: { parentID?: string | null } }>
  }
}

const ROLE_BY_AGENT: Record<string, CallerRole> = {
  "dev-lifecycle": "primary",
  developer: "developer",
  architect: "architect",
  reviewer: "reviewer",
  "goal-verify": "goal-verify",
}

/**
 * 解析调用者角色：无 parentID（session 查询成功且 data 存在）→ primary；
 * 查询失败/无 data → 保守视为 reviewer（最低权限，fail-closed）；
 * 子会话按 agent 名映射；未知 agent → reviewer。
 */
export async function resolveCaller(ctx: CallerContext, client: CallerSessionClient): Promise<CallerRole> {
  let session
  try {
    session = await client.session.get({ sessionID: ctx.sessionID })
  } catch {
    return "reviewer"
  }
  if (!session?.data) return "reviewer"
  if (session.data.parentID) return ROLE_BY_AGENT[ctx.agent] ?? "reviewer"
  return "primary"
}

/**
 * 调用者门禁原语：角色在 allowedRoles 内返回 null（通过），
 * 否则返回含 CALLER_NOT_AUTHORIZED 码的错误消息（调用方组装 `{ code, message }` 响应）。
 */
export async function requireCaller(
  ctx: CallerContext,
  allowedRoles: CallerRole[],
  op: string,
  client: CallerSessionClient,
): Promise<string | null> {
  const role = await resolveCaller(ctx, client)
  if (allowedRoles.includes(role)) return null
  return `${CALLER_NOT_AUTHORIZED}: caller "${ctx.agent}" resolved as "${role}" is not allowed to call "${op}" (allowed: ${allowedRoles.join(", ")})`
}

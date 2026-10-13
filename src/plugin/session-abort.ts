/**
 * 用户中断（execution.interrupted reason=user）的会话标记。
 *
 * 独立模块避免循环依赖：continuation（消费）、server（事件写入）、goal 工具（resume 清除）共用。
 * 语义：标记只表示"最近一次用户中断尚未被任何后续动作消费"。
 * - 下一次续接检查消费它（暂停 goal）
 * - 用户新输入（inbox user）或显式 resume 也消费它（用户已重新掌控）
 */
const abortedSessions = new Set<string>()

export function markAborted(sessionID: string): void {
  abortedSessions.add(sessionID)
}

export function clearAborted(sessionID: string): void {
  abortedSessions.delete(sessionID)
}

export function clearAllAborted(): void {
  abortedSessions.clear()
}

/** 检查并消费中断标记（返回 true 表示"此会话最近被用户中断且未被消费"） */
export function consumeAborted(sessionID: string): boolean {
  if (!abortedSessions.has(sessionID)) return false
  abortedSessions.delete(sessionID)
  return true
}

/** Flow Record 引用：GitHub Parent Issue 承载 Flow 生命周期与阶段状态 */
export interface FlowRecordRef {
  parentIssueNumber: number
  slug: string
}

/** Task Record 引用：GitHub Sub Issue 承载 Task 生命周期与 TDD 证据 */
export interface TaskRecordRef {
  parentIssueNumber: number
  taskId: string
  issueNumber: number
}

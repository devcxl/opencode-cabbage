import type { FlowRun } from "../flowrun/types.js"
import { readFlowRunWithLock, writeFlowRunWithLock as ghWriteFlowRunWithLock } from "../flowrun/github.js"

// ─── 类型 ───

export interface MutateResult<R> {
  flowRun: FlowRun
  result: R
  shouldPersist: boolean
}

export type WriteResult<R> =
  | { ok: true; flowRun: FlowRun; result: R; persisted: boolean }
  | { ok: false; code: "PERSIST_CONFLICT" | "READ_FAILED"; message: string }

// ─── Keyed Mutex ───

/**
 * 按 key 隔离的互斥锁，用于单进程内串行化并发操作。
 *
 * 每个 key（parentIssueNumber）维护独立的 promise 链，
 * 相同 key 的操作依次执行，不同 key 的操作可以并行。
 */
class KeyedMutex {
  private locks = new Map<number, Promise<void>>()

  async runExclusive<T>(key: number, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve()
    let release: () => void
    const next = new Promise<void>(r => {
      release = r
    })
    this.locks.set(key, next)

    await prev
    try {
      return await fn()
    } finally {
      release!()
    }
  }
}

// ─── FlowBroker ───

/**
 * 单进程 broker，负责：
 * 1. 按 parentIssueNumber 的 keyed mutex 串行所有 FlowRun 写入
 * 2. read-modify-write 循环（乐观锁）
 * 3. 检测外部 body 变化 → PERSIST_CONFLICT
 *
 * 所有 FlowRun/Task/Evidence 写入必须经过 broker，不直接暴露 GitHub API。
 */
export class FlowBroker {
  private mutex = new KeyedMutex()

  /**
   * 将操作加入 keyed mutex 队列。
   *
   * 用于需要串行化但对 FlowRun 无影响的通用操作。
   */
  async enqueue<T>(parentIssueNumber: number, op: () => Promise<T>): Promise<T> {
    return this.mutex.runExclusive(parentIssueNumber, op)
  }

  /**
   * read-modify-write 循环：读取 FlowRun → 应用 handler 变更 → 乐观锁写回。
   *
   * - handler 返回 { flowRun, result, shouldPersist }
   * - shouldPersist=false 时跳过写入（如校验失败）
   * - 自动增加 revision 和时间戳
   * - body 不匹配时返回 PERSIST_CONFLICT
   */
  async writeFlowRunWithLock<R>(
    issueNumber: number,
    handler: (flowRun: FlowRun) => MutateResult<R>,
  ): Promise<WriteResult<R>> {
    return this.mutex.runExclusive(issueNumber, async () => {
      // ── 读取 ──
      const { flowRunResult, currentBody } = await readFlowRunWithLock(issueNumber)
      if (!flowRunResult.ok || currentBody === null) {
        return {
          ok: false as const,
          code: "READ_FAILED" as const,
          message: `Failed to read FlowRun from issue #${issueNumber}: ${flowRunResult.ok ? "missing body" : flowRunResult.code}`,
        }
      }

      // ── 修改 ──
      const { flowRun: updated, result, shouldPersist } = handler(flowRunResult.data)

      if (!shouldPersist) {
        return {
          ok: true as const,
          flowRun: flowRunResult.data,
          result,
          persisted: false,
        }
      }

      // ── 写入（乐观锁） ──
      updated.revision += 1
      updated.lastTickAt = new Date().toISOString()

      const writeResult = await ghWriteFlowRunWithLock(issueNumber, updated, currentBody)
      if (!writeResult.success) {
        return {
          ok: false as const,
          code: "PERSIST_CONFLICT" as const,
          message: writeResult.error ?? "Issue body changed since last read — external modification detected",
        }
      }

      return {
        ok: true as const,
        flowRun: updated,
        result,
        persisted: true,
      }
    })
  }
}

import type { Plugin } from "@opencode/plugin"

import {
  MAX_CONTINUATIONS,
  budgetReached,
  continuationPrompt,
  formatGoal,
  isBlockedReport,
  isDoneReport,
  mutateGoal,
  normalizeProfileModel,
  snapshotTokenTotal,
} from "./goal.js"
import type { GoalSessionProfile } from "./goal.js"
import type { GoalStore } from "./goal-store.js"
import { consumeAborted } from "./session-abort.js"
import { readIndex, updateFlowSession, removeFlowSession } from "../kernel/session-index.js"
import { getContextBlock, formatContextBlock } from "../kernel/context.js"

type Context = Plugin.Context

const continuationInFlight = new Set<string>()
const COMPACTION_THRESHOLD = 20
/** autoResume 跳过窗口：索引 30s 内更新过续接的 flow 不恢复（可能刚续接过，立即恢复会双发） */
const AUTO_RESUME_SKIP_WINDOW_MS = 30_000

/**
 * 子会话活动跟踪（V2 无 session.list/children 查询 API，改用事件溯源）：
 * - session.created（带 parentID）建立父子关系
 * - execution.started / retry.scheduled → busy；execution.succeeded/failed/interrupted → idle
 *
 * 局限：重启后内存清空，重启瞬间仍在运行且未再发事件的子会话不被识别（窗口小，可接受；
 * 子代理结果注入父会话会重新触发事件流）。V1 依赖实时查询，此为 V2 的降级替代。
 */
export class SessionActivityTracker {
  private parentOf = new Map<string, string>()
  private busy = new Set<string>()

  onCreated(sessionID: string, parentID?: string): void {
    if (parentID) this.parentOf.set(sessionID, parentID)
  }

  onBusy(sessionID: string): void {
    this.busy.add(sessionID)
  }

  onIdle(sessionID: string): void {
    this.busy.delete(sessionID)
  }

  hasWorkingChildren(sessionID: string): boolean {
    for (const [child, parent] of this.parentOf) {
      if (parent === sessionID && this.busy.has(child)) return true
    }
    return false
  }
}

/** 续接前注入会话快照的 agent/模型，防回落默认值（switch 为幂等调用） */
async function restoreSessionProfile(ctx: Context, sessionID: string, profile: GoalSessionProfile | undefined): Promise<void> {
  if (profile?.agent) {
    await ctx.session.switchAgent({ sessionID, agent: profile.agent }).catch((error) => {
      console.warn("[cabbage] switchAgent failed:", (error as Error | null)?.message ?? error)
    })
  }
  const model = normalizeProfileModel(profile?.model)
  if (model) {
    await ctx.session.switchModel({ sessionID, model }).catch((error) => {
      console.warn("[cabbage] switchModel failed:", (error as Error | null)?.message ?? error)
    })
  }
}

export async function queueContinuation(
  ctx: Context,
  store: GoalStore,
  sessionID: string,
  projectDir: string,
  tracker: SessionActivityTracker,
): Promise<void> {
  if (continuationInFlight.has(sessionID)) return
  continuationInFlight.add(sessionID)

  try {
    const decision = await mutateGoal(store, sessionID, async (goal): Promise<{
      goal: typeof goal
      value: { proceed: boolean; goal: NonNullable<typeof goal> } | null
    }> => {
      // 读改写与事件处理同锁串行，杜绝续接计数/状态被并发覆盖
      if (!goal || goal.status !== "active") return { goal, value: null }

      if (consumeAborted(sessionID)) {
        goal.status = "paused"
        goal.statusReason = "aborted by user"
        return { goal, value: null }
      }

      if (goal.continuationCount >= MAX_CONTINUATIONS) {
        goal.status = "paused"
        return { goal, value: null }
      }

      // 子会话活动闸：后台 subagent 仍 busy 时跳过续接（父会话轮次结束不代表任务静默）
      if (tracker.hasWorkingChildren(sessionID)) {
        return { goal, value: null }
      }

      // 尾部静默检查：轮次结束后仍可能有新 user 消息在途或 synthetic 尚未消费。
      // 最后一条是 user/synthetic、或最后 assistant 未完成（无 completed 时间）→ 跳过，
      // 等这些消息各自触发的新轮次结束事件重新驱动续接。
      const messages = await store.context(sessionID)
      if (!messages || messages.length === 0) return { goal, value: null }
      const lastMessage = messages[messages.length - 1]
      if (lastMessage?.type === "user" || lastMessage?.type === "synthetic") return { goal, value: null }
      let lastAssistant: (typeof messages)[number] | null = null
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        if (messages[i]?.type === "assistant") { lastAssistant = messages[i]; break }
      }
      if (!lastAssistant) return { goal, value: null }
      const completed = lastAssistant.time?.completed
      if (!(typeof completed === "number" && completed > 0)) return { goal, value: null }

      // [BLOCKED:] 阻塞报告 / [DONE:] 完成报告：agent 明确信号 → 暂停 goal 请用户/验证介入
      // （防空转烧 token；完成报告后应由 dev-lifecycle 派 goal-verify 做最终独立验证）。
      // resume 后首次 tick 豁免（statusReason='resumed' 被消费清除），
      // 否则 resume 会立即被上一轮旧报告再次暂停成死路。
      const assistantText = (lastAssistant.content ?? [])
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text!)
        .join("\n")
      const agentSignaled = isBlockedReport(assistantText) || isDoneReport(assistantText)
      if (agentSignaled) {
        if (goal.statusReason === "resumed") {
          goal.statusReason = ""
        } else {
          goal.status = "paused"
          goal.statusReason = isBlockedReport(assistantText) ? "blocked report" : "done report"
          return { goal, value: null }
        }
      } else if (goal.statusReason === "resumed") {
        // 豁免消费：resume 后的首次 tick 无论是否命中信号都清除 kickoff 标记。
        // 若不消费，首 tick 正常推进后 statusReason 残留，后续真实信号会被误豁免一次。
        goal.statusReason = ""
      }

      // Token 记账（会话累计快照）：used = 当前会话累计 − create 基线，单调不减。
      // cache.read 已含此前轮次付费 token，compaction 不做分段（预算为护栏非账单）。
      const tokensBaseline = goal.tokensBaseline ?? 0
      const tokensUsed = Math.max(
        goal.tokensUsed ?? 0,
        Math.max(0, snapshotTokenTotal(await store.sessionTokens(sessionID)) - tokensBaseline),
      )
      goal.tokensBaseline = tokensBaseline
      goal.tokensUsed = tokensUsed

      // token 预算护栏：达限即暂停（用户需提高预算后 resume，护栏优先）
      if (budgetReached(goal)) {
        goal.status = "paused"
        goal.statusReason = "token budget reached"
        return { goal, value: null }
      }

      // 先写计数后发 prompt：崩溃窗口只会"少发一次续接"（等下次轮次结束重试），
      // 不会"prompt 已发但计数未落盘"导致重启 autoResume 双发。
      goal.continuationCount++
      await updateFlowSession(projectDir, goal.parentIssueNumber, { lastContinuedAt: Date.now() }).catch(() => undefined)
      return { goal, value: { proceed: true, goal } }
    })

    if (!decision?.proceed || !decision.goal) return

    // abort 二次检查：轮次结束事件与 abort 事件并发时，避免对已中断的会话发出续接
    if (consumeAborted(sessionID)) {
      await mutateGoal(store, sessionID, async (goal) => {
        if (!goal) return { goal, value: null }
        goal.status = "paused"
        goal.continuationCount = Math.max(0, goal.continuationCount - 1)
        return { goal, value: null }
      }).catch(() => undefined)
      return
    }

    // 每 20 次续接主动 compact 会话历史（原生压缩；失败不阻塞续接）
    if (decision.goal.continuationCount > 0 && decision.goal.continuationCount % COMPACTION_THRESHOLD === 0) {
      try {
        await ctx.session.compact({ sessionID })
      } catch (err) {
        console.warn("[cabbage] compaction failed:", err)
      }
    }

    const contextBlock = await getContextBlock(projectDir)
    const contextText = contextBlock ? `${formatContextBlock(contextBlock)}\n\n` : ""

    try {
      await restoreSessionProfile(ctx, sessionID, decision.goal.sessionProfile)
      await ctx.session.synthetic({
        sessionID,
        text: contextText + continuationPrompt(decision.goal.parentIssueNumber),
      })
    } catch (err) {
      // 发送失败 → 回滚计数（尽力；回滚失败只会少一次续接，方向安全）
      console.error("[cabbage] continuation prompt failed, rolling back counter:", err)
      await mutateGoal(store, sessionID, async (goal) => {
        if (!goal) return { goal, value: null }
        goal.continuationCount = Math.max(0, goal.continuationCount - 1)
        return { goal, value: null }
      }).catch(() => undefined)
    }
  } catch (err) {
    console.error("[cabbage] continuation failed:", err)
  } finally {
    continuationInFlight.delete(sessionID)
  }
}

export async function autoResume(ctx: Context, store: GoalStore, projectDir: string): Promise<void> {
  const index = await readIndex(projectDir)

  for (const [parentIssueNumber, entry] of Object.entries(index.flows)) {
    // 重启双发防护：仅跳过"最近实际续接过"的 flow（lastContinuedAt 在发送续接时写入）。
    // 无 lastContinuedAt 的 entry 不跳过（resume 后重启、升级前的旧索引都走这条）。
    // 跳过时告警保证可观测。
    if (entry.lastContinuedAt && Date.now() - entry.lastContinuedAt < AUTO_RESUME_SKIP_WINDOW_MS) {
      console.warn(`[cabbage] auto-resume: skip #${parentIssueNumber} (continued ${Math.round((Date.now() - entry.lastContinuedAt) / 1000)}s ago; next turn end re-arms)`)
      continue
    }

    const { goal } = await store.read(entry.sessionID)
    // 索引一致性自愈：entry 指向的 goal 已是别的 Flow（edit 换 Flow 后旧 entry 残留/rebind 失败）→
    // 删除陈旧 entry，防止每次重启对同一会话重复续接
    if (goal && goal.parentIssueNumber !== Number(parentIssueNumber)) {
      console.warn(`[cabbage] auto-resume: index #${parentIssueNumber} points to goal of Flow #${goal.parentIssueNumber}; removing stale entry`)
      await removeFlowSession(projectDir, Number(parentIssueNumber))
      continue
    }
    // Goal 是唯一状态权威：非 active 或缺失即跳过（不回写索引）
    if (!goal || goal.status !== "active") continue

    try {
      await restoreSessionProfile(ctx, entry.sessionID, goal.sessionProfile)
      await ctx.session.synthetic({
        sessionID: entry.sessionID,
        text: `[auto-resume] Plugin restarted. Resuming previous goal:\n\n${formatGoal(goal)}\n\nContinue working.`,
      })
    } catch (err) {
      console.error("[cabbage] auto-resume failed:", err)
    }
  }
}

import { Rpc } from "@opencode/plugin"
import type { Plugin } from "@opencode/plugin"

export interface BuiltinGoalState {
  id: string
  objective: string
  status: "active" | "paused" | "complete"
  reason?: string
  rounds: number
  maxRounds: number
  stalls?: number
  boot: string
  updatedAt: number
}

/**
 * OpenCode v2.3+ 内置 `/goal` 插件 RPC 契约（与 @opencode/schema/goal `opencode.goal` 对齐）。
 * 只读读取会话内置 goal 状态与变更事件，不自建第二套状态存储或续接循环。
 */
export const OPENCODE_GOAL_RPC = Rpc.define({
  id: "opencode.goal",
  methods: {
    get: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: {
        anyOf: [{ type: "object" }, { type: "null" }],
      },
    },
  },
  events: {
    changed: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          goal: { anyOf: [{ type: "object" }, { type: "null" }] },
        },
        required: ["sessionID", "goal"],
      },
    },
  },
})

export interface BuiltinGoalReader {
  isGoalActive(sessionID: string): Promise<boolean>
  watchEvents(signal: AbortSignal): Promise<void>
}

type RpcCapableContext = Pick<Plugin.Context, "rpc">

export function createBuiltinGoalReader(ctx: Partial<RpcCapableContext>): BuiltinGoalReader {
  const cache = new Map<string, BuiltinGoalState | null>()

  function getClient() {
    if (typeof ctx.rpc !== "function") return null
    try {
      return ctx.rpc(OPENCODE_GOAL_RPC)
    } catch {
      return null
    }
  }

  return {
    async isGoalActive(sessionID: string): Promise<boolean> {
      if (cache.has(sessionID)) {
        return cache.get(sessionID)?.status === "active"
      }
      const client = getClient()
      if (!client) return false
      try {
        const goal = (await client.get({ sessionID })) as BuiltinGoalState | null
        cache.set(sessionID, goal ?? null)
        return goal?.status === "active"
      } catch {
        return false
      }
    },

    async watchEvents(signal: AbortSignal): Promise<void> {
      const client = getClient()
      if (!client?.events?.subscribe) return
      try {
        for await (const evt of client.events.subscribe("changed", { signal })) {
          const data = evt?.data as { sessionID?: unknown; goal?: BuiltinGoalState | null } | undefined
          if (typeof data?.sessionID === "string") {
            cache.set(data.sessionID, data.goal ?? null)
          }
        }
      } catch {
        // 宿主未启用 opencode.goal 或流被 abort 时静默降级
      }
    },
  }
}

export interface ExperimentalIdleResult {
  skipped: boolean
  reason: "background-running" | "builtin-goal-active" | "idle"
}

/**
 * 原生 `experimental.idle` 钩子处理（OpenCode v2.3+）：
 * - 后台仍有 subagent / shell / codemode / image 运行时跳过，等宿主唤醒下一轮
 * - 内置 `/goal` 激活时由内置循环接管续接，本插件不双发消息
 */
export async function handleExperimentalIdle(
  reader: Pick<BuiltinGoalReader, "isGoalActive">,
  event: { sessionID: string; background: ReadonlyArray<unknown> },
): Promise<ExperimentalIdleResult> {
  if (event.background.length > 0) {
    return { skipped: true, reason: "background-running" }
  }
  if (await reader.isGoalActive(event.sessionID)) {
    return { skipped: true, reason: "builtin-goal-active" }
  }
  return { skipped: false, reason: "idle" }
}

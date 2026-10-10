import { vi } from "vitest"
import path from "node:path"

import { setupCabbage } from "../../src/plugin/server.js"
import { clearAllAborted } from "../../src/plugin/session-abort.js"

export const COMPLETED_ASSISTANT = {
  type: "assistant",
  id: "msg-1",
  time: { created: 1, completed: 2 },
  agent: "dev-lifecycle",
  content: [{ type: "text", text: "工作完成。" }],
}

export interface SessionState {
  parentID?: string
  metadata: Record<string, unknown>
  tokens?: unknown
  agent?: string
  messages: Array<Record<string, unknown>>
}

/** 可控事件流：测试通过 push() 注入 V2 事件 */
export function makeEventStream() {
  const queue: unknown[] = []
  let resolver: ((v: IteratorResult<unknown>) => void) | null = null
  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<unknown>> {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false })
          return new Promise((resolve) => { resolver = resolve })
        },
      }
    },
  }
  return {
    iterable,
    push(evt: unknown) {
      if (resolver) {
        const r = resolver
        resolver = null
        r({ value: evt, done: false })
      } else {
        queue.push(evt)
      }
    },
  }
}

export interface Harness {
  ctx: Record<string, unknown>
  sessions: Map<string, SessionState>
  sessionApi: Record<string, ReturnType<typeof vi.fn>>
  sessionHooks: Map<string, (event: Record<string, unknown>) => Promise<void> | void>
  skillAdds: Array<Record<string, unknown>>
  commandAdds: Array<Record<string, unknown>>
  toolAdds: Array<Record<string, unknown>>
  agentEditor: {
    get: (id: string) => Record<string, unknown> | undefined
    list: () => Array<{ id: string }>
    update: (id: string, apply: (a: Record<string, unknown>) => void) => void
    remove: (id: string) => void
    default: (id: string | undefined) => void
  }
  eventStream: ReturnType<typeof makeEventStream>
  cleanup: () => void
}

/** 全量 ctx mock：驱动真实 setupCabbage，收集各域的注册产物 */
export async function makeHarness(tmpDir: string, packageRoot: string): Promise<Harness> {
  // 测试隔离：清空中断标记等模块级会话状态；内置 cabbage CLI 释放到本测试的临时目录
  clearAllAborted()
  process.env.CABBAGE_CLI_DIR = path.join(tmpDir, "cabbage-cli")
  const sessions = new Map<string, SessionState>()
  sessions.set("sess-1", { metadata: {}, messages: [structuredClone(COMPLETED_ASSISTANT)] })

  const eventStream = makeEventStream()
  const sessionHooks = new Map<string, (event: Record<string, unknown>) => Promise<void> | void>()
  const skillAdds: Array<Record<string, unknown>> = []
  const commandAdds: Array<Record<string, unknown>> = []
  const toolAdds: Array<Record<string, unknown>> = []
  const agentRegistrations = new Map<string, Record<string, unknown>>()

  const sessionApi = {
    get: vi.fn(async ({ sessionID }: { sessionID: string }) => {
      const s = sessions.get(sessionID) ?? { metadata: {}, messages: [] }
      return { parentID: s.parentID, metadata: structuredClone(s.metadata), tokens: s.tokens, agent: s.agent }
    }),
    update: vi.fn(async ({ sessionID, metadata }: { sessionID: string; metadata: Record<string, unknown> }) => {
      const s = sessions.get(sessionID) ?? { metadata: {}, messages: [] }
      s.metadata = structuredClone(metadata)
      sessions.set(sessionID, s)
    }),
    context: vi.fn(async ({ sessionID }: { sessionID: string }) => {
      const s = sessions.get(sessionID) ?? { metadata: {}, messages: [] }
      return structuredClone(s.messages)
    }),
    synthetic: vi.fn(async ({ sessionID, text }: { sessionID: string; text: string }) => {
      const s = sessions.get(sessionID) ?? { metadata: {}, messages: [] }
      s.messages.push({ type: "synthetic", id: `msg-syn-${s.messages.length}`, time: { created: Date.now() }, text })
      sessions.set(sessionID, s)
      return { id: "msg-syn", sessionID, type: "synthetic" }
    }),
    switchAgent: vi.fn(async () => undefined),
    switchModel: vi.fn(async () => undefined),
    compact: vi.fn(async () => ({ id: "msg-compact" })),
    hook: vi.fn(async (name: string, callback: (event: Record<string, unknown>) => Promise<void> | void) => {
      sessionHooks.set(name, callback)
      return { dispose: async () => undefined }
    }),
  }

  const agentEditor: Harness["agentEditor"] = {
    get: (id: string) => agentRegistrations.get(id),
    list: () => [...agentRegistrations.keys()].map((id) => ({ id })),
    update: (id: string, apply: (a: Record<string, unknown>) => void) => {
      const existing = agentRegistrations.get(id) ?? { id }
      agentRegistrations.set(id, existing)
      apply(existing)
    },
    remove: (id: string) => {
      agentRegistrations.delete(id)
    },
    default: () => undefined,
  }

  const ctx = {
    location: { directory: tmpDir, project: { id: "p", directory: tmpDir, canonical: tmpDir } },
    session: sessionApi,
    skill: {
      transform: vi.fn(async (cb: (editor: Record<string, unknown>) => void) => {
        cb({ add: (s: Record<string, unknown>) => skillAdds.push(s), list: () => [], get: () => undefined, update: () => undefined, remove: () => undefined })
        return { dispose: async () => undefined }
      }),
    },
    command: {
      transform: vi.fn(async (cb: (editor: Record<string, unknown>) => void) => {
        cb({ add: (c: Record<string, unknown>) => commandAdds.push(c) })
        return { dispose: async () => undefined }
      }),
    },
    agent: {
      transform: vi.fn(async (cb: (editor: Harness["agentEditor"]) => void) => {
        cb(agentEditor)
        return { dispose: async () => undefined }
      }),
    },
    tool: {
      transform: vi.fn(async (cb: (editor: Record<string, unknown>) => void) => {
        cb({ add: (t: Record<string, unknown>) => toolAdds.push(t), list: () => [], get: () => undefined, namespace: () => undefined, update: () => undefined, remove: () => undefined })
        return { dispose: async () => undefined }
      }),
    },
    shell: {
      hook: vi.fn(async () => ({ dispose: async () => undefined })),
    },
    event: {
      subscribe: vi.fn(() => eventStream.iterable),
    },
  }

  const cleanup = await setupCabbage(ctx as never, packageRoot)
  return { ctx, sessions, sessionApi, sessionHooks, skillAdds, commandAdds, toolAdds, agentEditor, eventStream, cleanup }
}

/** 等待条件达成（轮询，避免固定延时抖动） */
export async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout")
    await new Promise((r) => setTimeout(r, 10))
  }
}

export async function flush(ms = 60): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

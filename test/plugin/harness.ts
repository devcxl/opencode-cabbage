import { vi } from "vitest"
import { setupCabbage } from "../../src/plugin/server.js"

export interface SessionState {
  parentID?: string
  metadata: Record<string, unknown>
  tokens?: unknown
  agent?: string
  messages: Array<Record<string, unknown>>
}

export interface Harness {
  ctx: Record<string, unknown>
  sessions: Map<string, SessionState>
  builtinGoals: Map<string, Record<string, unknown> | null>
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
  cleanup: () => void
}

export interface HarnessOptions {
  /** false 模拟「宿主忽略缺失 id 的 update」（不采用 upsert 语义），用于注册校验护栏测试 */
  agentUpsert?: boolean
}

/** 全量 ctx mock：驱动真实 setupCabbage，收集各域的注册产物 */
export async function makeHarness(tmpDir: string, packageRoot: string, options: HarnessOptions = {}): Promise<Harness> {
  const agentUpsert = options.agentUpsert !== false
  const sessions = new Map<string, SessionState>()
  sessions.set("sess-1", { metadata: {}, messages: [] })
  const builtinGoals = new Map<string, Record<string, unknown> | null>()

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
    switchAgent: vi.fn(async () => undefined),
    switchModel: vi.fn(async () => undefined),
    prompt: vi.fn(async () => undefined),
    hook: vi.fn(async (name: string, callback: (event: Record<string, unknown>) => Promise<void> | void) => {
      sessionHooks.set(name, callback)
      return { dispose: async () => undefined }
    }),
  }

  const agentEditor: Harness["agentEditor"] = {
    get: (id: string) => agentRegistrations.get(id),
    list: () => [...agentRegistrations.keys()].map((id) => ({ id })),
    update: (id: string, apply: (a: Record<string, unknown>) => void) => {
      if (!agentUpsert && !agentRegistrations.has(id)) return
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
    rpc: vi.fn(() => ({
      get: vi.fn(async ({ sessionID }: { sessionID: string }) => builtinGoals.get(sessionID) ?? null),
      events: {
        subscribe: vi.fn(async function* () {
          // 保持空异步流，直至 signal abort
        }),
      },
    })),
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
      list: vi.fn(async () => ({ location: { directory: tmpDir }, data: [...agentRegistrations.values()] })),
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
  }

  const cleanup = await setupCabbage(ctx as never, packageRoot)
  return { ctx, sessions, builtinGoals, sessionApi, sessionHooks, skillAdds, commandAdds, toolAdds, agentEditor, cleanup }
}

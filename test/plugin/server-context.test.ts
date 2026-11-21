import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { buildFirstUserInjection } from "../../src/plugin/server.js"
import { resetContextCache, CONTEXT_MARKER } from "../../src/kernel/context.js"
import { makeHarness } from "./harness.js"
import type { Harness } from "./harness.js"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

let tmpDir: string
let harness: Harness

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "cabbage-server-context-"))
  resetContextCache()
  process.env.CABBAGE_SKILLS_DIR = path.join(tmpDir, "skills")
  harness = await makeHarness(tmpDir, projectRoot)
})

afterEach(async () => {
  harness.cleanup()
  resetContextCache()
  delete process.env.CABBAGE_SKILLS_DIR
  await rm(tmpDir, { recursive: true, force: true })
})

describe("setup — 资产与原生钩子注册", () => {
  it("注册全部 flow skills / flow-* 避让命令 / 纯 TS cabbage 工具", () => {
    const skillIds = harness.skillAdds.map((s) => s.id)
    expect(skillIds).toContain("flow-setup")
    expect(skillIds).toContain("flow-review")
    expect(skillIds.length).toBe(12)

    expect(harness.commandAdds.map((c) => c.name).sort()).toEqual(
      ["flow-code", "flow-design", "flow-release", "flow-requirements", "flow-review", "flow-setup", "flow-tasks"].sort(),
    )

    const toolNames = harness.toolAdds.map((t) => t.name)
    expect(toolNames).toEqual(["cabbage"])
    const cabbageTool = harness.toolAdds.find((t) => t.name === "cabbage")!
    expect((cabbageTool.options as { permission?: string })?.permission).toBe("cabbage")

    expect(harness.sessionHooks.has("context")).toBe(true)
    expect(harness.sessionHooks.has("experimental.idle")).toBe(true)
  })
})

describe("buildFirstUserInjection — 注入决策", () => {
  const bootstrap = "<EXTREMELY_IMPORTANT>bootstrap content</EXTREMELY_IMPORTANT>"
  const contextBlock = {
    path: "/tmp/CONTEXT.md",
    mtimeMs: 1,
    digest: "abc123",
    terms: ["Terms"],
    block: `## Project Context (auto-injected)\n<!-- ${CONTEXT_MARKER} -->\n...`,
  }

  it("Primary（内置 goal 激活或 @dev-lifecycle）注入 bootstrap + context", () => {
    const text = buildFirstUserInjection({ hasGoal: true, isSubAgent: false, contextBlock, bootstrap })
    expect(text).toContain(bootstrap)
    expect(text).toContain(CONTEXT_MARKER)
  })

  it("Primary 无 CONTEXT.md 时仅注入 bootstrap", () => {
    const text = buildFirstUserInjection({ hasGoal: true, isSubAgent: false, contextBlock: null, bootstrap })
    expect(text).toBe(bootstrap)
  })

  it("子 agent 注入 context 但不注入 bootstrap", () => {
    const text = buildFirstUserInjection({ hasGoal: false, isSubAgent: true, contextBlock, bootstrap })
    expect(text).toContain(CONTEXT_MARKER)
    expect(text).not.toContain("EXTREMELY_IMPORTANT")
  })

  it("goal 未激活且非子 agent → 不注入", () => {
    const text = buildFirstUserInjection({ hasGoal: false, isSubAgent: false, contextBlock, bootstrap })
    expect(text).toBeNull()
  })

  it("子 agent 无 CONTEXT.md → 不注入", () => {
    const text = buildFirstUserInjection({ hasGoal: false, isSubAgent: true, contextBlock: null, bootstrap })
    expect(text).toBeNull()
  })
})

describe("context hook — OpenCode v2.3 内置 /goal 与编排器注入", () => {
  const makeSystemEvent = (sessionID = "sess-1", agent = "build") => ({
    sessionID,
    agent,
    system: [] as Array<{ type: string; text: string }>,
  })

  it("内置 opencode.goal 为 active 时注入 bootstrap + Project Context 块", async () => {
    await writeFile(path.join(tmpDir, "CONTEXT.md"), "## Terms\n- user\n", "utf8")
    harness.builtinGoals.set("sess-1", { id: "g1", objective: "Ship flow", status: "active" })
    const event = makeSystemEvent("sess-1", "build")
    await harness.sessionHooks.get("context")!(event)
    const text = event.system.map((p) => p.text).join("\n")
    expect(text).toContain("EXTREMELY_IMPORTANT")
    expect(text).toContain("Project Context (auto-injected)")
    expect(text).toContain(CONTEXT_MARKER)
  })

  it("agent 为 dev-lifecycle 时（即使未开启 /goal）也注入 bootstrap + Project Context 块", async () => {
    await writeFile(path.join(tmpDir, "CONTEXT.md"), "## Terms\n- flow\n", "utf8")
    const event = makeSystemEvent("sess-1", "dev-lifecycle")
    await harness.sessionHooks.get("context")!(event)
    const text = event.system.map((p) => p.text).join("\n")
    expect(text).toContain("EXTREMELY_IMPORTANT")
    expect(text).toContain(CONTEXT_MARKER)
  })

  it("子 agent 注入 Project Context 块（无 bootstrap）", async () => {
    await writeFile(path.join(tmpDir, "CONTEXT.md"), "## Terms\n- agent\n", "utf8")
    harness.sessions.set("sess-child", { parentID: "sess-1", metadata: {}, messages: [] })
    const event = makeSystemEvent("sess-child", "developer")
    await harness.sessionHooks.get("context")!(event)
    const text = event.system.map((p) => p.text).join("\n")
    expect(text).toContain("Project Context (auto-injected)")
    expect(text).toContain(CONTEXT_MARKER)
    expect(text).not.toContain("EXTREMELY_IMPORTANT")
  })

  it("内置 goal 未激活、非 dev-lifecycle 且非子 agent → 不注入", async () => {
    await writeFile(path.join(tmpDir, "CONTEXT.md"), "## Terms\n- user\n", "utf8")
    const event = makeSystemEvent("sess-1", "build")
    await harness.sessionHooks.get("context")!(event)
    expect(event.system).toHaveLength(0)
  })

  it("system 已含注入 marker 时不重复注入（幂等）", async () => {
    harness.builtinGoals.set("sess-1", { id: "g1", objective: "Ship flow", status: "active" })
    const event = makeSystemEvent("sess-1", "dev-lifecycle")
    event.system.push({ type: "text", text: `already injected <!-- ${CONTEXT_MARKER} -->` })
    await harness.sessionHooks.get("context")!(event)
    expect(event.system).toHaveLength(1)
  })

  it("experimental.idle 钩子可安全响应后台任务与空闲态", async () => {
    const idleHook = harness.sessionHooks.get("experimental.idle")!
    await expect(idleHook({ sessionID: "sess-1", background: [{ kind: "subagent" }] })).resolves.toBeUndefined()
    await expect(idleHook({ sessionID: "sess-1", background: [] })).resolves.toBeUndefined()
  })
})

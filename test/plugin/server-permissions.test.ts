import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { buildAgentRules, buildAgentPayloads } from "../../src/plugin/agents.js"
import type { AgentEntry } from "../../src/plugin/agents.js"
import { makeHarness } from "./harness.js"
import type { Harness } from "./harness.js"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")

const entry = (overrides: Partial<AgentEntry>): AgentEntry => ({
  key: "test-agent",
  prompt: "system prompt",
  ...overrides,
})

describe("buildAgentRules — V1 permission/tools → V2 规则数组", () => {
  it("permission 映射保持声明序（V2 最后匹配优先）", () => {
    const rules = buildAgentRules(entry({
      permission: {
        bash: { "*": "deny", "git status": "allow", "git push*": "deny" },
      },
    }), "")
    expect(rules).toEqual([
      { action: "bash", resource: "*", effect: "deny" },
      { action: "bash", resource: "git status", effect: "allow" },
      { action: "bash", resource: "git push*", effect: "deny" },
    ])
  })

  it("skill 隔离规则原样转换", () => {
    const rules = buildAgentRules(entry({
      permission: { skill: { "*": "deny", "flow-design": "allow", "flow-tasks": "allow" } },
    }), "")
    expect(rules).toEqual([
      { action: "skill", resource: "*", effect: "deny" },
      { action: "skill", resource: "flow-design", effect: "allow" },
      { action: "skill", resource: "flow-tasks", effect: "allow" },
    ])
  })

  it("<profile-test-command> 占位符渲染为 Profile 测试命令首 token", () => {
    const rules = buildAgentRules(entry({
      permission: { bash: { "<profile-test-command> *": "allow" } },
    }), "npm")
    expect(rules).toEqual([{ action: "bash", resource: "npm *", effect: "allow" }])
  })

  it("Profile 未配置测试命令时删除占位规则（不渲染成 *）", () => {
    const rules = buildAgentRules(entry({
      permission: { bash: { "*": "deny", "<profile-test-command> *": "allow" } },
    }), "")
    expect(rules).toEqual([{ action: "bash", resource: "*", effect: "deny" }])
  })

  it("tools 禁用映射为 deny 规则并置于末尾；write 与 edit 共用 edit action", () => {
    const rules = buildAgentRules(entry({
      tools: { read: true, bash: true, write: false, edit: false },
      permission: { bash: { "*": "deny", "npm test*": "allow" } },
    }), "")
    expect(rules).toEqual([
      { action: "bash", resource: "*", effect: "deny" },
      { action: "bash", resource: "npm test*", effect: "allow" },
      { action: "edit", resource: "*", effect: "deny" },
    ])
  })

  it("bash:false 的 deny 追加在 permission 规则之后（工具整体禁用不可被白名单恢复）", () => {
    const rules = buildAgentRules(entry({
      tools: { read: true, bash: false, write: false, edit: false },
      permission: { bash: { "gh pr view": "allow" } },
    }), "")
    expect(rules).toEqual([
      { action: "bash", resource: "gh pr view", effect: "allow" },
      { action: "bash", resource: "*", effect: "deny" },
      { action: "edit", resource: "*", effect: "deny" },
    ])
  })
})

describe("buildAgentPayloads — 资产加载与字段装配", () => {
  const payloads = buildAgentPayloads(path.join(projectRoot, "assets", "agents"), "npm")

  it("加载全部 6 个流程 agent", () => {
    expect(payloads.map((p) => p.key).sort()).toEqual(
      ["architect", "dev-lifecycle", "developer", "goal-verify", "researcher", "reviewer"].sort(),
    )
  })

  it("payload 含 system 与 V2 字段（无 V1 prompt/permission 结构）", () => {
    const architect = payloads.find((p) => p.key === "architect")!
    expect(typeof architect.fields.system).toBe("string")
    expect((architect.fields.system as string).length).toBeGreaterThan(100)
    expect(architect.fields.mode).toBe("subagent")
    expect(architect.fields.color).toBe("#00bcd4")
    expect(architect.fields.prompt).toBeUndefined()
    expect(architect.fields.permission).toBeUndefined()
    const rules = architect.fields.permissions as Array<{ action: string; resource: string; effect: string }>
    expect(rules).toContainEqual({ action: "skill", resource: "flow-design", effect: "allow" })
    expect(rules).toContainEqual({ action: "edit", resource: "docs/**", effect: "allow" })
  })

  it("goal-verify 的 tools 禁用转换为 edit deny", () => {
    const goalVerify = payloads.find((p) => p.key === "goal-verify")!
    const rules = goalVerify.fields.permissions as Array<{ action: string; resource: string; effect: string }>
    expect(rules).toContainEqual({ action: "edit", resource: "*", effect: "deny" })
  })
})

describe("server agent transform — goal 权限装配", () => {
  let tmpDir: string
  let harness: Harness

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cabbage-server-perm-"))
    process.env.CABBAGE_SKILLS_DIR = path.join(tmpDir, "skills")
    harness = await makeHarness(tmpDir, projectRoot)
  })

  afterEach(async () => {
    harness.cleanup()
    delete process.env.CABBAGE_SKILLS_DIR
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("注入缺失的流程 agent（system/mode/color/permissions 装配）", () => {
    const architect = harness.agentEditor.get("architect")
    expect(architect).toBeDefined()
    expect(typeof architect!.system).toBe("string")
    expect(architect!.mode).toBe("subagent")
    const rules = architect!.permissions as Array<{ action: string; resource: string; effect: string }>
    expect(rules).toContainEqual({ action: "skill", resource: "flow-design", effect: "allow" })
  })

  it("goal 工具授权：仅 dev-lifecycle / goal-verify 得到 allow，其余一律 deny", () => {
    const goalRule = (id: string) => {
      const agent = harness.agentEditor.get(id)
      const rules = (agent?.permissions ?? []) as Array<{ action: string; resource: string; effect: string }>
      return rules.filter((r) => r.action === "goal")
    }
    expect(goalRule("dev-lifecycle")).toEqual([{ action: "goal", resource: "*", effect: "allow" }])
    expect(goalRule("goal-verify")).toEqual([{ action: "goal", resource: "*", effect: "allow" }])
    expect(goalRule("architect")).toEqual([{ action: "goal", resource: "*", effect: "deny" }])
    expect(goalRule("developer")).toEqual([{ action: "goal", resource: "*", effect: "deny" }])
  })

  it("cabbage 工具授权：仅 dev-lifecycle 得到 allow，其余一律 deny", () => {
    const cabbageRule = (id: string) => {
      const agent = harness.agentEditor.get(id)
      const rules = (agent?.permissions ?? []) as Array<{ action: string; resource: string; effect: string }>
      return rules.filter((r) => r.action === "cabbage")
    }
    expect(cabbageRule("dev-lifecycle")).toEqual([{ action: "cabbage", resource: "*", effect: "allow" }])
    expect(cabbageRule("goal-verify")).toEqual([{ action: "cabbage", resource: "*", effect: "deny" }])
    expect(cabbageRule("architect")).toEqual([{ action: "cabbage", resource: "*", effect: "deny" }])
    expect(cabbageRule("developer")).toEqual([{ action: "cabbage", resource: "*", effect: "deny" }])
  })

  it("用户已存在的 agent 不被覆盖字段，但补齐 goal deny 规则", () => {
    // 通过 editor.update 直接模拟用户级 agent（在 transform 之前已存在）
    const editor = harness.agentEditor
    editor.update("existing-user-agent", (a) => {
      a.name = "existing-user-agent"
      a.system = "user prompt"
      a.permissions = [{ action: "bash", resource: "*", effect: "allow" }]
    })
    // 再次触发 transform（重新应用 goal 规则）
    const transformCb = (harness.ctx.agent as { transform: { mock: { calls: Array<[unknown]> } } }).transform.mock.calls[0]![0] as (e: unknown) => void
    transformCb(editor)

    const agent = editor.get("existing-user-agent")!
    expect(agent.system).toBe("user prompt")
    const rules = agent.permissions as Array<{ action: string; resource: string; effect: string }>
    expect(rules).toContainEqual({ action: "bash", resource: "*", effect: "allow" })
    expect(rules.filter((r) => r.action === "goal")).toEqual([{ action: "goal", resource: "*", effect: "deny" }])
  })

  it("重复应用 transform 不重复追加 goal 规则（幂等）", () => {
    const editor = harness.agentEditor
    const transformCb = (harness.ctx.agent as { transform: { mock: { calls: Array<[unknown]> } } }).transform.mock.calls[0]![0] as (e: unknown) => void
    transformCb(editor)
    transformCb(editor)

    const rules = (editor.get("architect")!.permissions ?? []) as Array<{ action: string }>
    expect(rules.filter((r) => r.action === "goal")).toHaveLength(1)
  })

  it("注册的 goal 工具带 permission 选项与 JSON Schema 输入", () => {
    const goalTool = harness.toolAdds.find((t) => t.name === "goal")!
    expect((goalTool.options as { permission?: string }).permission).toBe("goal")
    const input = goalTool.input as { type?: string; required?: string[] }
    expect(input.type).toBe("object")
    expect(input.required).toEqual(["op"])
  })
})

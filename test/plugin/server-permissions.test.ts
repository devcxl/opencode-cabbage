import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { buildAgentPayloads, type AgentRule } from "../../src/plugin/agents.js"
import { matchPermissionRules } from "../../src/kernel/permission.js"
import { makeHarness } from "./harness.js"
import type { Harness } from "./harness.js"

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const agentsDir = path.join(projectRoot, "assets", "agents")

describe("buildAgentPayloads — 资产加载与原生 permissions 装配", () => {
  const payloads = buildAgentPayloads(agentsDir, "npm test -- {testPaths}")

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
    const rules = architect.fields.permissions as AgentRule[]
    expect(rules).toContainEqual({ action: "skill", resource: "flow-design", effect: "allow" })
    expect(rules).toContainEqual({ action: "edit", resource: "docs/**", effect: "allow" })
  })

  it("goal-verify 原生 permissions 含 edit deny（只读验证者）", () => {
    const goalVerify = payloads.find((p) => p.key === "goal-verify")!
    const rules = goalVerify.fields.permissions as AgentRule[]
    expect(rules).toContainEqual({ action: "edit", resource: "*", effect: "deny" })
  })

  it("Profile 测试命令渲染为固定前缀（不生成首 token 宽通配）", () => {
    for (const key of ["developer", "goal-verify"]) {
      const rules = payloads.find((p) => p.key === key)!.fields.permissions as AgentRule[]
      expect(rules, key).toContainEqual({ action: "bash", resource: "npm test -- *", effect: "allow" })
      expect(rules.some((r) => r.action === "bash" && r.resource === "npm*"), key).toBe(false)
    }
  })

  it("Profile 未配置测试命令时丢弃占位规则（不渲染成 `*` 放行）", () => {
    const emptyProfilePayloads = buildAgentPayloads(agentsDir, "")
    for (const key of ["developer", "goal-verify"]) {
      const rules = emptyProfilePayloads.find((p) => p.key === key)!.fields.permissions as AgentRule[]
      expect(rules.some((r) => r.resource.includes("<profile-test-command>")), key).toBe(false)
      expect(rules.some((r) => r.action === "bash" && r.resource === "*" && r.effect === "allow"), key).toBe(false)
    }
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

describe("server agent transform — Profile 测试命令白名单收敛（#137）", () => {
  let tmpDir: string
  let harness: Harness

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cabbage-server-testcmd-"))
    process.env.CABBAGE_SKILLS_DIR = path.join(tmpDir, "skills")
    await writeFile(path.join(tmpDir, "AGENTS.md"), "## Project Profile\n\n- test command: `npm test -- {testPaths}`\n", "utf8")
    harness = await makeHarness(tmpDir, projectRoot)
  })

  afterEach(async () => {
    harness.cleanup()
    delete process.env.CABBAGE_SKILLS_DIR
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("developer 注册载荷使用 Profile 测试命令安全前缀，提权命令被拒绝", () => {
    const rules = (harness.agentEditor.get("developer")?.permissions ?? []) as AgentRule[]
    const bash = rules.filter((r) => r.action === "bash")
    expect(bash).toContainEqual({ action: "bash", resource: "npm test -- *", effect: "allow" })
    expect(matchPermissionRules(bash, "npm test -- test/plugin/server-permissions.test.ts", "bash")).toBe("allow")
    for (const cmd of ["npm install", "npm run build", "npm publish", "npm exec -- rm -rf /"]) {
      expect(matchPermissionRules(bash, cmd, "bash"), `${cmd} 应被拒绝`).toBe("deny")
    }
  })
})

describe("server agent 注册校验护栏 — 宿主 upsert 语义变化可观测", () => {
  let tmpDir: string
  let warnSpy: ReturnType<typeof vi.spyOn>
  let harness: Harness

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), "cabbage-agent-guard-"))
    process.env.CABBAGE_SKILLS_DIR = path.join(tmpDir, "skills")
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    // 模拟宿主忽略「缺失 id 的 update」：注册校验必须报出缺失告警，而非静默通过
    harness = await makeHarness(tmpDir, projectRoot, { agentUpsert: false })
  })

  afterEach(async () => {
    harness.cleanup()
    warnSpy.mockRestore()
    delete process.env.CABBAGE_SKILLS_DIR
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("缺失 agent 未进入宿主注册表时输出告警（含缺失清单）", () => {
    const messages = warnSpy.mock.calls.map((call) => call.map(String).join(" ")).join("\n")
    expect(messages).toContain("agent registration incomplete")
    expect(messages).toContain("dev-lifecycle")
  })
})

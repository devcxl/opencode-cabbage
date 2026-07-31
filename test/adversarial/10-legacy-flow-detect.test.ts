/**
 * 对抗测试 #10 — 旧 FlowRun 混入：
 * 旧架构（cabbage-flow-run cabinet）Issue 必须被检测并阻断（LEGACY_FLOW_DETECTED），
 * 提示不迁移（不自动读取/改写旧状态）。
 */
import { describe, it, expect, afterEach } from "vitest"
import { containsLegacyMarker, detectLegacyFlowRun } from "../../src/kernel/legacy.js"
import { createFlow, setFlowGhExecutor } from "../../src/kernel/flow.js"

const LEGACY_BODY =
  "<!-- cabbage-flow-run:start -->\n```json\n{\"flowRunId\": \"fr-123\", \"stage\": \"code\"}\n```\n<!-- cabbage-flow-run:end -->"

afterEach(() => {
  setFlowGhExecutor(null)
})

describe("adversarial #10 — legacy FlowRun 必须被检测且不迁移", () => {
  it("containsLegacyMarker 需同时命中 start/end 标记（单边 marker 不算）", () => {
    expect(containsLegacyMarker(LEGACY_BODY)).toBe(true)
    expect(containsLegacyMarker("<!-- cabbage-flow-run:start --> only")).toBe(false)
    expect(containsLegacyMarker("<!-- cabbage-flow-run:end --> only")).toBe(false)
  })

  it("detectLegacyFlowRun 命中旧 FlowRun 并提取 flowRunId", async () => {
    const gh = async () => ({ stdout: LEGACY_BODY, stderr: "" })
    const result = await detectLegacyFlowRun(12, gh)
    expect(result).toEqual({ legacy: true, flowRunId: "fr-123" })
  })

  it("create-flow 绑定旧 Issue → LEGACY_FLOW_DETECTED（不迁移）", async () => {
    setFlowGhExecutor(async (args) => {
      if (args.includes("issue view")) return { stdout: LEGACY_BODY, stderr: "" }
      throw new Error(`unexpected flow gh: ${args}`)
    })
    const result = await createFlow({ projectDir: ".", title: "x", sessionID: "s", parentIssueNumber: 12 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("LEGACY_FLOW_DETECTED")
      expect(result.message).toMatch(/old plugin|0\.x|not auto-migrate/i)
    }
  })

  it("新架构 Issue 不受影响（legacy false）", async () => {
    const gh = async () => ({ stdout: "## Stages\n\n- [ ] requirements\n- [ ] design", stderr: "" })
    const result = await detectLegacyFlowRun(12, gh)
    expect(result).toEqual({ legacy: false })
  })
})

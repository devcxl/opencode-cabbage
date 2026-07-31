/**
 * 旧 FlowRun 检测（spec §11.2，自 flowrun/github.ts 只读部分迁移）。
 * 不迁移、不读取旧状态——只判断 Issue body 是否仍是旧架构的 FlowRun cabinet。
 */
import { gh as ghCli } from "../util/gh.js"

/** 旧 FlowRun cabinet 标记（flowrun/types.ts 同款） */
export const CABINET_START_MARKER = "<!-- cabbage-flow-run:start -->"
export const CABINET_END_MARKER = "<!-- cabbage-flow-run:end -->"

export type LegacyFlowDetection = { legacy: true; flowRunId?: string } | { legacy: false }

/** Issue body 同时含 start/end 标记 → 判定为旧架构 FlowRun（不自动迁移） */
export function containsLegacyMarker(body: string): boolean {
  return body.includes(CABINET_START_MARKER) && body.includes(CABINET_END_MARKER)
}

/** 从 cabinet JSON 块提取 flowRunId；缺失返回 null */
function extractFlowRunId(body: string): string | null {
  const match = /"flowRunId"\s*:\s*"([^"]+)"/.exec(body)
  return match ? match[1] : null
}

/**
 * 检测指定 Issue 是否为旧架构 FlowRun。
 * @param ghFn gh 执行器（测试可注入；默认宿主 gh CLI）
 */
export async function detectLegacyFlowRun(
  parentIssueNumber: number,
  ghFn: (args: string) => Promise<{ stdout: string; stderr: string }> = ghCli,
): Promise<LegacyFlowDetection> {
  try {
    const { stdout } = await ghFn(`issue view ${parentIssueNumber} --json body --jq .body`)
    if (!containsLegacyMarker(stdout)) return { legacy: false }
    const flowRunId = extractFlowRunId(stdout)
    return flowRunId ? { legacy: true, flowRunId } : { legacy: true }
  } catch {
    return { legacy: false }
  }
}

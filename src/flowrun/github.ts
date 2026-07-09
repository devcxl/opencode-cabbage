import { gh } from "../util/gh.js"
import { escapeShellArg } from "../util/shell.js"
import {
  type FlowRun,
  CABINET_START_MARKER,
  CABINET_END_MARKER,
  CURRENT_SCHEMA_VERSION,
} from "./types.js"
import { validateFlowRun } from "./validator.js"

function buildFlowRunBlock(flowRun: FlowRun): string {
  const json = JSON.stringify(flowRun, null, 2)
  return `${CABINET_START_MARKER}\n\`\`\`json\n${json}\n\`\`\`\n${CABINET_END_MARKER}`
}

export function extractFlowRunFromBody(body: string): FlowRun | null {
  const startIdx = body.indexOf(CABINET_START_MARKER)
  const endIdx = body.indexOf(CABINET_END_MARKER)
  if (startIdx === -1 || endIdx === -1) return null

  const block = body.slice(startIdx + CABINET_START_MARKER.length, endIdx).trim()

  const jsonMatch = block.match(/```json\n?([\s\S]*?)```/)
  if (!jsonMatch) return null

  try {
    const parsed = JSON.parse(jsonMatch[1].trim())
    const { data } = validateFlowRun(parsed)
    return data
  } catch {
    return null
  }
}

export function replaceFlowRunInBody(body: string, flowRun: FlowRun): string {
  const startIdx = body.indexOf(CABINET_START_MARKER)
  const endIdx = body.indexOf(CABINET_END_MARKER)

  const block = buildFlowRunBlock(flowRun)

  if (startIdx === -1 || endIdx === -1) {
    return body + "\n\n" + block
  }

  return body.slice(0, startIdx) + block + body.slice(endIdx + CABINET_END_MARKER.length)
}

export async function readFlowRun(issueNumber: number): Promise<FlowRun | null> {
  try {
    const { stdout } = await gh(`issue view ${issueNumber} --json body --jq .body`)
    return extractFlowRunFromBody(stdout)
  } catch {
    return null
  }
}

export async function writeFlowRun(issueNumber: number, flowRun: FlowRun): Promise<{ success: boolean; error?: string }> {
  try {
    const { stdout } = await gh(`issue view ${issueNumber} --json body --jq .body`)
    const body = stdout
    const newBody = replaceFlowRunInBody(body, flowRun)

    const escaped = escapeShellArg(newBody)

    await gh(`issue edit ${issueNumber} --body '${escaped}'`)
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function readFlowRunWithLock(issueNumber: number): Promise<{ flowRun: FlowRun | null; currentBody: string | null }> {
  try {
    const { stdout } = await gh(`issue view ${issueNumber} --json body --jq .body`)
    const flowRun = extractFlowRunFromBody(stdout)
    return { flowRun, currentBody: stdout }
  } catch {
    return { flowRun: null, currentBody: null }
  }
}

export async function writeFlowRunWithLock(
  issueNumber: number,
  flowRun: FlowRun,
  previousBody: string,
): Promise<{ success: boolean; error?: string; conflict: boolean }> {
  try {
    const { stdout } = await gh(`issue view ${issueNumber} --json body --jq .body`)

    if (previousBody !== stdout) {
      return { success: false, error: "Conflict: body has changed since last read", conflict: true }
    }

    const newBody = replaceFlowRunInBody(stdout, flowRun)
    const escaped = escapeShellArg(newBody)
    await gh(`issue edit ${issueNumber} --body '${escaped}'`)
    return { success: true, conflict: false }
  } catch (err) {
    return { success: false, error: String(err), conflict: false }
  }
}

export async function applyLabel(issueNumber: number, label: string): Promise<boolean> {
  try {
    await gh(`issue edit ${issueNumber} --add-label '${label}'`)
    return true
  } catch {
    return false
  }
}

export async function removeLabel(issueNumber: number, label: string): Promise<boolean> {
  try {
    await gh(`issue edit ${issueNumber} --remove-label '${label}'`)
    return true
  } catch {
    return false
  }
}

export function createInitialFlowRun(
  flowRunId: string,
  repo: string,
  parentIssueNumber: number,
): FlowRun {
  const now = new Date().toISOString()
  const emptyStage = () => ({
    status: "pending" as const,
    requiredArtifacts: [] as string[],
    checks: [],
    completedAt: null,
    evidence: [],
  })

  return {
    flowRunId,
    repo,
    parentIssueNumber,
    status: "planned",
    schemaVersion: CURRENT_SCHEMA_VERSION,
    revision: 0,
    stages: {
      requirements: emptyStage(),
      design: emptyStage(),
      tasks: emptyStage(),
      code: emptyStage(),
      test: emptyStage(),
      review: emptyStage(),
      merge: emptyStage(),
    },
    tasks: {},
    startedAt: now,
    lastTickAt: now,
    nextTickAfter: null,
    maxRuntime: 86_400_000,
    completedAt: null,
  }
}

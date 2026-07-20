import { gh } from "../util/gh.js"
import { escapeShellArg } from "../util/shell.js"
import {
  type FlowRun, type FlowRunReadResult,
  CABINET_START_MARKER,
  CABINET_END_MARKER,
  CURRENT_SCHEMA_VERSION,
} from "./types.js"
import { validateFlowRun } from "./validator.js"
import { migrateV1ToV2 } from "./migration.js"

function buildFlowRunBlock(flowRun: FlowRun): string {
  const json = JSON.stringify(flowRun, null, 2)
  return `${CABINET_START_MARKER}\n\`\`\`json\n${json}\n\`\`\`\n${CABINET_END_MARKER}`
}

/**
 * 从 Issue body 中提取 FlowRun，执行完整 v1→v2 读取管线：
 *   JSON parse → detect version → migrate → validate → return FlowRunReadResult
 */
export function extractFlowRunFromBody(body: string): FlowRunReadResult {
  const startIdx = body.indexOf(CABINET_START_MARKER)
  const endIdx = body.indexOf(CABINET_END_MARKER)
  if (startIdx === -1 || endIdx === -1) {
    return { ok: false, code: "NOT_FOUND", errors: [{ path: "", message: "FlowRun markers not found in issue body" }] }
  }

  const block = body.slice(startIdx + CABINET_START_MARKER.length, endIdx).trim()

  const jsonMatch = block.match(/```json\n?([\s\S]*?)```/)
  if (!jsonMatch) {
    return { ok: false, code: "INVALID_JSON", errors: [{ path: "", message: "JSON block not found" }] }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonMatch[1].trim())
  } catch {
    return { ok: false, code: "INVALID_JSON", errors: [{ path: "", message: "Failed to parse FlowRun JSON" }] }
  }

  // Step 1: version detection + migration
  const migrationResult = migrateV1ToV2(parsed)
  if (!migrationResult.ok) return migrationResult

  // Step 2: validate v2
  const { errors } = validateFlowRun(migrationResult.data)
  if (errors.length > 0) {
    return { ok: false, code: "VALIDATION_FAILED", errors }
  }

  return { ok: true, data: migrationResult.data, migrated: migrationResult.migrated }
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

export async function readFlowRun(issueNumber: number, ghEnv?: Record<string, string>): Promise<FlowRunReadResult> {
  try {
    const { stdout } = await gh(`issue view ${issueNumber} --json body --jq .body`, 30_000, ghEnv)
    return extractFlowRunFromBody(stdout)
  } catch {
    return { ok: false, code: "NOT_FOUND", errors: [{ path: "", message: "Failed to read issue body" }] }
  }
}

export async function writeFlowRun(issueNumber: number, flowRun: FlowRun, ghEnv?: Record<string, string>): Promise<{ success: boolean; error?: string }> {
  try {
    const { stdout } = await gh(`issue view ${issueNumber} --json body --jq .body`, 30_000, ghEnv)
    const body = stdout
    const newBody = replaceFlowRunInBody(body, flowRun)

    const escaped = escapeShellArg(newBody)

    await gh(`issue edit ${issueNumber} --body '${escaped}'`, 30_000, ghEnv)
    return { success: true }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}

export async function readFlowRunWithLock(issueNumber: number, ghEnv?: Record<string, string>): Promise<{ flowRunResult: FlowRunReadResult; currentBody: string | null }> {
  try {
    const { stdout } = await gh(`issue view ${issueNumber} --json body --jq .body`, 30_000, ghEnv)
    const flowRunResult = extractFlowRunFromBody(stdout)
    return { flowRunResult, currentBody: stdout }
  } catch {
    return { flowRunResult: { ok: false, code: "NOT_FOUND", errors: [{ path: "", message: "Failed to read issue body" }] }, currentBody: null }
  }
}

export async function writeFlowRunWithLock(
  issueNumber: number,
  flowRun: FlowRun,
  previousBody: string,
  ghEnv?: Record<string, string>,
): Promise<{ success: boolean; error?: string; conflict: boolean }> {
  try {
    const { stdout } = await gh(`issue view ${issueNumber} --json body --jq .body`, 30_000, ghEnv)

    if (previousBody !== stdout) {
      return { success: false, error: "Conflict: body has changed since last read", conflict: true }
    }

    const newBody = replaceFlowRunInBody(stdout, flowRun)
    const escaped = escapeShellArg(newBody)
    await gh(`issue edit ${issueNumber} --body '${escaped}'`, 30_000, ghEnv)
    return { success: true, conflict: false }
  } catch (err) {
    return { success: false, error: String(err), conflict: false }
  }
}

export async function applyLabel(issueNumber: number, label: string, ghEnv?: Record<string, string>): Promise<boolean> {
  try {
    await gh(`issue edit ${issueNumber} --add-label '${label}'`, 30_000, ghEnv)
    return true
  } catch {
    return false
  }
}

export async function removeLabel(issueNumber: number, label: string, ghEnv?: Record<string, string>): Promise<boolean> {
  try {
    await gh(`issue edit ${issueNumber} --remove-label '${label}'`, 30_000, ghEnv)
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
    repositoryQualityPolicy: {
      mode: "off",
      requiredChecks: [],
    },
  }
}

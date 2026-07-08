import { exec } from "node:child_process"
import { promisify } from "node:util"
import { type FlowRun, DEFAULT_MAX_RUNTIME_MS, FLOW_RUN_STAGES } from "./types.js"
import { canStartStage } from "./gate.js"

const execAsync = promisify(exec)

function gh(args: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(`gh ${args}`, { timeout: 15_000 })
}

export function getRuntimeMs(flowRun: FlowRun): number {
  if (!flowRun.startedAt) return 0
  return Date.now() - new Date(flowRun.startedAt).getTime()
}

export function hasRuntimeExpired(flowRun: FlowRun): boolean {
  const max = flowRun.maxRuntime || DEFAULT_MAX_RUNTIME_MS
  return getRuntimeMs(flowRun) > max
}

export interface RuntimeCheckResult {
  expired: boolean
  runtimeMs: number
  maxRuntimeMs: number
  remainingMs: number
}

export function checkRuntime(flowRun: FlowRun): RuntimeCheckResult {
  const runtimeMs = getRuntimeMs(flowRun)
  const maxRuntimeMs = flowRun.maxRuntime || DEFAULT_MAX_RUNTIME_MS
  return {
    expired: runtimeMs > maxRuntimeMs,
    runtimeMs,
    maxRuntimeMs,
    remainingMs: Math.max(0, maxRuntimeMs - runtimeMs),
  }
}

export interface BackpressureStatus {
  canContinue: boolean
  reason?: string
  rateLimitRemaining: number | null
  ciQueueLength: number | null
}

export async function checkBackpressure(owner: string, repo: string): Promise<BackpressureStatus> {
  const status: BackpressureStatus = {
    canContinue: true,
    rateLimitRemaining: null,
    ciQueueLength: null,
  }

  try {
    const { stdout } = await gh(`api rate_limit --jq .rate.remaining`)
    const remaining = parseInt(stdout.trim(), 10)
    status.rateLimitRemaining = remaining
    if (remaining < 100) {
      status.canContinue = false
      status.reason = `GitHub API rate limit low: ${remaining} remaining`
      return status
    }
  } catch {
    status.rateLimitRemaining = null
  }

  try {
    const { stdout } = await gh(`run list --repo ${owner}/${repo} --json status --jq '[.[] | select(.status == "queued" or .status == "in_progress")] | length'`)
    const queueLen = parseInt(stdout.trim(), 10)
    status.ciQueueLength = queueLen
    if (queueLen >= 10) {
      status.canContinue = false
      status.reason = `CI queue too long: ${queueLen} queued/in_progress`
      return status
    }
  } catch {
    status.ciQueueLength = null
  }

  return status
}

export function buildContinuationContext(flowRun: FlowRun): string {
  const parts: string[] = [
    `FlowRun: ${flowRun.flowRunId}`,
    `Status: ${flowRun.status}`,
    `Runtime: ${Math.round(getRuntimeMs(flowRun) / 60000)} minutes`,
    "",
    "## Stage Status",
  ]

  for (const stage of FLOW_RUN_STAGES) {
    const s = flowRun.stages[stage]
    const checkSummary = s.checks
      .map(c => `${c.name}=${c.status}`)
      .join(", ")
    parts.push(`- ${stage}: ${s.status}${checkSummary ? ` (${checkSummary})` : ""}`)
  }

  const taskEntries = Object.entries(flowRun.tasks)
  if (taskEntries.length > 0) {
    parts.push("", "## Tasks")
    for (const [id, task] of taskEntries) {
      parts.push(`- ${id}: ${task.status}${task.prNumber ? ` PR #${task.prNumber}` : ""}`)
    }
  }

  return parts.join("\n")
}

export function determineNextStage(flowRun: FlowRun): { stage: string | null; reason: string } {
  for (const stage of FLOW_RUN_STAGES) {
    const s = flowRun.stages[stage]
    if (s.status === "pending" || s.status === "failed" || s.status === "blocked") {
      const gate = canStartStage(flowRun, stage)
      if (gate.allowed) {
        return { stage, reason: `Stage "${stage}" is ready to start` }
      }
      return { stage: null, reason: `Cannot start "${stage}": ${gate.reason}` }
    }
    if (s.status === "running") {
      return { stage, reason: `Stage "${stage}" is in progress` }
    }
  }
  return { stage: null, reason: "All stages complete" }
}

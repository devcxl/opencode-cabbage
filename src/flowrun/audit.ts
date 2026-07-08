import { exec } from "node:child_process"
import { promisify } from "node:util"
import type { FlowRun, TaskState } from "./types.js"

const execAsync = promisify(exec)

function gh(args: string): Promise<{ stdout: string; stderr: string }> {
  return execAsync(`gh ${args}`, { timeout: 30_000 })
}

export async function postAuditComment(issueNumber: number, body: string): Promise<boolean> {
  try {
    const escaped = body.replace(/'/g, "'\\''")
    await gh(`issue comment ${issueNumber} --body '${escaped}'`)
    return true
  } catch {
    return false
  }
}

export async function postPRComment(prNumber: number, body: string): Promise<boolean> {
  try {
    const escaped = body.replace(/'/g, "'\\''")
    await gh(`pr comment ${prNumber} --body '${escaped}'`)
    return true
  } catch {
    return false
  }
}

export function buildStageAudit(flowRun: FlowRun, stage: string): string {
  const s = flowRun.stages[stage as keyof typeof flowRun.stages]
  if (!s) return `Stage "${stage}" not found`

  const lines: string[] = [
    `### Stage: ${stage}`,
    `Status: ${s.status}`,
    `Completed: ${s.completedAt ?? "not yet"}`,
  ]

  if (s.checks.length > 0) {
    lines.push("", "**Checks:**")
    for (const check of s.checks) {
      lines.push(`- ${check.name}: ${check.status}`)
      for (const ev of check.evidence) {
        lines.push(`  - \`${ev.command}\` → exit ${ev.exitCode}: ${ev.summary}`)
      }
    }
  }

  return lines.join("\n")
}

export function buildMergeAudit(task: TaskState): string {
  const lines: string[] = [
    `### Task: ${task.id}`,
    `PR: #${task.prNumber}`,
    `Status: ${task.status}`,
    "",
    "**Merge Checkpoints:**",
  ]

  if (task.prCheckpoints) {
    const cp = task.prCheckpoints
    const gates: Record<string, string> = {
      localChecks: cp.localChecks.status,
      ciChecks: cp.ciChecks.status,
      reviewerApproval: cp.reviewerApproval.status,
      goalVerification: cp.goalVerification.status,
      branchProtection: cp.branchProtection.status,
      mergeResult: cp.mergeResult.status,
    }
    for (const [name, status] of Object.entries(gates)) {
      lines.push(`- ${name}: ${status}`)
    }
  }

  return lines.join("\n")
}

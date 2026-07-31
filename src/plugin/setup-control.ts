import { tool } from "@opencode-ai/plugin/tool"
import { requireCaller, CALLER_NOT_AUTHORIZED, type CallerSessionClient } from "../kernel/caller.js"
import {
  probe,
  generateWorkflows,
  confirmProjectProfile,
  type SetupProbeReport,
} from "../kernel/setup.js"

/** setup_control 工具依赖：项目目录 + caller 判定所需的 session client */
export interface SetupControlDeps {
  projectDir: string
  sessionClient: CallerSessionClient
}

export type SetupControlResponse = {
  ok: boolean
  readiness?: SetupProbeReport
  profileConfirmed?: boolean
  created?: string[]
  prNumber?: number | null
  error?: { code: string; message: string }
}

const DEFAULT_PR_TITLE = "chore: add CI/release workflow drafts"

/**
 * setup_control 工具工厂（spec §2.3）。
 * 三 op：probe（readiness 报告） / generate-workflows（缺失时生成草案 + Setup PR） / confirm-profile（Profile 写回 AGENTS.md）。
 * caller：primary。server.ts 接线由后续批次统一处理（本批不注册，避免文件冲突）。
 */
export function createSetupControlTool(deps: SetupControlDeps) {
  return tool({
    description: `Detect project setup readiness, generate missing CI/release workflow drafts, and confirm the project profile.

Operations:
- probe: Detect git/gh availability, AGENTS.md Profile, CI/release workflows, and branch protection. Returns a readiness report (development-ready / release-ready).
- generate-workflows: Generate missing CI/release workflow drafts under .github/workflows/ (tech-stack agnostic), then create a chore/setup-workflows branch, commit, push, and open a Setup PR for manual merge.
- confirm-profile: After user confirmation, write the Project Profile block (from profile_overrides) back to the root AGENTS.md.

Caller: primary.`,
    args: {
      op: tool.schema.enum(["probe", "generate-workflows", "confirm-profile"]).describe("Setup operation"),
      pr_title: tool.schema.string().optional().describe("PR title for generate-workflows"),
      profile_overrides: tool.schema.string().optional().describe("JSON of user-confirmed profile fields for confirm-profile"),
    },
    async execute(args, ctx) {
      const op = args.op as string

      const denied = await requireCaller(ctx, ["primary"], op, deps.sessionClient)
      if (denied) return errorResponse(CALLER_NOT_AUTHORIZED, denied)

      try {
        switch (op) {
          case "probe": {
            const readiness = await probe(deps.projectDir)
            return okResponse({ readiness })
          }
          case "generate-workflows": {
            const prTitle = (args.pr_title as string | undefined) ?? DEFAULT_PR_TITLE
            const result = await generateWorkflows(deps.projectDir, { prTitle })
            if (!result.ok) {
              return errorResponse("SETUP_FAILED", result.error ?? "failed to generate workflows")
            }
            return okResponse({ created: result.created, prNumber: result.prNumber })
          }
          case "confirm-profile": {
            const overrides = args.profile_overrides as string | undefined
            if (!overrides) {
              return errorResponse("POLICY_INVALID", "profile_overrides is required for confirm-profile")
            }
            const result = await confirmProjectProfile(deps.projectDir, overrides)
            if (!result.ok) {
              return errorResponse(result.code ?? "POLICY_INVALID", result.message ?? "failed to confirm profile")
            }
            return okResponse({ profileConfirmed: true })
          }
          default:
            return errorResponse("UNKNOWN_OP", `Unknown op: "${op}"`)
        }
      } catch (err) {
        return errorResponse("INTERNAL_ERROR", String(err))
      }
    },
  })
}

/**
 * 独立注册辅助：把 setup_control 挂到工具注册表。
 * 供后续批次（批 8-11 或最终接线）在 server.ts 统一接线时调用。
 */
export function registerSetupControl(registry: Record<string, unknown>, deps: SetupControlDeps): void {
  registry.setup_control = createSetupControlTool(deps)
}

function okResponse(overrides: Partial<SetupControlResponse> = {}): string {
  const resp: SetupControlResponse = { ok: true, ...overrides }
  return JSON.stringify(resp, null, 2)
}

function errorResponse(code: string, message: string): string {
  const resp: SetupControlResponse = { ok: false, error: { code, message } }
  return JSON.stringify(resp, null, 2)
}

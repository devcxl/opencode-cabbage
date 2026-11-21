import { runCabbageOp } from "../cabbage/engine.js"

/**
 * `cabbage` 工具：纯 TypeScript 实现的变更记录与 OpenSpec 活文档验证引擎。
 * 权限规则层（agent permissions）与工具内授权自检双层门控（仅 dev-lifecycle 可用）。
 */

export const CABBAGE_ALLOWED_AGENTS = new Set(["dev-lifecycle"])

export interface CabbageToolInput {
  op: "init" | "new" | "status" | "next" | "impact" | "validate" | "verify" | "gate" | "sync" | "archive" | "tasks" | "discard" | "adopt"
  change?: string
  stage?: string
  target?: string
  type?: "change" | "incident"
  impact?: string[]
}

export interface CabbageToolContext {
  sessionID: string
  agent?: string
}

export interface CabbageToolResult {
  content: string
}

const OPS = ["init", "new", "status", "next", "impact", "validate", "verify", "gate", "sync", "archive", "tasks", "discard", "adopt"] as const

export const CABBAGE_TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    op: {
      type: "string",
      enum: [...OPS],
      description: "Cabbage operation",
    },
    change: {
      type: "string",
      description: "Change id in kebab-case (required by new/next/impact/verify/gate/sync/archive/tasks/discard; optional for status/validate)",
    },
    stage: {
      type: "string",
      description: "Stage id for verify — use the stage ids that `next` reports (new projects: `tasks`)",
    },
    target: {
      type: "string",
      description: "Gate target for gate: a stage id (checks the stages before it), or `merge` / `archive`",
    },
    type: {
      type: "string",
      enum: ["change", "incident"],
      description: "Change type for new (default: change)",
    },
    impact: {
      type: "array",
      items: { type: "string" },
      description: "Impact entries for impact, e.g. [\"api=true\", \"design=true\"] — design/rfc/architecture/api/database/security/deployment open specialist documents",
    },
  },
  required: ["op"],
  additionalProperties: false,
} as const

export const CABBAGE_TOOL_DESCRIPTION = `Manage this project's Cabbage change records — built-in pure TypeScript tasks-and-specs engine (zero Python dependency).

Ops:
- init: scaffold .cabbage/ and unified OpenSpec docs/ (specs, adr, prd)
- adopt: inventory existing markdown outside docs/specs|adr|prd|guides and write .cabbage/adoption-report.md
- new: create a record (type: change|incident; change: kebab-case id)
- status: list active records and per-stage state (change optional)
- next: show ready and blocked stages for a record
- impact: declare risks, e.g. impact:["api=true","design=true"] — opens specialist docs
- verify: verify one stage artifact (stage required; use ids from next)
- gate: check a milestone (target: stage id | merge | archive)
- validate: structural checks (all records when change omitted)
- sync: copy mapped documents into docs/specs/ and docs/adr/
- archive: gate, sync, and move the record to .cabbage/archive/ (only after the merge is confirmed)
- tasks: read-only task checklist view
- discard: delete an abandoned record

Records live in .cabbage/changes/<id>/; state.json and change.yaml are engine-owned — never edit them by hand.`

function validateArgs(input: CabbageToolInput): string | null {
  const change = input.change?.trim()
  switch (input.op) {
    case "new":
      if (!change) return "Error: op `new` requires `change` (kebab-case id)."
      return null
    case "next":
    case "sync":
    case "archive":
    case "tasks":
    case "discard":
      if (!change) return `Error: op \`${input.op}\` requires \`change\`.`
      return null
    case "impact": {
      if (!change) return "Error: op `impact` requires `change`."
      const entries = (input.impact ?? []).filter((x) => typeof x === "string" && x.trim() !== "")
      if (entries.length === 0) return 'Error: op `impact` requires a non-empty `impact` array, e.g. ["api=true"].'
      return null
    }
    case "verify":
      if (!change) return "Error: op `verify` requires `change`."
      if (!input.stage?.trim()) return "Error: op `verify` requires `stage` (use the ids from `next`)."
      return null
    case "gate":
      if (!change) return "Error: op `gate` requires `change`."
      if (!input.target?.trim()) return "Error: op `gate` requires `target` (a stage id, `merge`, or `archive`)."
      return null
    case "init":
    case "adopt":
    case "status":
    case "validate":
      return null
    default:
      return `Error: unknown op \`${String((input as { op?: string }).op)}\`.`
  }
}

export function buildCabbageTool(projectDir: string) {
  return {
    name: "cabbage",
    description: CABBAGE_TOOL_DESCRIPTION,
    input: CABBAGE_TOOL_INPUT_SCHEMA,
    options: { permission: "cabbage" },

    async execute(input: CabbageToolInput, context: CabbageToolContext): Promise<CabbageToolResult> {
      if (!context.agent || !CABBAGE_ALLOWED_AGENTS.has(context.agent)) {
        return { content: `Error: the cabbage tool is restricted to the dev-lifecycle orchestrator. Agent "${context.agent ?? "unknown"}" is not authorized.` }
      }

      const argError = validateArgs(input)
      if (argError) return { content: argError }

      const result = await runCabbageOp(projectDir, input)
      const parts = [result.stdout.trim()]
      if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.trim()}`)
      parts.push(`exit=${result.code}`)
      return { content: parts.filter(Boolean).join("\n") }
    },
  }
}

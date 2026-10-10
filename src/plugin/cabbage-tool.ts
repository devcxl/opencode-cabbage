import type { CabbageCliRuntime } from "./cabbage-cli.js"
import { runCabbage } from "./cabbage-cli.js"

/**
 * `cabbage` 工具：把内置 Cabbage 引擎（变更记录 / 任务与文档 / 验证与归档）暴露为
 * 一等工具。与 goal 工具相同的双层门控：权限规则层（agent permissions）隐藏/放行，
 * 工具内自检兜底（仅 dev-lifecycle 编排器可用）。
 */

export const CABBAGE_ALLOWED_AGENTS = new Set(["dev-lifecycle"])

export interface CabbageToolInput {
  op: "init" | "new" | "status" | "next" | "impact" | "validate" | "verify" | "gate" | "sync" | "archive" | "tasks" | "discard"
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

const OPS = ["init", "new", "status", "next", "impact", "validate", "verify", "gate", "sync", "archive", "tasks", "discard"] as const

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
      description: "Impact entries for impact, e.g. [\"api=true\", \"design=true\"] — design/rfc/adr/api/database/security/deployment open specialist documents",
    },
  },
  required: ["op"],
  additionalProperties: false,
} as const

export const CABBAGE_TOOL_DESCRIPTION = `Manage this project's Cabbage change records — the built-in tasks-and-docs workflow (the engine is bundled; Python 3.10+ required).

Ops:
- init: scaffold .cabbage/ (workflows, docs skeleton, CI template, vendored CLI) — run once per project
- new: create a record (type: change|incident; change: kebab-case id)
- status: list active records and per-stage state (change optional)
- next: show ready and blocked stages for a record
- impact: declare risks, e.g. impact:["api=true","design=true"] — opens specialist docs (design/rfc/adr/api/database/security/release)
- verify: verify one stage artifact (stage required; use ids from next)
- gate: check a milestone (target: stage id | merge | archive)
- validate: structural checks (all records when change omitted)
- sync: copy mapped documents into docs/
- archive: gate, sync, and move the record to .cabbage/archive/ (only after the merge is confirmed)
- tasks: read-only task checklist view
- discard: delete an abandoned record

Light path: new → fill tasks.md (Goal/Design/Tasks/Verification) → verify tasks → gate merge → archive after merge. Records live in .cabbage/changes/<id>/; state.json and change.yaml are CLI-owned — never edit them by hand.`

function buildArgs(input: CabbageToolInput): string[] | { error: string } {
  const change = input.change?.trim()
  const requireChange = (op: string) => change ?? { error: `Error: op \`${op}\` requires \`change\`.` }
  switch (input.op) {
    case "init":
      return ["init"]
    case "new": {
      if (!change || typeof change !== "string") return { error: "Error: op `new` requires `change` (kebab-case id)." }
      return ["new", input.type ?? "change", change]
    }
    case "status":
      return change ? ["status", change] : ["status"]
    case "next": {
      const c = requireChange("next")
      if (typeof c !== "string") return c
      return ["next", c]
    }
    case "impact": {
      const c = requireChange("impact")
      if (typeof c !== "string") return c
      const entries = (input.impact ?? []).filter((x) => typeof x === "string" && x.trim() !== "")
      if (entries.length === 0) return { error: "Error: op `impact` requires a non-empty `impact` array, e.g. [\"api=true\"]." }
      return ["impact", c, ...entries.flatMap((entry) => ["--set", entry.trim()])]
    }
    case "validate":
      return change ? ["validate", change] : ["validate", "--all"]
    case "verify": {
      const c = requireChange("verify")
      if (typeof c !== "string") return c
      const stage = input.stage?.trim()
      if (!stage) return { error: "Error: op `verify` requires `stage` (use the ids from `next`)." }
      return ["verify", c, stage]
    }
    case "gate": {
      const c = requireChange("gate")
      if (typeof c !== "string") return c
      const target = input.target?.trim()
      if (!target) return { error: "Error: op `gate` requires `target` (a stage id, `merge`, or `archive`)." }
      return ["gate", c, target]
    }
    case "sync": {
      const c = requireChange("sync")
      if (typeof c !== "string") return c
      return ["sync", c]
    }
    case "archive": {
      const c = requireChange("archive")
      if (typeof c !== "string") return c
      return ["archive", c]
    }
    case "tasks": {
      const c = requireChange("tasks")
      if (typeof c !== "string") return c
      return ["tasks", c]
    }
    case "discard": {
      const c = requireChange("discard")
      if (typeof c !== "string") return c
      return ["discard", c]
    }
    default:
      return { error: `Error: unknown op \`${String((input as { op?: string }).op)}\`.` }
  }
}

export function buildCabbageTool(cli: CabbageCliRuntime, projectDir: string) {
  return {
    name: "cabbage",
    description: CABBAGE_TOOL_DESCRIPTION,
    input: CABBAGE_TOOL_INPUT_SCHEMA,
    options: { permission: "cabbage" },

    async execute(input: CabbageToolInput, context: CabbageToolContext): Promise<CabbageToolResult> {
      if (!context.agent || !CABBAGE_ALLOWED_AGENTS.has(context.agent)) {
        return { content: `Error: the cabbage tool is restricted to the dev-lifecycle orchestrator. Agent "${context.agent ?? "unknown"}" is not authorized.` }
      }
      if (!cli.available) {
        return { content: `Error: cabbage CLI unavailable: ${cli.reason ?? "unknown reason"}. The bundled engine needs Python 3.10+; install it and restart.` }
      }

      const built = buildArgs(input)
      if ("error" in built) return { content: built.error }

      try {
        const result = await runCabbage(cli, built, projectDir)
        const parts = [result.stdout.trim()]
        if (result.stderr.trim()) parts.push(`[stderr]\n${result.stderr.trim()}`)
        parts.push(`exit=${result.code}`)
        return { content: parts.filter(Boolean).join("\n") }
      } catch (err) {
        return { content: `Error: failed to run cabbage ${built.join(" ")}: ${(err as Error | null)?.message ?? err}` }
      }
    },
  }
}

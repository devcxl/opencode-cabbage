import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { parse as parseYaml, stringify as stringifyYaml } from "yaml"
import type { CabbageToolInput } from "../plugin/cabbage-tool.js"
import {
  DEFAULT_STAGE_DOCS_MAPPING,
  IMPACT_FIELDS,
  WORKFLOWS,
  renderStageTemplate,
  type WorkflowDef,
  type WorkflowStage,
} from "./workflows.js"
import { parseFrontmatter, validateMarkdownArtifact } from "./validate.js"

const CABBAGE_DIR = ".cabbage"
const CHANGE_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface CabbageRunOutput {
  code: number
  stdout: string
  stderr: string
}

interface ChangeSpec {
  id: string
  type: "change" | "incident"
  status: string
  impact: Record<string, boolean>
}

interface StageState {
  version: number
  completed: Record<string, { signature: string; verified_at: string; completed_at: string }>
}

interface CabbageConfig {
  version: number
  impact_fields?: string[]
  docs?: {
    dir?: string
    mapping?: Record<string, string>
  }
}

class CabbageOpError extends Error {
  constructor(message: string, public readonly exitCode = 2) {
    super(message)
  }
}

function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex")
}

function sha256File(filePath: string): string {
  return existsSync(filePath) ? sha256(readFileSync(filePath)) : "MISSING"
}

function writeAtomic(filePath: string, content: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, content, "utf8")
  renameSync(tmp, filePath)
}

function readYamlFile<T>(filePath: string): T {
  if (!existsSync(filePath)) throw new CabbageOpError(`missing file: ${filePath}`)
  const data = parseYaml(readFileSync(filePath, "utf8"))
  return (data ?? {}) as T
}

function findProjectRoot(startDir: string): string {
  let cur = path.resolve(startDir)
  while (true) {
    if (existsSync(path.join(cur, CABBAGE_DIR, "config.yaml"))) return cur
    const parent = path.dirname(cur)
    if (parent === cur) throw new CabbageOpError("not a cabbage project; run `cabbage init`")
    cur = parent
  }
}

function loadWorkflow(root: string, changeType: string): { wf: WorkflowDef; wfPath: string } {
  const wfPath = path.join(root, CABBAGE_DIR, "workflows", `${changeType}.yaml`)
  if (existsSync(wfPath)) {
    return { wf: readYamlFile<WorkflowDef>(wfPath), wfPath }
  }
  if (changeType === "change" || changeType === "incident") {
    return { wf: WORKFLOWS[changeType], wfPath }
  }
  throw new CabbageOpError(`unknown change type: ${changeType}; available: change, incident`)
}

function conditionEnabled(stage: WorkflowStage, spec: ChangeSpec): boolean {
  if (!stage.when || stage.when === "always") return true
  if (stage.when.startsWith("impact.")) {
    const key = stage.when.slice("impact.".length)
    return Boolean(spec.impact?.[key])
  }
  throw new CabbageOpError(`unsupported condition: ${stage.when}`)
}

function changeDir(root: string, changeId: string): string {
  return path.join(root, CABBAGE_DIR, "changes", changeId)
}

function loadChangeSpec(root: string, changeId: string): ChangeSpec {
  return readYamlFile<ChangeSpec>(path.join(changeDir(root, changeId), "change.yaml"))
}

function loadState(root: string, changeId: string): StageState {
  const p = path.join(changeDir(root, changeId), "state.json")
  if (!existsSync(p)) return { version: 1, completed: {} }
  const data = JSON.parse(readFileSync(p, "utf8")) as StageState
  data.completed ??= {}
  return data
}

function saveState(root: string, changeId: string, state: StageState): void {
  writeAtomic(path.join(changeDir(root, changeId), "state.json"), JSON.stringify(state, null, 2) + "\n")
}

function stageSignature(
  root: string,
  changeId: string,
  stageId: string,
  memo = new Map<string, string>(),
  visiting = new Set<string>(),
): string {
  const cached = memo.get(stageId)
  if (cached) return cached
  if (visiting.has(stageId)) throw new CabbageOpError(`dependency cycle detected involving stage: \`${stageId}\``)
  visiting.add(stageId)

  const spec = loadChangeSpec(root, changeId)
  const { wf, wfPath } = loadWorkflow(root, spec.type)
  const smap = new Map(wf.stages.map((s) => [s.id, s]))
  const stage = smap.get(stageId)
  if (!stage) throw new CabbageOpError(`unknown stage: ${stageId}`)

  const ap = path.join(changeDir(root, changeId), stage.artifact)
  const deps: Record<string, string> = {}
  for (const dep of stage.depends_on ?? []) {
    const depStage = smap.get(dep)
    if (depStage && conditionEnabled(depStage, spec)) {
      deps[dep] = stageSignature(root, changeId, dep, memo, new Set(visiting))
    }
  }
  const payload = {
    workflow: existsSync(wfPath) ? sha256File(wfPath) : sha256(JSON.stringify(wf)),
    stage,
    artifact: sha256File(ap),
    dependencies: deps,
  }
  const sig = sha256(JSON.stringify(payload))
  memo.set(stageId, sig)
  visiting.delete(stageId)
  return sig
}

function getStageStatuses(root: string, changeId: string) {
  const spec = loadChangeSpec(root, changeId)
  const { wf } = loadWorkflow(root, spec.type)
  const state = loadState(root, changeId)
  const memo = new Map<string, string>()

  return wf.stages.map((stage) => {
    const enabled = conditionEnabled(stage, spec)
    let status: "skipped" | "pending" | "done" | "stale"
    if (!enabled) {
      status = "skipped"
    } else if (!state.completed[stage.id]) {
      status = "pending"
    } else {
      status = state.completed[stage.id].signature === stageSignature(root, changeId, stage.id, memo) ? "done" : "stale"
    }
    return { id: stage.id, status, artifact: stage.artifact }
  })
}

function ensureArtifacts(root: string, changeId: string): void {
  const spec = loadChangeSpec(root, changeId)
  const { wf } = loadWorkflow(root, spec.type)
  for (const st of wf.stages) {
    if (!conditionEnabled(st, spec)) continue
    const target = path.join(changeDir(root, changeId), st.artifact)
    if (!existsSync(target)) {
      writeAtomic(target, renderStageTemplate(st, changeId))
    }
  }
}

function opInit(projectDir: string): string {
  const d = path.join(projectDir, CABBAGE_DIR)
  const cfgPath = path.join(d, "config.yaml")
  if (existsSync(cfgPath)) {
    throw new CabbageOpError(`${CABBAGE_DIR} already initialized`)
  }
  mkdirSync(path.join(d, "workflows"), { recursive: true })
  mkdirSync(path.join(d, "changes"), { recursive: true })
  mkdirSync(path.join(d, "archive"), { recursive: true })

  // Unified OpenSpec directories (no 18-dir bloat, no Python tooling copy)
  for (const sub of ["specs", "adr", "prd"]) {
    mkdirSync(path.join(projectDir, "docs", sub), { recursive: true })
  }

  const cfg: CabbageConfig = {
    version: 1,
    impact_fields: [...IMPACT_FIELDS],
    docs: { dir: "docs", mapping: { ...DEFAULT_STAGE_DOCS_MAPPING } },
  }
  writeAtomic(cfgPath, stringifyYaml(cfg))
  writeAtomic(path.join(d, "workflows", "change.yaml"), stringifyYaml(WORKFLOWS.change))
  writeAtomic(path.join(d, "workflows", "incident.yaml"), stringifyYaml(WORKFLOWS.incident))
  return `initialized cabbage\nnext: cabbage({op:"new", type:"change", change:"<slug>"})`
}

function opNew(root: string, changeType: "change" | "incident", changeId: string): string {
  if (!CHANGE_ID_RE.test(changeId)) {
    throw new CabbageOpError("change id must be kebab-case")
  }
  loadWorkflow(root, changeType)
  const dir = changeDir(root, changeId)
  if (existsSync(dir)) throw new CabbageOpError(`change already exists: ${changeId}`)
  mkdirSync(dir, { recursive: true })

  const cfg = readYamlFile<CabbageConfig>(path.join(root, CABBAGE_DIR, "config.yaml"))
  const impact: Record<string, boolean> = {}
  for (const field of cfg.impact_fields ?? [...IMPACT_FIELDS]) {
    impact[field] = false
  }
  if (changeType === "change") {
    impact.product = true
    impact.testing = true
  }
  const spec: ChangeSpec = { id: changeId, type: changeType, status: "active", impact }
  writeAtomic(path.join(dir, "change.yaml"), stringifyYaml(spec))
  ensureArtifacts(root, changeId)
  return `created ${changeId} (${changeType})`
}

function opImpact(root: string, changeId: string, entries: string[]): string {
  const dir = changeDir(root, changeId)
  const specPath = path.join(dir, "change.yaml")
  const spec = loadChangeSpec(root, changeId)
  for (const raw of entries) {
    const eq = raw.indexOf("=")
    if (eq <= 0) throw new CabbageOpError(`invalid impact entry: ${raw} (expected key=true|false)`)
    const key = raw.slice(0, eq).trim()
    const val = raw.slice(eq + 1).trim().toLowerCase()
    if (val !== "true" && val !== "false") {
      throw new CabbageOpError(`invalid impact value for ${key}: ${val} (expected true|false)`)
    }
    if (!(key in spec.impact)) {
      throw new CabbageOpError(`unknown impact field: ${key}`)
    }
    spec.impact[key] = val === "true"
  }
  writeAtomic(specPath, stringifyYaml(spec))
  ensureArtifacts(root, changeId)
  const enabled = Object.entries(spec.impact).filter(([, v]) => v).map(([k]) => k)
  return `updated ${changeId} impact: ${enabled.join(", ") || "none"}`
}

function opStatus(root: string, changeId?: string): string {
  const changesRoot = path.join(root, CABBAGE_DIR, "changes")
  if (!existsSync(changesRoot)) return "no active changes"
  const ids = changeId
    ? [changeId]
    : readdirSync(changesRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  if (ids.length === 0) return "no active changes"

  const lines: string[] = []
  for (const id of ids) {
    const statuses = getStageStatuses(root, id)
    const active = statuses.filter((s) => s.status !== "skipped").map((s) => `${s.id}:${s.status}`)
    lines.push(`${id} [${active.join(", ")}]`)
  }
  return lines.join("\n")
}

function opNext(root: string, changeId: string): string {
  const spec = loadChangeSpec(root, changeId)
  const { wf } = loadWorkflow(root, spec.type)
  const statuses = getStageStatuses(root, changeId)
  const statusById = new Map(statuses.map((s) => [s.id, s.status]))
  const smap = new Map(wf.stages.map((s) => [s.id, s]))

  const lines = statuses.map((s) => {
    const stage = smap.get(s.id)!
    const blockers = (stage.depends_on ?? []).filter((d) => {
      const ds = statusById.get(d)
      return ds && ds !== "done" && ds !== "skipped"
    })
    const suffix = blockers.length > 0 ? ` (blocked by: ${blockers.join(", ")})` : ""
    return `${s.id}: ${s.status}${suffix}`
  })
  return lines.join("\n")
}

function opVerify(root: string, changeId: string, stageId: string): void {
  const spec = loadChangeSpec(root, changeId)
  const { wf } = loadWorkflow(root, spec.type)
  const stage = wf.stages.find((s) => s.id === stageId)
  if (!stage) throw new CabbageOpError(`unknown stage: ${stageId}`)
  if (!conditionEnabled(stage, spec)) throw new CabbageOpError(`stage \`${stageId}\` is skipped by current impact`)

  const statuses = new Map(getStageStatuses(root, changeId).map((s) => [s.id, s.status]))
  const errors: string[] = []
  for (const dep of stage.depends_on ?? []) {
    const ds = statuses.get(dep)
    if (ds && ds !== "done" && ds !== "skipped") {
      errors.push(`${stage.id}: dependency \`${dep}\` is ${ds}`)
    }
  }
  const ap = path.join(changeDir(root, changeId), stage.artifact)
  errors.push(...validateMarkdownArtifact(root, changeId, stage, ap, true))
  if (errors.length > 0) throw new CabbageOpError(errors.join("\n"))

  const state = loadState(root, changeId)
  const now = new Date().toISOString()
  state.completed[stageId] = {
    signature: stageSignature(root, changeId, stageId),
    verified_at: now,
    completed_at: now,
  }
  saveState(root, changeId, state)
}

function opGate(root: string, changeId: string, target: string): { allowed: boolean; text: string } {
  const statuses = getStageStatuses(root, changeId)
  const order = statuses.map((s) => s.id)
  let required = statuses
  if (target === "merge" || target === "archive") {
    required = statuses
  } else if (order.includes(target)) {
    required = statuses.slice(0, order.indexOf(target))
  } else {
    throw new CabbageOpError(`unknown gate target: ${target} (use a stage id, merge, or archive)`)
  }
  const blockers = required.filter((s) => s.status !== "done" && s.status !== "skipped")
  if (blockers.length > 0) {
    return {
      allowed: false,
      text: `BLOCKED: ${blockers.map((b) => `${b.id} is ${b.status}`).join("; ")}`,
    }
  }
  return { allowed: true, text: `ALLOWED: ${changeId} (${target})` }
}

function opValidate(root: string, changeId?: string): string {
  const changesRoot = path.join(root, CABBAGE_DIR, "changes")
  const ids = changeId
    ? [changeId]
    : existsSync(changesRoot)
      ? readdirSync(changesRoot, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
      : []

  const errors: string[] = []
  for (const id of ids) {
    const spec = loadChangeSpec(root, id)
    if (spec.id !== id) errors.push(`${id}: change.yaml id must be \`${id}\``)
    const { wf } = loadWorkflow(root, spec.type)
    for (const st of wf.stages) {
      if (!conditionEnabled(st, spec)) continue
      const ap = path.join(changeDir(root, id), st.artifact)
      errors.push(...validateMarkdownArtifact(root, id, st, ap, false))
    }
  }
  if (errors.length > 0) throw new CabbageOpError(errors.join("\n"))
  return `validated ${ids.length} change(s): OK`
}

function opSync(root: string, changeId: string): string {
  const spec = loadChangeSpec(root, changeId)
  const { wf } = loadWorkflow(root, spec.type)
  const cfg = readYamlFile<CabbageConfig>(path.join(root, CABBAGE_DIR, "config.yaml"))
  const docsDir = path.join(root, cfg.docs?.dir ?? "docs")
  const mapping = { ...DEFAULT_STAGE_DOCS_MAPPING, ...(cfg.docs?.mapping ?? {}) }

  const synced: string[] = []
  for (const st of wf.stages) {
    if (!conditionEnabled(st, spec)) continue
    const relTmpl = mapping[st.id]
    if (!relTmpl) continue
    const ap = path.join(changeDir(root, changeId), st.artifact)
    if (!existsSync(ap)) continue
    const { body } = parseFrontmatter(readFileSync(ap, "utf8"))
    const meta = {
      origin_change: changeId,
      change_type: spec.type,
      cabbage_stage: st.id,
      synced_at: new Date().toISOString(),
    }
    const destPath = path.join(docsDir, relTmpl.replaceAll("{change_id}", changeId))
    writeAtomic(destPath, `---\n${stringifyYaml(meta)}---\n\n${body.trimStart()}`)
    synced.push(path.relative(root, destPath).split(path.sep).join("/"))
  }
  return synced.length > 0 ? `synced: ${synced.join(", ")}` : "synced: none"
}

function opArchive(root: string, changeId: string): string {
  const gateRes = opGate(root, changeId, "archive")
  if (!gateRes.allowed) throw new CabbageOpError(gateRes.text)
  const syncOut = opSync(root, changeId)
  const specPath = path.join(changeDir(root, changeId), "change.yaml")
  const spec = loadChangeSpec(root, changeId)
  spec.status = "archived"
  writeAtomic(specPath, stringifyYaml(spec))

  const year = String(new Date().getUTCFullYear())
  const dest = path.join(root, CABBAGE_DIR, "archive", year, changeId)
  if (existsSync(dest)) throw new CabbageOpError(`archive target already exists: ${year}/${changeId}`)
  mkdirSync(path.dirname(dest), { recursive: true })
  renameSync(changeDir(root, changeId), dest)
  return `archived ${changeId} -> .cabbage/archive/${year}/${changeId}\n${syncOut}`
}

function opTasks(root: string, changeId: string): string {
  const p = path.join(changeDir(root, changeId), "tasks.md")
  if (!existsSync(p)) throw new CabbageOpError(`missing tasks.md for ${changeId}`)
  const lines = readFileSync(p, "utf8").split(/\r?\n/).filter((l) => /^\s*[-*]\s+\[[ xX\-/]\]/.test(l))
  return lines.length > 0 ? lines.join("\n") : "no checklist items"
}

function opDiscard(root: string, changeId: string): string {
  const dir = changeDir(root, changeId)
  if (!existsSync(dir)) throw new CabbageOpError(`change \`${changeId}\` does not exist`)
  rmSync(dir, { recursive: true, force: true })
  return `discarded change \`${changeId}\``
}

const ADOPTION_IGNORED = new Set([
  ".git", ".cabbage", ".github", ".idea", ".vscode", ".venv", "venv",
  "node_modules", "dist", "build", "target", "coverage", "vendor", ".worktree", ".worktrees",
])

function opAdopt(root: string): string {
  const rows: Array<{ rel: string; action: string; target: string }> = []
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (ADOPTION_IGNORED.has(entry.name) || entry.name.startsWith(".")) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith(".md")) continue
      const rel = path.relative(root, full).split(path.sep).join("/")
      if (rel === "README.md" || rel === "README.zh.md" || rel === "AGENTS.md" || rel === "CONTEXT.md") continue
      if (rel.startsWith("docs/specs/") || rel.startsWith("docs/adr/") || rel.startsWith("docs/prd/") || rel.startsWith("docs/guides/")) {
        rows.push({ rel, action: "keep", target: "-" })
      } else if (/(^|[-_/])(adr|rfc)([-_/]|$)/i.test(rel)) {
        rows.push({ rel, action: "import", target: rel.includes("adr") ? "docs/adr/" : "docs/specs/" })
      } else {
        rows.push({ rel, action: "review", target: "docs/specs/" })
      }
    }
  }
  walk(root)

  const lines = [
    "---",
    "cabbage_stage: adoption",
    `generated_at: ${new Date().toISOString()}`,
    "---",
    "",
    "# Adoption report",
    "",
    "| Path | Action | Suggested target |",
    "|---|---|---|",
    ...rows.map((r) => `| \`${r.rel}\` | ${r.action} | \`${r.target}\` |`),
    "",
  ]
  const outPath = path.join(root, CABBAGE_DIR, "adoption-report.md")
  writeAtomic(outPath, lines.join("\n"))
  return `adoption report written to .cabbage/adoption-report.md (${rows.length} document(s))`
}

export async function runCabbageOp(projectDir: string, input: CabbageToolInput): Promise<CabbageRunOutput> {
  try {
    if (input.op === "init") {
      return { code: 0, stdout: opInit(projectDir), stderr: "" }
    }
    const root = findProjectRoot(projectDir)
    const needChange = (op: string): string => {
      const c = input.change?.trim()
      if (!c) throw new CabbageOpError(`Error: op \`${op}\` requires \`change\`.`)
      return c
    }

    switch (input.op) {
      case "adopt":
        return { code: 0, stdout: opAdopt(root), stderr: "" }
      case "new":
        return { code: 0, stdout: opNew(root, input.type ?? "change", needChange("new")), stderr: "" }
      case "status":
        return { code: 0, stdout: opStatus(root, input.change?.trim()), stderr: "" }
      case "next":
        return { code: 0, stdout: opNext(root, needChange("next")), stderr: "" }
      case "impact": {
        const c = needChange("impact")
        const entries = (input.impact ?? []).map((x) => x.trim()).filter(Boolean)
        if (entries.length === 0) throw new CabbageOpError("Error: op `impact` requires a non-empty `impact` array.")
        return { code: 0, stdout: opImpact(root, c, entries), stderr: "" }
      }
      case "validate":
        return { code: 0, stdout: opValidate(root, input.change?.trim()), stderr: "" }
      case "verify": {
        const c = needChange("verify")
        const stage = input.stage?.trim()
        if (!stage) throw new CabbageOpError("Error: op `verify` requires `stage`.")
        opVerify(root, c, stage)
        return { code: 0, stdout: `verified ${c}:${stage}`, stderr: "" }
      }
      case "gate": {
        const c = needChange("gate")
        const target = input.target?.trim()
        if (!target) throw new CabbageOpError("Error: op `gate` requires `target`.")
        const res = opGate(root, c, target)
        return { code: res.allowed ? 0 : 2, stdout: res.text, stderr: "" }
      }
      case "sync":
        return { code: 0, stdout: opSync(root, needChange("sync")), stderr: "" }
      case "archive":
        return { code: 0, stdout: opArchive(root, needChange("archive")), stderr: "" }
      case "tasks":
        return { code: 0, stdout: opTasks(root, needChange("tasks")), stderr: "" }
      case "discard":
        return { code: 0, stdout: opDiscard(root, needChange("discard")), stderr: "" }
      default:
        throw new CabbageOpError(`unknown op: ${String(input.op)}`)
    }
  } catch (err) {
    if (err instanceof CabbageOpError) {
      return { code: err.exitCode, stdout: "", stderr: err.message }
    }
    return { code: 1, stdout: "", stderr: (err as Error)?.message ?? String(err) }
  }
}

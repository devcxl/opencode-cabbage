import { existsSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { parse as parseYaml } from "yaml"
import type { WorkflowStage } from "./workflows.js"

const MERMAID_TYPES = [
  "graph", "flowchart", "sequenceDiagram", "classDiagram", "stateDiagram",
  "stateDiagram-v2", "erDiagram", "journey", "gantt", "pie", "quadrantChart",
  "requirementDiagram", "gitGraph", "c4Context", "mindmap", "timeline", "sankey-beta", "xychart-beta",
]

const LEGACY_PLACEHOLDERS = new Set([
  "Describe the architectural decision context.",
  "Record the chosen decision.",
  "Record positive and negative consequences.",
  "Describe endpoints/events, inputs, outputs and errors.",
  "Describe versioning and backward compatibility.",
  "Describe schema changes.",
  "Describe forward migration.",
  "Describe rollback and data-safety constraints.",
  "Describe user/business impact.",
  "Record key timestamps and actions.",
  "Record containment and recovery.",
  "Describe the root cause.",
  "Describe systemic contributing factors.",
  "List owned corrective actions.",
  "Describe the problem.",
  "Describe the proposal.",
  "Describe alternatives and trade-offs.",
  "Describe trust boundaries, abuse cases and sensitive assets.",
  "Describe authorization, validation, secrets, audit and mitigations.",
  "Describe current state and constraints.",
  "Describe failure handling and recovery.",
  "Describe incremental rollout and compatibility.",
  "Describe deployment steps and ordering.",
  "Describe rollback triggers and steps.",
  "Describe post-deploy verification.",
])

export function parseFrontmatter(text: string): { meta: Record<string, unknown>; body: string } {
  if (!text.startsWith("---\n")) return { meta: {}, body: text }
  const end = text.indexOf("\n---\n", 4)
  if (end < 0) return { meta: {}, body: text }
  const raw = text.slice(4, end)
  const parsed = parseYaml(raw)
  const meta = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {}
  return { meta, body: text.slice(end + 5) }
}

export function extractHeadingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>()
  for (const line of markdown.split(/\r?\n/)) {
    const m = /^#+\s+(.+)$/.exec(line)
    if (!m) continue
    const title = m[1].trim()
    slugs.add(title.toLowerCase())
    const slug = title
      .replace(/[^\w\s-]/g, "")
      .trim()
      .toLowerCase()
      .replace(/[\s_]+/g, "-")
    if (slug) slugs.add(slug)
  }
  return slugs
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function validateMarkdownArtifact(
  root: string,
  changeId: string,
  stage: WorkflowStage,
  artifactPath: string,
  verification: boolean,
): string[] {
  const errors: string[] = []
  if (!existsSync(artifactPath)) {
    return [`${stage.id}: missing artifact ${path.relative(root, artifactPath)}`]
  }

  const text = readFileSync(artifactPath, "utf8")
  let meta: Record<string, unknown>
  let body: string
  try {
    const parsed = parseFrontmatter(text)
    meta = parsed.meta
    body = parsed.body
  } catch (err) {
    return [`${stage.id}: invalid frontmatter YAML: ${(err as Error).message}`]
  }

  if (meta.change !== changeId) {
    errors.push(`${stage.id}: frontmatter \`change\` must be \`${changeId}\``)
  }
  if (meta.cabbage_stage !== stage.id) {
    errors.push(`${stage.id}: frontmatter \`cabbage_stage\` must be \`${stage.id}\``)
  }

  for (const heading of stage.required_headings) {
    const re = new RegExp(`^#+\\s+${escapeRegExp(heading)}\\s*$`, "mi")
    if (!re.test(body)) {
      errors.push(`${stage.id}: missing heading \`${heading}\``)
    }
  }

  if (verification) {
    if (/\b(TODO|TBD|FIXME)\b/i.test(body)) {
      errors.push(`${stage.id}: unresolved TODO/TBD/FIXME`)
    }
    const strippedLines = body.split(/\r?\n/).map((line) => line.replace(/^\s*[-*]\s+/, "").trim())
    const hasPlaceholder = /<!--\s*CABBAGE:/i.test(body) || strippedLines.some((l) => LEGACY_PLACEHOLDERS.has(l))
    if (hasPlaceholder) {
      errors.push(`${stage.id}: placeholder content remains; replace all template prompts`)
    }
  }

  // Mermaid fences
  let inMermaid = false
  const mermaidBlocks: string[] = []
  let currentBlock: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const stripped = line.trim()
    if (!inMermaid && stripped.startsWith("```mermaid")) {
      inMermaid = true
      currentBlock = []
    } else if (inMermaid && stripped === "```") {
      inMermaid = false
      mermaidBlocks.push(currentBlock.join("\n"))
    } else if (inMermaid) {
      currentBlock.push(line)
    }
  }
  if (inMermaid) {
    errors.push(`${stage.id}: unclosed Mermaid block`)
  }
  for (const block of mermaidBlocks) {
    const cleanLines = block.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("%%"))
    if (cleanLines.length === 0) {
      errors.push(`${stage.id}: empty Mermaid diagram block`)
    } else if (!MERMAID_TYPES.some((t) => cleanLines[0].startsWith(t))) {
      errors.push(`${stage.id}: Mermaid block missing recognized diagram type (e.g. flowchart, sequenceDiagram)`)
    }
  }

  // Relative markdown links & anchors
  const resolvedRoot = path.resolve(root)
  const linkRe = /\[[^\]]*\]\(([^)]+)\)/g
  let match: RegExpExecArray | null
  while ((match = linkRe.exec(text)) !== null) {
    const rawTarget = match[1].trim().split(/\s+/)[0]?.replace(/^<|>$/g, "") ?? ""
    if (!rawTarget || /^(https?:|mailto:)/i.test(rawTarget)) continue
    const hashIdx = rawTarget.indexOf("#")
    const filePart = hashIdx >= 0 ? rawTarget.slice(0, hashIdx) : rawTarget
    const anchor = hashIdx >= 0 ? rawTarget.slice(hashIdx + 1).trim().toLowerCase() : null

    if (filePart) {
      const targetPath = path.resolve(path.dirname(artifactPath), filePart)
      const rel = path.relative(resolvedRoot, targetPath)
      if (rel.startsWith("..") || path.isAbsolute(rel)) {
        errors.push(`${stage.id}: link escapes project root: ${rawTarget}`)
        continue
      }
      if (!existsSync(targetPath)) {
        errors.push(`${stage.id}: broken local link: ${rawTarget}`)
        continue
      }
      if (statSync(targetPath).isDirectory()) {
        if (!existsSync(path.join(targetPath, "README.md")) && !existsSync(path.join(targetPath, "index.md"))) {
          errors.push(`${stage.id}: directory link missing README.md/index.md: ${rawTarget}`)
        }
      } else if (anchor && /\.(md|mdx)$/i.test(targetPath)) {
        const slugs = extractHeadingSlugs(readFileSync(targetPath, "utf8"))
        if (!slugs.has(anchor)) {
          errors.push(`${stage.id}: broken anchor in link: ${rawTarget}`)
        }
      }
    } else if (anchor) {
      const slugs = extractHeadingSlugs(text)
      if (!slugs.has(anchor)) {
        errors.push(`${stage.id}: broken internal anchor: #${anchor}`)
      }
    }
  }

  // Checklist validator
  if (stage.validator === "checklist") {
    const boxes = [...body.matchAll(/^\s*[-*]\s+\[([ xX\-/])\]/gm)].map((m) => m[1])
    if (boxes.length === 0) {
      errors.push(`${stage.id}: expected at least one task checkbox`)
    }
    if (verification && boxes.some((b) => b.trim() === "")) {
      errors.push(`${stage.id}: unchecked implementation tasks remain`)
    }
  }

  return errors
}

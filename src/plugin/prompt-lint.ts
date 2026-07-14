import { globSync } from "node:fs"
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"

export interface LintFinding {
  severity: "error" | "warn"
  file: string
  rule: string
  message: string
}

const CONTRACT_SECTIONS = [
  "Trigger", "Inputs", "Preconditions", "Procedure",
  "Outputs", "Failure", "Idempotency", "Prohibited Actions",
]

const FORBIDDEN_PATTERNS: Array<{ pattern: RegExp; rule: string; message: string }> = [
  // Only flag direct pushes to hardcoded branches, not tag pushes
  { pattern: /\bgit push origin main\b(?!\s+--tags)/, rule: "no-hardcoded-default-branch", message: "contains hardcoded 'git push origin main'" },
  { pattern: /\bgit push origin master\b(?!\s+--tags)/, rule: "no-hardcoded-default-branch", message: "contains hardcoded 'git push origin master'" },
  { pattern: /\bgit push origin dev\b(?!\s+--tags)/, rule: "no-hardcoded-default-branch", message: "contains hardcoded 'git push origin dev'" },
  { pattern: /^\s*git add \.\s*$/m, rule: "no-blanket-git-add", message: "contains blanket 'git add .' without context" },
  { pattern: /git worktree remove.*--force/, rule: "no-default-force-cleanup", message: "contains default --force worktree cleanup" },
]

function findMdFiles(root: string, dirs: string[]): string[] {
  const results: string[] = []
  for (const dir of dirs) {
    const full = path.join(root, dir)
    if (!existsSync(full)) continue
    const pattern = path.join(full, "**", "*.md").replace(/\\/g, "/")
    results.push(...globSync(pattern))
  }
  return results
}

function checkRelativeRefs(content: string, filePath: string): LintFinding[] {
  const findings: LintFinding[] = []
  const refPattern = /`([^`]*\.md)`/g
  let match
  while ((match = refPattern.exec(content)) !== null) {
    const ref = match[1]
    if (ref.startsWith("/") || ref.startsWith("http")) continue
    if (ref.includes("_prompts/") || ref.includes("_context/")) continue
    if (ref.includes("<") && ref.includes(">")) continue
    // only flag paths starting with ../ or ./
    if (!ref.startsWith(".")) continue
    const dir = path.dirname(filePath)
    const resolved = path.resolve(dir, ref)
    if (!existsSync(resolved)) {
      findings.push({
        severity: "error",
        file: filePath,
        rule: "broken-reference",
        message: `references non-existent file: \`${ref}\``,
      })
    }
  }
  return findings
}

function checkContractCompleteness(content: string, filePath: string): LintFinding[] {
  const findings: LintFinding[] = []
  for (const section of CONTRACT_SECTIONS) {
    const headingRegex = new RegExp(`^### ${section}$`, "m")
    if (!headingRegex.test(content)) {
      findings.push({
        severity: "warn",
        file: filePath,
        rule: "missing-contract-section",
        message: `missing Contract section: ### ${section}`,
      })
    }
  }
  return findings
}

function checkForbiddenPatterns(content: string, filePath: string): LintFinding[] {
  const findings: LintFinding[] = []
  for (const { pattern, rule, message } of FORBIDDEN_PATTERNS) {
    if (pattern.test(content)) {
      findings.push({
        severity: "error",
        file: filePath,
        rule,
        message,
      })
    }
  }
  return findings
}

function checkAgentCapabilityConsistency(content: string, filePath: string): LintFinding[] {
  const findings: LintFinding[] = []
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) return findings

  const fm = frontmatterMatch[1]
  const body = content.slice(frontmatterMatch[0].length)

  // Check reviewer: complete_goal must be false, and must not contain positive directive
  if (filePath.includes("reviewer")) {
    if (/complete_goal:\s*true/.test(fm)) {
      findings.push({
        severity: "error",
        file: filePath,
        rule: "reviewer-capability-conflict",
        message: "reviewer agent declares complete_goal: true (should be false)",
      })
    }
    // Only flag goal({op:"complete"}) if it's not in a negation/prohibition context
    if (/\bgoal\(\{op:"complete"\}\)/.test(body)) {
      // Check if the surrounding context is a prohibition
      const idx = body.indexOf("goal({op:\"complete\"})")
      const before = body.slice(Math.max(0, idx - 100), idx)
      const isNegation = /不调用|不.*complete|not.*complete|cannot complete|blocked/i.test(before)
      if (!isNegation) {
        findings.push({
          severity: "error",
          file: filePath,
          rule: "reviewer-capability-conflict",
          message: "reviewer prompt contains positive goal({op:'complete'}) directive",
        })
      }
    }
  }

  // Check worker agents: create_pr must be false
  if (filePath.includes("backend") || filePath.includes("frontend")) {
    if (/create_pr:\s*true/.test(fm)) {
      findings.push({
        severity: "error",
        file: filePath,
        rule: "worker-capability-conflict",
        message: "worker agent declares create_pr: true (should be false)",
      })
    }
    if (body.includes("gh pr create")) {
      findings.push({
        severity: "error",
        file: filePath,
        rule: "worker-capability-conflict",
        message: "worker prompt contains 'gh pr create' directive",
      })
    }
  }

  return findings
}

export function lintAll(projectRoot: string): { findings: LintFinding[]; passed: boolean } {
  const assetDirs = ["assets/agents", "assets/skills", "assets/commands", "assets/prompts"]
  const files = findMdFiles(projectRoot, assetDirs)
  const allFindings: LintFinding[] = []

  for (const file of files) {
    const content = readFileSync(file, "utf8")

    if (file.includes("SKILL.md")) {
      allFindings.push(...checkContractCompleteness(content, file))
    }
    allFindings.push(...checkForbiddenPatterns(content, file))
    allFindings.push(...checkRelativeRefs(content, file))

    if (file.includes("agents/")) {
      allFindings.push(...checkAgentCapabilityConsistency(content, file))
    }
  }

  const errors = allFindings.filter(f => f.severity === "error")
  const warnings = allFindings.filter(f => f.severity === "warn")

  return {
    findings: allFindings,
    passed: errors.length === 0,
  }
}

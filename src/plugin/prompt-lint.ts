import { globSync } from "node:fs"
import { readFileSync, existsSync } from "node:fs"
import path from "node:path"
import { parse as parseYaml } from "yaml"
import { permissionPatternMatches } from "../kernel/permission.js"

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

/** 残留引用：skill 名 / 命令引用（反引号、加粗、列表项） */
const HANDOFF_TEST_RESIDUE_PATTERNS: Array<{ pattern: RegExp; rule: string; message: string }> = [
  { pattern: /\bflow-handoff\b|\bflow-test\b/, rule: "handoff-test-residue", message: "references removed skill flow-handoff / flow-test" },
  { pattern: /`\/(test|handoff)`/, rule: "handoff-test-residue", message: "references removed command /test / /handoff" },
  { pattern: /\*\*\/test\*\*|\*\*\/handoff\*\*/, rule: "handoff-test-residue", message: "references removed command /test / /handoff" },
  { pattern: /^\s*[-*]\s*\/(test|handoff)\b/m, rule: "handoff-test-residue", message: "references removed command /test / /handoff" },
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

/** R12：content 中残留 flow-handoff/flow-test skill 或 /test /handoff 命令引用 */
function checkHandoffTestResidue(content: string, filePath: string): LintFinding[] {
  const findings: LintFinding[] = []
  for (const { pattern, rule, message } of HANDOFF_TEST_RESIDUE_PATTERNS) {
    if (pattern.test(content)) {
      findings.push({ severity: "error", file: filePath, rule, message })
      break
    }
  }
  return findings
}

function parseAgentName(frontmatter: string): string | undefined {
  try {
    const parsed = parseYaml(frontmatter) as Record<string, unknown>
    return typeof parsed?.name === "string" ? parsed.name : undefined
  } catch {
    return undefined
  }
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
  if (parseAgentName(fm) === "developer") {
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

function isWorkerAgent(content: string): boolean {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) return false
  return parseAgentName(frontmatterMatch[1]) === "developer"
}

function isReviewerAgent(filePath: string): boolean {
  return filePath.includes("reviewer")
}

/** V2 原生权限规则（宿主 `permissions: PermissionRule[]` 子集） */
interface NativePermissionRule {
  action: string
  resource: string
  effect: string
}

/** 解析 frontmatter 的原生 permissions 数组；缺失/非数组返回 null，结构不完整的条目跳过 */
function parseNativePermissions(fm: string): NativePermissionRule[] | null {
  let raw: unknown
  try {
    raw = (parseYaml(fm) as Record<string, unknown>)?.permissions
  } catch {
    return null
  }
  if (!Array.isArray(raw)) return null
  const rules: NativePermissionRule[] = []
  for (const item of raw) {
    if (!item || typeof item !== "object" || Array.isArray(item)) continue
    const { action, resource, effect } = item as Record<string, unknown>
    if (typeof action !== "string" || typeof resource !== "string" || typeof effect !== "string") continue
    rules.push({ action, resource, effect })
  }
  return rules
}

/** 规则数组是否可能放行该命令形态（action 匹配 + resource 命中 + 非 deny） */
function permissionRulesAllowCommand(
  rules: NativePermissionRule[],
  action: string,
  commandPattern: string,
): boolean {
  return rules.some(
    (rule) => rule.action === action && rule.effect !== "deny" && permissionPatternMatches(rule.resource, commandPattern),
  )
}

/** 是否存在显式放行的非 "*" bash 规则（bash 可用性的粗判） */
function bashPermissionsAllowAny(rules: NativePermissionRule[]): boolean {
  return rules.some((rule) => rule.action === "bash" && rule.resource !== "*" && rule.effect !== "deny")
}

function checkAgentPermission(content: string, filePath: string): LintFinding[] {
  const findings: LintFinding[] = []
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/)
  if (!frontmatterMatch) return findings

  const fm = frontmatterMatch[1]

  if (!/^permissions:/m.test(fm)) {
    findings.push({
      severity: "warn",
      file: filePath,
      rule: "missing-permission",
      message: "agent frontmatter is missing 'permissions' field",
    })
    return findings
  }

  const rules = parseNativePermissions(fm) ?? []
  const editRules = rules.filter((rule) => rule.action === "edit")
  const isEditDenied = editRules.length > 0 && editRules.every((rule) => rule.effect === "deny")

  // Rule: Worker must not allow gh pr create|merge in bash permissions
  if (isWorkerAgent(content)) {
    if (permissionRulesAllowCommand(rules, "bash", "gh pr create") ||
        permissionRulesAllowCommand(rules, "bash", "gh pr merge")) {
      findings.push({
        severity: "error",
        file: filePath,
        rule: "worker-gh-write-permission",
        message: "worker agent declares gh pr create/merge allow in bash permissions",
      })
    }
  }

  // Rule: Reviewer must deny edit permissions
  if (isReviewerAgent(filePath) && !isEditDenied) {
    findings.push({
      severity: "error",
      file: filePath,
      rule: "reviewer-write-permission",
      message: `reviewer agent must declare edit permissions with effect "deny"`,
    })
  }

  // Rule: capabilities vs permission consistency
  const modifyFiles = fm.match(/^\s+modify_files:\s*(true|false)/m)
  const runTests = fm.match(/^\s+run_tests:\s*(true|false)/m)
  const pushBranch = fm.match(/^\s+push_branch:\s*(true|false)/m)

  if (modifyFiles?.[1] === "true" && isEditDenied) {
    findings.push({
      severity: "warn",
      file: filePath,
      rule: "capability-permission-mismatch",
      message: "capabilities.modify_files is true but edit permissions are deny",
    })
  }

  if (runTests?.[1] === "true" && !bashPermissionsAllowAny(rules)) {
    findings.push({
      severity: "warn",
      file: filePath,
      rule: "capability-permission-mismatch",
      message: "capabilities.run_tests is true but bash permissions are not declared or are deny",
    })
  }

  if (pushBranch?.[1] === "true" && !permissionRulesAllowCommand(rules, "bash", "git push")) {
    findings.push({
      severity: "warn",
      file: filePath,
      rule: "capability-permission-mismatch",
      message: "capabilities.push_branch is true but bash permissions do not include 'git push'",
    })
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
    allFindings.push(...checkHandoffTestResidue(content, file))
    allFindings.push(...checkRelativeRefs(content, file))

    if (file.includes("agents/")) {
      allFindings.push(...checkAgentCapabilityConsistency(content, file))
      allFindings.push(...checkAgentPermission(content, file))
    }
  }

  const errors = allFindings.filter(f => f.severity === "error")

  return {
    findings: allFindings,
    passed: errors.length === 0,
  }
}

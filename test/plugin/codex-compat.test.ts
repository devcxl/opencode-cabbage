import { describe, it, expect } from "vitest"
import path from "node:path"
import fs from "node:fs"

const PROJECT_ROOT = path.resolve(import.meta.dirname || __dirname, "..", "..")

function readJson(rel: string): Record<string, unknown> {
  const raw = fs.readFileSync(path.join(PROJECT_ROOT, rel), "utf8")
  return JSON.parse(raw) as Record<string, unknown>
}

function listSkillNames(dirRel: string): string[] {
  const dir = path.join(PROJECT_ROOT, dirRel)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort()
}

/** 解析 SKILL.md frontmatter 的 name/description */
function parseSkillMeta(skillDir: string): { name: string; description: string } {
  const content = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8")
  const m = content.match(/^---\n([\s\S]*?)\n---/)
  if (!m) throw new Error(`SKILL.md missing frontmatter: ${skillDir}`)
  const name = m[1].match(/^name:\s*(.+)$/m)?.[1]?.trim() ?? ""
  const description = m[1].match(/^description:\s*(.+)$/m)?.[1]?.trim() ?? ""
  return { name, description }
}

/** Codex 侧 agent 引用为 @agent-xxx，assets 侧为 @xxx —— 归一后比较 */
function normalizeAgentRefs(content: string): string {
  return content.replace(/@agent-([a-z0-9-]+)/g, "@$1")
}

describe("codex plugin manifest (.codex-plugin/plugin.json)", () => {
  const manifest = readJson(".codex-plugin/plugin.json")
  const pkg = readJson("package.json")

  it("is valid JSON and has required fields", () => {
    expect(manifest.name).toBe("opencode-cabbage")
    expect(typeof manifest.skills).toBe("string")
    expect(manifest.interface).toBeTruthy()
  })

  it("skills field points to an existing directory", () => {
    const skillsRel = (manifest.skills as string).replace(/^\.\//, "")
    expect(fs.existsSync(path.join(PROJECT_ROOT, skillsRel))).toBe(true)
    expect(fs.statSync(path.join(PROJECT_ROOT, skillsRel)).isDirectory()).toBe(true)
  })

  it("version stays in sync with package.json", () => {
    expect(manifest.version).toBe(pkg.version)
  })

  it("uses a valid category from the official enum", () => {
    const category = (manifest.interface as Record<string, unknown>).category
    expect(["Developer Tools", "Productivity", "Utilities", "Data & Analytics"]).toContain(category)
  })

  it("has no app @mention in defaultPrompt (rejected by marketplace)", () => {
    const defaultPrompt = (manifest.interface as Record<string, unknown>).defaultPrompt as string[]
    for (const p of defaultPrompt) {
      expect(p).not.toMatch(/@[a-z-]+/)
    }
  })

  it("does not declare hooks (default ./hooks/hooks.json is auto-loaded)", () => {
    expect(manifest.hooks).toBeUndefined()
  })
})

describe("codex hooks (hooks/hooks.json)", () => {
  const hooksJson = readJson("hooks/hooks.json")
  const hooks = hooksJson.hooks as Record<string, Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>>

  it("is valid JSON with SessionStart event", () => {
    expect(hooks.SessionStart).toBeDefined()
    expect(Array.isArray(hooks.SessionStart)).toBe(true)
  })

  it("each hook group has a matcher (prevents re-injection on compact)", () => {
    for (const group of hooks.SessionStart) {
      expect(typeof group.matcher).toBe("string")
      expect(group.matcher!.length).toBeGreaterThan(0)
    }
  })

  it("uses timeout (seconds) — no invalid timeoutMs field", () => {
    for (const group of hooks.SessionStart) {
      for (const hook of group.hooks) {
        expect(hook.timeoutMs).toBeUndefined()
        expect(typeof hook.timeout).toBe("number")
        expect(hook.timeout as number).toBeGreaterThan(0)
      }
    }
  })

  it("commands target compiled dist/ artifacts under ${PLUGIN_ROOT}", () => {
    for (const group of hooks.SessionStart) {
      for (const hook of group.hooks) {
        const cmd = String(hook.command)
        expect(cmd).toMatch(/\$\{PLUGIN_ROOT\}\/dist\//)
        // 对应源文件必须存在且被 tsc 覆盖（rootDir=src）
        const srcRel = cmd.replace(/^node\s+/, "").replace(/\$\{PLUGIN_ROOT\}\/dist\//, "src/").replace(/\.js$/, ".ts")
        expect(fs.existsSync(path.join(PROJECT_ROOT, srcRel))).toBe(true)
      }
    }
  })
})

describe("codex skills drift vs assets", () => {
  const codexFlows = listSkillNames("codex-skills").filter((n) => n.startsWith("flow-"))
  const assetFlows = listSkillNames("assets/skills")

  it("flow-* coverage matches assets/skills exactly (9/9)", () => {
    expect(codexFlows).toEqual(assetFlows)
  })

  it("flow-* SKILL.md contents match assets after agent-ref normalization", () => {
    for (const name of codexFlows) {
      const codex = fs.readFileSync(path.join(PROJECT_ROOT, "codex-skills", name, "SKILL.md"), "utf8")
      const asset = fs.readFileSync(path.join(PROJECT_ROOT, "assets", "skills", name, "SKILL.md"), "utf8")
      expect(normalizeAgentRefs(codex), `${name}: codex copy drifted from assets`).toBe(asset)
    }
  })

  it("agent-* skills cover all upstream agents (dev-lifecycle + team/*)", () => {
    const teamDir = path.join(PROJECT_ROOT, "assets", "agents", "team")
    const teamAgents = fs
      .readdirSync(teamDir)
      .filter((f) => f.endsWith(".md"))
      .map((f) => f.replace(/\.md$/, ""))
    const upstreamAgents = ["dev-lifecycle", ...teamAgents]
    const codexAgents = listSkillNames("codex-skills").filter((n) => n.startsWith("agent-"))
    const mapped = codexAgents.map((n) => n.replace(/^agent-/, "")).sort()
    expect(mapped).toEqual(upstreamAgents.sort())
  })

  it("every codex skill has valid name/description frontmatter", () => {
    for (const name of listSkillNames("codex-skills")) {
      const meta = parseSkillMeta(path.join(PROJECT_ROOT, "codex-skills", name))
      expect(meta.name).toBe(name)
      expect(meta.description.length).toBeGreaterThan(0)
    }
  })

  it("no OpenCode-kernel-only constructs in codex skills (goal tool / continuation / autoResume)", () => {
    const banned = [/goal\(\{op:/, /autoResume/, /continuation prompt/i]
    for (const name of listSkillNames("codex-skills")) {
      const content = fs.readFileSync(path.join(PROJECT_ROOT, "codex-skills", name, "SKILL.md"), "utf8")
      for (const re of banned) {
        expect(content, `${name}: banned construct ${re}`).not.toMatch(re)
      }
    }
  })
})

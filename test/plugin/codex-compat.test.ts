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

/** 递归列出目录内全部文件（相对路径，字典序） */
function listFilesRecursive(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...listFilesRecursive(full, base))
    else out.push(path.relative(base, full))
  }
  return out.sort()
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

  it("longDescription skill counts match the shipped codex skills", () => {
    const longDescription = String((manifest.interface as Record<string, unknown>).longDescription ?? "")
    const skills = listSkillNames("codex-skills")
    const flowCount = skills.filter((n) => n.startsWith("flow-")).length
    const agentCount = skills.filter((n) => n.startsWith("agent-")).length
    expect(longDescription).toContain(`${flowCount} 个 flow skills`)
    expect(longDescription).toContain(`${agentCount} 个 agent skills`)
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

describe("codex SessionStart hook inventory", () => {
  it("advertises exactly the codex skills that exist (no stale list)", () => {
    const hookSrc = fs.readFileSync(path.join(PROJECT_ROOT, "src", "hooks", "session-start.ts"), "utf8")
    const mentioned = new Set(Array.from(hookSrc.matchAll(/@((?:flow|agent)-[a-z-]+)/g)).map((m) => m[1]))
    expect([...mentioned].sort()).toEqual(listSkillNames("codex-skills"))
  })
})

describe("codex skills drift vs assets", () => {
  const codexFlows = listSkillNames("codex-skills").filter((n) => n.startsWith("flow-"))
  const assetFlows = listSkillNames("assets/skills")

  it("flow-* coverage matches assets/skills exactly", () => {
    expect(codexFlows).toEqual(assetFlows)
  })

  it("flow-* trees match assets (SKILL.md normalized; other files byte-identical)", () => {
    for (const name of codexFlows) {
      const codexDir = path.join(PROJECT_ROOT, "codex-skills", name)
      const assetDir = path.join(PROJECT_ROOT, "assets", "skills", name)
      const codexFiles = listFilesRecursive(codexDir)
      const assetFiles = listFilesRecursive(assetDir)
      expect(codexFiles, `${name}: codex file set drifted from assets`).toEqual(assetFiles)
      for (const rel of codexFiles) {
        const codex = fs.readFileSync(path.join(codexDir, rel), "utf8")
        const asset = fs.readFileSync(path.join(assetDir, rel), "utf8")
        if (rel === "SKILL.md") {
          expect(normalizeAgentRefs(codex), `${name}/SKILL.md: codex copy drifted from assets`).toBe(asset)
        } else {
          expect(codex, `${name}/${rel}: codex copy drifted from assets`).toBe(asset)
        }
      }
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

describe("codex marketplace (.agents/plugins/marketplace.json)", () => {
  const marketplace = readJson(".agents/plugins/marketplace.json") as {
    name: string
    interface: Record<string, unknown>
    plugins: Array<Record<string, unknown>>
  }
  const entry = marketplace.plugins[0]

  it("is valid JSON with name, interface and plugins entries", () => {
    expect(typeof marketplace.name).toBe("string")
    expect(marketplace.interface).toBeTruthy()
    expect(Array.isArray(marketplace.plugins)).toBe(true)
  })

  it("plugin entry matches manifest name and has required policy fields", () => {
    expect(entry).toBeTruthy()
    expect(entry.name).toBe("opencode-cabbage")
    const policy = entry.policy as Record<string, unknown>
    expect(policy.installation).toBe("AVAILABLE")
    expect(policy.authentication).toBe("ON_INSTALL")
  })

  it("source resolves to this repo (local plugin root with manifest)", () => {
    const source = entry.source as Record<string, unknown>
    expect(source.source).toBe("local")
    const pluginRoot = path.join(PROJECT_ROOT, String(source.path).replace(/^\.\//, ""))
    expect(fs.existsSync(path.join(pluginRoot, ".codex-plugin", "plugin.json"))).toBe(true)
    expect(fs.existsSync(path.join(pluginRoot, "codex-skills"))).toBe(true)
    expect(fs.existsSync(path.join(pluginRoot, "hooks", "hooks.json"))).toBe(true)
  })

  it("uses a valid category from the official enum", () => {
    expect(["Developer Tools", "Productivity", "Utilities", "Data & Analytics"]).toContain(entry.category)
  })
})

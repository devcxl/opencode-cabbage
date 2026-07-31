import { describe, it, expect } from "vitest"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  parseProjectProfile,
  readProjectProfile,
  upsertProjectProfile,
  emptyProfile,
  PROFILE_SECTION_TITLE,
} from "../../src/kernel/profile.js"

const FULL_BLOCK = `## Project Profile

- test command: \`npm test -- run\`
- regression command: \`npm run test:regression\`
- test file patterns: \`test/**/*.test.ts\`
- implementation file patterns: \`src/**/*.ts\`
- tdd default mode: \`strict\`
- version bump rule: \`breaking→major, feature→minor, fix→patch\`
- version file: \`package.json\`
- tag format: \`v{version}\`
- release workflow: \`.github/workflows/release.yml\`
- risk patterns: \`migrations/**, **/auth/**, **/permissions/**\`
`

describe("parseProjectProfile", () => {
  it("parses a well-formed profile section into structured fields", () => {
    const { profile, warnings } = parseProjectProfile(FULL_BLOCK)
    expect(warnings).toEqual([])
    expect(profile).toEqual({
      testCommand: "npm test -- run",
      regressionCommand: "npm run test:regression",
      testFilePatterns: ["test/**/*.test.ts"],
      implementationFilePatterns: ["src/**/*.ts"],
      tddDefaultMode: "strict",
      versionBumpRule: "breaking→major, feature→minor, fix→patch",
      versionFile: "package.json",
      tagFormat: "v{version}",
      releaseWorkflowPath: ".github/workflows/release.yml",
      riskPatterns: ["migrations/**", "**/auth/**", "**/permissions/**"],
    })
  })

  it("stops at the next heading, ignoring later content", () => {
    const markdown = `${FULL_BLOCK}\n## Other Section\n\n- test command: \`ignored\`\n`
    const { profile } = parseProjectProfile(markdown)
    expect(profile.testCommand).toBe("npm test -- run")
  })

  it("strips backticks and surrounding whitespace from values", () => {
    const markdown = "## Project Profile\n\n- test command: `  npm test -- run  `\n"
    const { profile } = parseProjectProfile(markdown)
    expect(profile.testCommand).toBe("npm test -- run")
  })

  it("splits comma-separated pattern lists", () => {
    const markdown = "## Project Profile\n\n- implementation file patterns: `src/**/*.ts, src/kernel/**/*.ts, src/util/**/*.ts`\n"
    const { profile } = parseProjectProfile(markdown)
    expect(profile.implementationFilePatterns).toEqual([
      "src/**/*.ts",
      "src/kernel/**/*.ts",
      "src/util/**/*.ts",
    ])
  })

  it("reports unknown keys as warnings without blocking known keys", () => {
    const markdown = "## Project Profile\n\n- mystery key: `value`\n- test command: `npm test`\n"
    const { profile, warnings } = parseProjectProfile(markdown)
    expect(profile.testCommand).toBe("npm test")
    expect(warnings).toEqual(["Unknown profile key: mystery key"])
  })

  it("takes the last value when a key is repeated", () => {
    const markdown = "## Project Profile\n\n- test command: `first`\n- test command: `second`\n"
    const { profile } = parseProjectProfile(markdown)
    expect(profile.testCommand).toBe("second")
  })

  it("rejects a tag format without the {version} placeholder", () => {
    const markdown = "## Project Profile\n\n- tag format: `v1.0`\n"
    const { profile, warnings } = parseProjectProfile(markdown)
    expect(profile.tagFormat).toBeNull()
    expect(warnings.some(w => w.includes("tag format"))).toBe(true)
  })

  it("rejects an invalid tdd default mode", () => {
    const markdown = "## Project Profile\n\n- tdd default mode: `sometimes`\n"
    const { profile, warnings } = parseProjectProfile(markdown)
    expect(profile.tddDefaultMode).toBeNull()
    expect(warnings.some(w => w.includes("tdd default mode"))).toBe(true)
  })

  it("skips malformed lines without throwing", () => {
    const markdown = [
      "## Project Profile",
      "",
      "this is not a key-value line",
      "- ",
      "- test command:",
      "- broken key with ! char: `x`",
      "- test command: `npm test`",
    ].join("\n")
    const { profile, warnings } = parseProjectProfile(markdown)
    expect(profile.testCommand).toBe("npm test")
    expect(warnings).toEqual([])
  })

  it("returns an empty profile with no warnings when the section is missing", () => {
    const { profile, warnings } = parseProjectProfile("# Just a title\n\nsome text\n")
    expect(profile).toEqual(emptyProfile())
    expect(warnings).toEqual([])
  })

  it("returns an empty profile when the section has no entries", () => {
    const { profile } = parseProjectProfile(`${PROFILE_SECTION_TITLE}\n`)
    expect(profile).toEqual(emptyProfile())
  })
})

describe("readProjectProfile", () => {
  async function withProjectDir(agentMd: string | null, fn: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "cabbage-profile-"))
    try {
      if (agentMd !== null) {
        await writeFile(join(dir, "AGENTS.md"), agentMd)
      }
      await fn(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  it("returns an empty profile when AGENTS.md does not exist", async () => {
    await withProjectDir(null, async dir => {
      await expect(readProjectProfile(dir)).resolves.toEqual(emptyProfile())
    })
  })

  it("parses AGENTS.md when the profile section exists", async () => {
    await withProjectDir(FULL_BLOCK, async dir => {
      const profile = await readProjectProfile(dir)
      expect(profile.testCommand).toBe("npm test -- run")
      expect(profile.tagFormat).toBe("v{version}")
      expect(profile.riskPatterns).toEqual(["migrations/**", "**/auth/**", "**/permissions/**"])
    })
  })

  it("returns an empty profile when AGENTS.md lacks the section", async () => {
    await withProjectDir("# Rules\n\n- keep it simple\n", async dir => {
      await expect(readProjectProfile(dir)).resolves.toEqual(emptyProfile())
    })
  })
})

describe("upsertProjectProfile", () => {
  const block = FULL_BLOCK.trimEnd()

  it("appends the block to markdown without a profile section", () => {
    const markdown = "# Project Rules\n\n- be concise\n"
    const result = upsertProjectProfile(markdown, block)
    expect(result.startsWith(markdown.trimEnd())).toBe(true)
    expect(result).toContain(`\n\n${block}`)
  })

  it("returns the block alone for empty markdown", () => {
    expect(upsertProjectProfile("", block)).toBe(block)
  })

  it("replaces the existing profile section and keeps surrounding content", () => {
    const markdown = `# Project Rules\n\n- be concise\n\n## Project Profile\n\n- test command: \`old\`\n\n## Other Section\n\nkeep me`
    const result = upsertProjectProfile(markdown, block)
    expect(result).toContain("# Project Rules\n\n- be concise")
    expect(result).toContain("## Other Section\n\nkeep me")
    expect(result).not.toContain("old")
    expect(result).toContain(block)
  })
})

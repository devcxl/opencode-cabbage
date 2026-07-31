import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtemp, writeFile, mkdir, rm, chmod } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  probe,
  generateWorkflows,
  buildCiWorkflow,
  buildReleaseWorkflow,
  buildProfileBlock,
  confirmProjectProfile,
  setSetupGitExecutor,
  setSetupGhExecutor,
} from "../../src/kernel/setup.js"
import { readFile } from "node:fs/promises"

type CmdFn = (args: string, cwd?: string) => Promise<{ stdout: string; stderr: string }>

const FULL_PROFILE = `## Project Profile

- test command: \`cabbage-test-tool run\`
- test file patterns: \`test/**/*.test.ts\`
- implementation file patterns: \`src/**/*.ts\`
- tdd default mode: \`strict\`
- version bump rule: \`breaking→major, feature→minor, fix→patch\`
- version file: \`package.json\`
- tag format: \`v{version}\`
- release workflow: \`.github/workflows/release.yml\`
`

const READY_GIT: CmdFn = async (args) => {
  if (args === "--version") return { stdout: "git version 2.43.0", stderr: "" }
  if (args.startsWith("remote get-url")) return { stdout: "https://github.com/devcxl/opencode-cabbage.git", stderr: "" }
  if (args.includes("symbolic-ref")) return { stdout: "main", stderr: "" }
  throw new Error(`unexpected git call: ${args}`)
}

const READY_GH: CmdFn = async (args) => {
  if (args.startsWith("auth status")) return { stdout: "logged in", stderr: "" }
  if (args.includes("/protection")) return { stdout: "{}", stderr: "" }
  throw new Error(`unexpected gh call: ${args}`)
}

async function withProjectDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "cabbage-setup-"))
  try {
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function writeFixture(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel)
    await mkdir(join(abs, ".."), { recursive: true })
    await writeFile(abs, content)
  }
}

async function addFakeBin(fn: (binDir: string) => Promise<void>) {
  const binDir = await mkdtemp(join(tmpdir(), "cabbage-bin-"))
  const oldPath = process.env.PATH
  process.env.PATH = `${binDir}:${oldPath ?? ""}`
  try {
    await fn(binDir)
  } finally {
    process.env.PATH = oldPath
    await rm(binDir, { recursive: true, force: true })
  }
}

describe("probe", () => {
  beforeEach(() => {
    setSetupGitExecutor(() => {
      throw new Error("unexpected git call")
    })
    setSetupGhExecutor(() => {
      throw new Error("unexpected gh call")
    })
  })

  afterEach(() => {
    setSetupGitExecutor(null)
    setSetupGhExecutor(null)
  })

  it("reports development-ready and release-ready when everything is in place", async () => {
    await addFakeBin(async binDir => {
      await writeFile(join(binDir, "cabbage-test-tool"), "#!/bin/sh\nexit 0\n")
      await chmod(join(binDir, "cabbage-test-tool"), 0o755)

      await withProjectDir(async dir => {
        await writeFixture(dir, {
          "AGENTS.md": FULL_PROFILE,
          "CONTEXT.md": "# Domain Terms\n",
          ".github/workflows/ci.yml": "name: CI\non:\n  pull_request:\n",
          ".github/workflows/release.yml": "name: Release\n",
        })
        setSetupGitExecutor(READY_GIT)
        setSetupGhExecutor(READY_GH)

        const report = await probe(dir)
        expect(report.gitAvailable).toBe(true)
        expect(report.ghAuthenticated).toBe(true)
        expect(report.hasRemote).toBe(true)
        expect(report.defaultBranch).toBe("main")
        expect(report.profileConfirmed).toBe(true)
        expect(report.tddCommandExecutable).toBe(true)
        expect(report.ciWorkflow).toBe(".github/workflows/ci.yml")
        expect(report.releaseWorkflow).toBe(".github/workflows/release.yml")
        expect(report.contextMdPresent).toBe(true)
        expect(report.branchProtection).toBe(true)
        expect(report.versionRuleConfirmed).toBe(true)
        expect(report.developmentReady).toBe(true)
        expect(report.releaseReady).toBe(true)
      })
    })
  })

  it("reports development-ready=false when the profile is not confirmed", async () => {
    await withProjectDir(async dir => {
      await writeFixture(dir, { "AGENTS.md": "# Rules only\n" })
      setSetupGitExecutor(READY_GIT)
      setSetupGhExecutor(READY_GH)

      const report = await probe(dir)
      expect(report.profileConfirmed).toBe(false)
      expect(report.developmentReady).toBe(false)
      expect(report.releaseReady).toBe(false)
    })
  })

  it("reports development-ready=false when the CI workflow is missing", async () => {
    await addFakeBin(async binDir => {
      await writeFile(join(binDir, "cabbage-test-tool"), "#!/bin/sh\nexit 0\n")
      await chmod(join(binDir, "cabbage-test-tool"), 0o755)

      await withProjectDir(async dir => {
        await writeFixture(dir, {
          "AGENTS.md": FULL_PROFILE,
          "CONTEXT.md": "x",
          ".github/workflows/release.yml": "name: Release\n",
        })
        setSetupGitExecutor(READY_GIT)
        setSetupGhExecutor(READY_GH)

        const report = await probe(dir)
        expect(report.ciWorkflow).toBeNull()
        expect(report.developmentReady).toBe(false)
        expect(report.releaseReady).toBe(false)
      })
    })
  })

  it("reports development-ready=false when branch protection is missing", async () => {
    await addFakeBin(async binDir => {
      await writeFile(join(binDir, "cabbage-test-tool"), "#!/bin/sh\nexit 0\n")
      await chmod(join(binDir, "cabbage-test-tool"), 0o755)

      await withProjectDir(async dir => {
        await writeFixture(dir, {
          "AGENTS.md": FULL_PROFILE,
          "CONTEXT.md": "x",
          ".github/workflows/ci.yml": "name: CI\n",
          ".github/workflows/release.yml": "name: Release\n",
        })
        setSetupGitExecutor(READY_GIT)
        setSetupGhExecutor(async (args) => {
          if (args.startsWith("auth status")) return { stdout: "logged in", stderr: "" }
          if (args.includes("/protection")) throw new Error("HTTP 404: branch not protected")
          throw new Error(`unexpected gh call: ${args}`)
        })

        const report = await probe(dir)
        expect(report.branchProtection).toBe(false)
        expect(report.developmentReady).toBe(false)
        expect(report.releaseReady).toBe(false)
      })
    })
  })

  it("reports release-ready=false when version rules are incomplete", async () => {
    await addFakeBin(async binDir => {
      await writeFile(join(binDir, "cabbage-test-tool"), "#!/bin/sh\nexit 0\n")
      await chmod(join(binDir, "cabbage-test-tool"), 0o755)

      await withProjectDir(async dir => {
        const profileNoVersion = FULL_PROFILE.replace("- version bump rule: `breaking→major, feature→minor, fix→patch`\n", "")
        await writeFixture(dir, {
          "AGENTS.md": profileNoVersion,
          "CONTEXT.md": "x",
          ".github/workflows/ci.yml": "name: CI\n",
          ".github/workflows/release.yml": "name: Release\n",
        })
        setSetupGitExecutor(READY_GIT)
        setSetupGhExecutor(READY_GH)

        const report = await probe(dir)
        expect(report.versionRuleConfirmed).toBe(false)
        expect(report.releaseReady).toBe(false)
      })
    })
  })

  it("reports release-ready=false when the release workflow is missing", async () => {
    await addFakeBin(async binDir => {
      await writeFile(join(binDir, "cabbage-test-tool"), "#!/bin/sh\nexit 0\n")
      await chmod(join(binDir, "cabbage-test-tool"), 0o755)

      await withProjectDir(async dir => {
        await writeFixture(dir, {
          "AGENTS.md": FULL_PROFILE,
          "CONTEXT.md": "x",
          ".github/workflows/ci.yml": "name: CI\n",
        })
        setSetupGitExecutor(READY_GIT)
        setSetupGhExecutor(READY_GH)

        const report = await probe(dir)
        expect(report.releaseWorkflow).toBeNull()
        expect(report.releaseReady).toBe(false)
      })
    })
  })

  it("reports tddCommandExecutable=false when the test command is not on PATH", async () => {
    await withProjectDir(async dir => {
      await writeFixture(dir, { "AGENTS.md": FULL_PROFILE })
      setSetupGitExecutor(READY_GIT)
      setSetupGhExecutor(READY_GH)

      const report = await probe(dir)
      expect(report.tddCommandExecutable).toBe(false)
    })
  })

  it("reports gitAvailable=false when git fails", async () => {
    await withProjectDir(async dir => {
      setSetupGitExecutor(async () => {
        throw new Error("git: command not found")
      })
      setSetupGhExecutor(READY_GH)

      const report = await probe(dir)
      expect(report.gitAvailable).toBe(false)
      expect(report.developmentReady).toBe(false)
    })
  })

  it("does not crash when the repo has no github remote", async () => {
    await addFakeBin(async binDir => {
      await writeFile(join(binDir, "cabbage-test-tool"), "#!/bin/sh\nexit 0\n")
      await chmod(join(binDir, "cabbage-test-tool"), 0o755)

      await withProjectDir(async dir => {
        await writeFixture(dir, {
          "AGENTS.md": FULL_PROFILE,
          "CONTEXT.md": "x",
          ".github/workflows/ci.yml": "name: CI\n",
          ".github/workflows/release.yml": "name: Release\n",
        })
        setSetupGitExecutor(async (args) => {
          if (args === "--version") return { stdout: "git version 2.43.0", stderr: "" }
          if (args.startsWith("remote get-url")) throw new Error("remote not found")
          if (args.includes("symbolic-ref")) return { stdout: "main", stderr: "" }
          throw new Error(`unexpected git call: ${args}`)
        })
        setSetupGhExecutor(READY_GH)

        const report = await probe(dir)
        expect(report.hasRemote).toBe(false)
        expect(report.branchProtection).toBe(false)
        expect(report.developmentReady).toBe(false)
      })
    })
  })
})

describe("buildCiWorkflow / buildReleaseWorkflow", () => {
  it("builds a PR-triggered CI workflow using the profile test command", () => {
    const content = buildCiWorkflow("cabbage-test-tool run", "main")
    expect(content).toContain("name: CI")
    expect(content).toContain("pull_request:")
    expect(content).toContain("'main'")
    expect(content).toContain("- run: cabbage-test-tool run")
  })

  it("does not hardcode any package manager (tech-stack agnostic)", () => {
    const ci = buildCiWorkflow("cabbage-test-tool run", "main")
    const release = buildReleaseWorkflow("v{version}")
    expect(ci.toLowerCase()).not.toContain("npm")
    expect(release.toLowerCase()).not.toContain("npm")
  })

  it("uses a placeholder test command when the profile has none", () => {
    const content = buildCiWorkflow(null, null)
    expect(content).toContain("<test-command>")
    expect(content).toContain("'**'")
  })

  it("builds a tag-triggered release workflow placeholder with the profile tag format", () => {
    const content = buildReleaseWorkflow("v{version}")
    expect(content).toContain("name: Release")
    expect(content).toContain("tags:")
    expect(content).toContain("'v{version}'")
  })
})

describe("generateWorkflows", () => {
  beforeEach(() => {
    setSetupGitExecutor(() => {
      throw new Error("unexpected git call")
    })
    setSetupGhExecutor(() => {
      throw new Error("unexpected gh call")
    })
  })

  afterEach(() => {
    setSetupGitExecutor(null)
    setSetupGhExecutor(null)
  })

  it("generates missing CI and release workflows and opens a setup PR", async () => {
    await withProjectDir(async dir => {
      await writeFixture(dir, { "AGENTS.md": FULL_PROFILE })
      const gitCalls: string[] = []
      const ghCalls: string[] = []
      setSetupGitExecutor(async (args) => {
        gitCalls.push(args)
        if (args.includes("symbolic-ref")) return { stdout: "main", stderr: "" }
        return { stdout: "", stderr: "" }
      })
      setSetupGhExecutor(async (args) => {
        ghCalls.push(args)
        return { stdout: "99", stderr: "" }
      })

      const result = await generateWorkflows(dir, { prTitle: "chore: add workflow drafts", defaultBranch: "main" })

      expect(result.ok).toBe(true)
      expect(result.created).toEqual([
        ".github/workflows/ci.yml",
        ".github/workflows/release.yml",
      ])

      const ci = await readFile(join(dir, ".github/workflows/ci.yml"), "utf8")
      expect(ci).toContain("- run: cabbage-test-tool run")
      const release = await readFile(join(dir, ".github/workflows/release.yml"), "utf8")
      expect(release).toContain("'v{version}'")

      expect(gitCalls).toEqual([
        "checkout -b chore/setup-workflows",
        "add .github/workflows",
        "commit -m 'chore: add workflow drafts'",
        "push -u origin chore/setup-workflows",
      ])
      expect(ghCalls.some(c => c.startsWith("pr create"))).toBe(true)
      expect(ghCalls[ghCalls.length - 1]).toContain("--head chore/setup-workflows")
      expect(result.prNumber).toBe(99)
      expect(result.branch).toBe("chore/setup-workflows")
    })
  })

  it("does not regenerate existing workflows and skips git/gh when nothing is missing", async () => {
    await withProjectDir(async dir => {
      await writeFixture(dir, {
        "AGENTS.md": FULL_PROFILE,
        ".github/workflows/ci.yml": "name: CI\n",
        ".github/workflows/release.yml": "name: Release\n",
      })
      const gitCalls: string[] = []
      const ghCalls: string[] = []
      setSetupGitExecutor(async (args) => {
        gitCalls.push(args)
        return { stdout: "", stderr: "" }
      })
      setSetupGhExecutor(async (args) => {
        ghCalls.push(args)
        return { stdout: "", stderr: "" }
      })

      const result = await generateWorkflows(dir, { prTitle: "chore: noop", defaultBranch: "main" })

      expect(result.ok).toBe(true)
      expect(result.created).toEqual([])
      expect(result.existing.sort()).toEqual([
        ".github/workflows/ci.yml",
        ".github/workflows/release.yml",
      ])
      expect(result.branch).toBeNull()
      expect(gitCalls).toEqual([])
      expect(ghCalls).toEqual([])
    })
  })

  it("generates only the missing release workflow when CI already exists", async () => {
    await withProjectDir(async dir => {
      await writeFixture(dir, {
        "AGENTS.md": FULL_PROFILE,
        ".github/workflows/ci.yml": "name: CI\n",
      })
      const gitCalls: string[] = []
      setSetupGitExecutor(async (args) => {
        gitCalls.push(args)
        if (args.includes("symbolic-ref")) return { stdout: "main", stderr: "" }
        return { stdout: "", stderr: "" }
      })
      setSetupGhExecutor(async () => ({ stdout: "7", stderr: "" }))

      const result = await generateWorkflows(dir, { prTitle: "chore: add release workflow", defaultBranch: "main" })

      expect(result.created).toEqual([".github/workflows/release.yml"])
      expect(result.existing).toEqual([".github/workflows/ci.yml"])
      expect(gitCalls[0]).toBe("checkout -b chore/setup-workflows")
    })
  })

  it("uses a placeholder test command in CI when no profile test command exists", async () => {
    await withProjectDir(async dir => {
      const gitCalls: string[] = []
      setSetupGitExecutor(async (args) => {
        gitCalls.push(args)
        if (args.includes("symbolic-ref")) return { stdout: "main", stderr: "" }
        return { stdout: "", stderr: "" }
      })
      setSetupGhExecutor(async () => ({ stdout: "1", stderr: "" }))

      await generateWorkflows(dir, { prTitle: "chore: add workflows" })

      const ci = await readFile(join(dir, ".github/workflows/ci.yml"), "utf8")
      expect(ci).toContain("<test-command>")
    })
  })
})

describe("buildProfileBlock", () => {
  it("builds a full Project Profile block from confirmed overrides", () => {
    const block = buildProfileBlock({
      testCommand: "npm test -- run",
      testFilePatterns: ["test/**/*.test.ts"],
      implementationFilePatterns: ["src/**/*.ts", "src/kernel/**/*.ts"],
      tddDefaultMode: "strict",
      versionBumpRule: "breaking→major, feature→minor, fix→patch",
      versionFile: "package.json",
      tagFormat: "v{version}",
      releaseWorkflowPath: ".github/workflows/release.yml",
    })
    expect(block).toContain("## Project Profile")
    expect(block).toContain("- test command: `npm test -- run`")
    expect(block).toContain("- test file patterns: `test/**/*.test.ts`")
    expect(block).toContain("- implementation file patterns: `src/**/*.ts, src/kernel/**/*.ts`")
    expect(block).toContain("- tdd default mode: `strict`")
    expect(block).toContain("- version file: `package.json`")
    expect(block).toContain("- tag format: `v{version}`")
    expect(block).toContain("- release workflow: `.github/workflows/release.yml`")
  })

  it("omits keys that are not provided", () => {
    const block = buildProfileBlock({ testCommand: "cabbage-test-tool run" })
    expect(block).toContain("- test command: `cabbage-test-tool run`")
    expect(block).not.toContain("version")
  })
})

describe("confirmProjectProfile", () => {
  it("appends the profile block to AGENTS.md when none exists", async () => {
    await withProjectDir(async dir => {
      await writeFixture(dir, { "AGENTS.md": "# Project Rules\n\n- be concise\n" })

      const result = await confirmProjectProfile(dir, JSON.stringify({ testCommand: "cabbage-test-tool run" }))

      expect(result.ok).toBe(true)
      if (result.ok) expect(result.block).toContain("cabbage-test-tool run")

      const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf8")
      expect(agentsMd).toContain("## Project Profile")
      expect(agentsMd).toContain("- test command: `cabbage-test-tool run`")
    })
  })

  it("replaces an existing profile block and keeps surrounding content", async () => {
    await withProjectDir(async dir => {
      await writeFixture(dir, {
        "AGENTS.md": "# Rules\n\n## Project Profile\n\n- test command: `old`\n\n## Other\n\nkeep me\n",
      })

      const result = await confirmProjectProfile(dir, JSON.stringify({ testCommand: "new-tool run" }))

      expect(result.ok).toBe(true)
      const agentsMd = await readFile(join(dir, "AGENTS.md"), "utf8")
      expect(agentsMd).toContain("# Rules")
      expect(agentsMd).toContain("## Other\n\nkeep me")
      expect(agentsMd).toContain("- test command: `new-tool run`")
      expect(agentsMd).not.toContain("old")
    })
  })

  it("rejects when testCommand is missing", async () => {
    await withProjectDir(async dir => {
      await writeFixture(dir, { "AGENTS.md": "# Rules\n" })
      const result = await confirmProjectProfile(dir, JSON.stringify({ versionBumpRule: "breaking→major" }))
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe("POLICY_INVALID")
    })
  })

  it("rejects invalid JSON overrides", async () => {
    await withProjectDir(async dir => {
      const result = await confirmProjectProfile(dir, "not-json{")
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.code).toBe("POLICY_INVALID")
    })
  })
})

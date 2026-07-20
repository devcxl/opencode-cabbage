import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import {
  createIsolatedShellEnv,
  detectAmbientCredentials,
} from "../../src/plugin/shell.js"
import type { AgentEntry } from "../../src/plugin/agents.js"

// ─── 辅助工厂 ───

function makeAgent(overrides: Partial<AgentEntry> = {}): AgentEntry {
  return {
    key: "test-agent",
    mode: "subagent",
    prompt: "You are a test agent.",
    tools: { read: true, bash: true, write: true, edit: true },
    permission: {
      bash: "npm test|npm run|git push|git add|git commit",
      write: ".worktree/",
      edit: "src/,test/",
    },
    ...overrides,
  }
}

function makeWorkerAgent(): AgentEntry {
  return makeAgent({
    key: "backend",
    description: "backend worker",
    permission: {
      bash: "npm test|npm run|git push|git add|git commit|git status|git diff|git log|git branch|git checkout",
      write: ".worktree/",
      edit: "src/,test/,assets/",
    },
  })
}

function makeReviewerAgent(): AgentEntry {
  return makeAgent({
    key: "reviewer",
    description: "code reviewer",
    tools: { read: true, bash: false, write: false, edit: false },
    capabilities: {
      create_pr: false,
      merge_pr: false,
      modify_files: false,
      run_tests: false,
      push_branch: false,
      approve_review: false,
      complete_goal: false,
    },
    permission: {
      bash: "gh pr view|diff|checks",
      write: "deny",
      edit: "deny",
    },
  })
}

// ─── createIsolatedShellEnv ───

describe("createIsolatedShellEnv", () => {
  it("creates isolated HOME for worker agent", () => {
    const agent = makeWorkerAgent()
    const env = createIsolatedShellEnv(agent)

    expect(env.HOME).toBeDefined()
    expect(env.HOME).not.toBe(os.homedir())
    expect(env.HOME).toContain("cabbage-shell-")
    expect(env.GH_CONFIG_DIR).toBeDefined()
  })

  it("isolated HOME is a temporary directory", () => {
    const agent = makeWorkerAgent()
    const env = createIsolatedShellEnv(agent)

    expect(fs.existsSync(env.HOME!)).toBe(true)
    expect(fs.statSync(env.HOME!).isDirectory()).toBe(true)

    // cleanup
    fs.rmSync(env.HOME!, { recursive: true, force: true })
  })

  it("blocks GH_TOKEN and GITHUB_TOKEN for worker", () => {
    const agent = makeWorkerAgent()
    const env = createIsolatedShellEnv(agent)

    expect(env.GH_TOKEN).toBe("")
    expect(env.GITHUB_TOKEN).toBe("")
  })

  it("blocks gh write operations in worker shell", () => {
    const agent = makeWorkerAgent()
    const env = createIsolatedShellEnv(agent)

    // Worker should NOT have any gh write capability
    expect(env.GH_TOKEN).toBeFalsy()
    expect(env.GITHUB_TOKEN).toBeFalsy()

    // git credential config should only allow feature branch push
    if (env.GIT_CONFIG_PARAMETERS) {
      expect(env.GIT_CONFIG_PARAMETERS).not.toContain("gh")
    }
  })

  it("reviewer has no GitHub write credentials", () => {
    const agent = makeReviewerAgent()
    const env = createIsolatedShellEnv(agent)

    expect(env.GH_TOKEN).toBe("")
    expect(env.GITHUB_TOKEN).toBe("")
  })

  it("reviewer bash permission is restricted to read-only gh commands", () => {
    const agent = makeReviewerAgent()
    const env = createIsolatedShellEnv(agent)

    // Reviewer should only have gh pr view|diff|checks
    // This is enforced via the agent's permission field, not env
    // The shell env itself should not provide any write tokens
    expect(env.GH_TOKEN || "").toBe("")
    expect(env.GITHUB_TOKEN || "").toBe("")
  })

  it("sets isolated GH_CONFIG_DIR for worker", () => {
    const agent = makeWorkerAgent()
    const env = createIsolatedShellEnv(agent)

    expect(env.GH_CONFIG_DIR).toBeDefined()
    expect(env.GH_CONFIG_DIR).not.toBe("")
    expect(fs.existsSync(env.GH_CONFIG_DIR!)).toBe(true)
    expect(fs.statSync(env.GH_CONFIG_DIR!).isDirectory()).toBe(true)

    // cleanup
    if (env.HOME) fs.rmSync(env.HOME, { recursive: true, force: true })
  })

  it("unsets ambient credential environment variables", () => {
    const agent = makeWorkerAgent()
    const env = createIsolatedShellEnv(agent)

    // GH_TOKEN / GITHUB_TOKEN / GH_ENTERPRISE_TOKEN must be explicitly unset
    expect(env.GH_TOKEN).toBe("")
    expect(env.GITHUB_TOKEN).toBe("")
    expect(env.GH_ENTERPRISE_TOKEN).toBe("")
  })

  it("different agents get different isolated HOME", () => {
    const agent1 = makeAgent({ key: "backend" })
    const agent2 = makeAgent({ key: "frontend" })
    const env1 = createIsolatedShellEnv(agent1)
    const env2 = createIsolatedShellEnv(agent2)

    expect(env1.HOME).not.toBe(env2.HOME)

    // cleanup
    if (env1.HOME) fs.rmSync(env1.HOME, { recursive: true, force: true })
    if (env2.HOME) fs.rmSync(env2.HOME, { recursive: true, force: true })
  })

  it("shell.env is supplementary not primary isolation", () => {
    // shell.env 只是附加措施，不作为唯一隔离边界
    // 主要隔离由 permission 字段 + ambient credential 检测提供
    const agent = makeWorkerAgent()
    const env = createIsolatedShellEnv(agent)

    // env should contain isolation vars but the real enforcement
    // comes from the permission system and ambient detection
    expect(Object.keys(env).length).toBeGreaterThan(0)

    // cleanup
    if (env.HOME) fs.rmSync(env.HOME, { recursive: true, force: true })
  })
})

// ─── detectAmbientCredentials ───

describe("detectAmbientCredentials", () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    // 清理所有 GitHub 相关环境变量
    delete process.env.GH_TOKEN
    delete process.env.GITHUB_TOKEN
    delete process.env.GH_ENTERPRISE_TOKEN
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  it("detects GH_TOKEN in environment", () => {
    process.env.GH_TOKEN = "ghp_fake123"
    const report = detectAmbientCredentials()

    expect(report.hasWriteCredentials).toBe(true)
    expect(report.sources).toContainEqual(
      expect.objectContaining({ source: "GH_TOKEN" })
    )
  })

  it("detects GITHUB_TOKEN in environment", () => {
    process.env.GITHUB_TOKEN = "ghp_fake456"
    const report = detectAmbientCredentials()

    expect(report.hasWriteCredentials).toBe(true)
    expect(report.sources).toContainEqual(
      expect.objectContaining({ source: "GITHUB_TOKEN" })
    )
  })

  it("detects GH_ENTERPRISE_TOKEN in environment", () => {
    process.env.GH_ENTERPRISE_TOKEN = "ghp_fake789"
    const report = detectAmbientCredentials()

    expect(report.hasWriteCredentials).toBe(true)
    expect(report.sources).toContainEqual(
      expect.objectContaining({ source: "GH_ENTERPRISE_TOKEN" })
    )
  })

  it("returns no write credentials when env is clean", () => {
    const report = detectAmbientCredentials()

    expect(report.hasWriteCredentials).toBe(false)
    expect(report.sources).toHaveLength(0)
  })

  it("detects gh hosts.yml config file", () => {
    // Create fake gh config
    const originalHome = process.env.HOME
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cabbage-test-gh-"))
    const ghConfigDir = path.join(tmpHome, ".config", "gh")
    fs.mkdirSync(ghConfigDir, { recursive: true })

    // Write hosts.yml with a token
    const hostsYml = `github.com:
    user: testuser
    oauth_token: ghp_fakeConfigToken
`
    fs.writeFileSync(path.join(ghConfigDir, "hosts.yml"), hostsYml, "utf8")

    try {
      process.env.HOME = tmpHome
      const report = detectAmbientCredentials()

      expect(report.hasWriteCredentials).toBe(true)
      expect(report.sources).toContainEqual(
        expect.objectContaining({ source: "gh_hosts_config" })
      )
    } finally {
      process.env.HOME = originalHome || ""
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it("detects git credential helper configuration", () => {
    const originalHome = process.env.HOME
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cabbage-test-git-"))
    const gitConfigPath = path.join(tmpHome, ".gitconfig")

    // Write gitconfig with credential helper
    const gitConfig = `[credential]
    helper = cache --timeout=3600
`
    fs.writeFileSync(gitConfigPath, gitConfig, "utf8")

    try {
      process.env.HOME = tmpHome
      const report = detectAmbientCredentials()

      // git credential helper itself is not a write credential
      // (it's a helper program, not a stored token)
      // but it COULD be used to access stored credentials
      expect(report.hasGitCredentialHelper).toBe(true)
    } finally {
      process.env.HOME = originalHome || ""
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it("reports empty when HOME/.config/gh does not exist", () => {
    const originalHome = process.env.HOME
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cabbage-test-empty-"))
    try {
      process.env.HOME = tmpHome
      const report = detectAmbientCredentials()

      // no tokens, no gh config → clean
      expect(report.hasWriteCredentials).toBe(false)
      expect(report.hasGitCredentialHelper).toBe(false)
    } finally {
      process.env.HOME = originalHome || ""
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it("detects both env token and config file", () => {
    process.env.GH_TOKEN = "ghp_envToken"

    const originalHome = process.env.HOME
    const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "cabbage-test-both-"))
    const ghConfigDir = path.join(tmpHome, ".config", "gh")
    fs.mkdirSync(ghConfigDir, { recursive: true })
    fs.writeFileSync(
      path.join(ghConfigDir, "hosts.yml"),
      "github.com:\n    oauth_token: ghp_configToken\n",
      "utf8"
    )

    try {
      process.env.HOME = tmpHome
      const report = detectAmbientCredentials()

      expect(report.hasWriteCredentials).toBe(true)
      expect(report.sources.length).toBeGreaterThanOrEqual(2)
      expect(report.sources).toContainEqual(
        expect.objectContaining({ source: "GH_TOKEN" })
      )
      expect(report.sources).toContainEqual(
        expect.objectContaining({ source: "gh_hosts_config" })
      )
    } finally {
      process.env.HOME = originalHome || ""
      fs.rmSync(tmpHome, { recursive: true, force: true })
    }
  })
})

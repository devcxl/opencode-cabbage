import { describe, it, expect, afterEach } from "vitest"
import { mkdtemp, writeFile, rm, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createReleaseControlTool, setReleaseControlGhExecutor, setReleaseControlGitExecutor } from "../../src/plugin/release-control.js"

const PROFILE = `## Project Profile

- version bump rule: \`breaking→major, feature→minor, fix→patch\`
- version file: \`package.json\`
- tag format: \`v{version}\`
- release workflow: \`.github/workflows/release.yml\`
`

type GhResult = { stdout: string; stderr: string }

async function withProject(agentMd: string | null, pkg: Record<string, string>, fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "cabbage-release-control-"))
  try {
    if (agentMd !== null) {
      await writeFile(join(dir, "AGENTS.md"), agentMd)
    }
    await writeFile(join(dir, "package.json"), JSON.stringify(pkg, null, 2))
    await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 前缀匹配的 gh mock：精确 key 或前缀（key 以 * 结尾） */
function mockGh(responses: Record<string, string | (() => GhResult)>, calls: string[] = []) {
  setReleaseControlGhExecutor(args => {
    calls.push(args)
    for (const [key, value] of Object.entries(responses)) {
      const matchKey = key.endsWith("*") ? key.slice(0, -1) : key
      if (key.endsWith("*") ? args.startsWith(matchKey) : args === matchKey) {
        if (typeof value === "function") return Promise.resolve(value())
        return Promise.resolve({ stdout: value, stderr: "" })
      }
    }
    return Promise.resolve({ stdout: "", stderr: "" })
  })
}

afterEach(() => {
  setReleaseControlGhExecutor(null)
  setReleaseControlGitExecutor(null)
})

describe("release_control tool", () => {
  const mainHeadSha = "mainheadsha"
  const gitCalls: string[] = []

  function setupGitMock() {
    setReleaseControlGitExecutor((args, cwd) => {
      gitCalls.push(`${cwd}|${args}`)
      return Promise.resolve({ stdout: "", stderr: "" })
    })
  }

  async function call(
    dir: string,
    op: string,
    extra: Record<string, unknown> = {},
  ) {
    const tool = createReleaseControlTool({ projectDir: dir })
    return tool.execute({ op, ...extra } as any, {} as any)
  }

  it("rejects an unknown op", async () => {
    await withProject(PROFILE, { version: "1.4.2" }, async dir => {
      const out = await call(dir, "bogus")
      expect(String(out)).toContain("Error")
    })
  })

  describe("propose-version", () => {
    it("aggregates changes, classifies, and proposes a patch bump", async () => {
      await withProject(PROFILE, { version: "1.4.2" }, async dir => {
        mockGh({
          "api repos/{owner}/{repo}/tags --jq '.[0].name'": "v1.4.2",
          "api repos/{owner}/{repo}/compare/v1.4.2...main --jq '.commits[] | {sha: .sha, title: (.commit.message | split(\"\\n\")[0])}'":
            `[{"sha":"aaa","title":"fix(core): bug"},{"sha":"bbb","title":"docs: readme"}]`,
        })
        const out = String(await call(dir, "propose-version"))
        expect(out).toContain("1.4.2 → 1.4.3")
        expect(out).toContain("Tag: v1.4.3")
        expect(out).toContain("Changes since v1.4.2: 2")
      })
    })

    it("proposes a minor bump for features", async () => {
      await withProject(PROFILE, { version: "1.4.2" }, async dir => {
        mockGh({
          "api repos/{owner}/{repo}/tags --jq '.[0].name'": "v1.4.2",
          "api repos/{owner}/{repo}/compare/v1.4.2...main --jq '.commits[] | {sha: .sha, title: (.commit.message | split(\"\\n\")[0])}'":
            `[{"sha":"aaa","title":"feat(kernel): add release aggregation"}]`,
        })
        const out = String(await call(dir, "propose-version"))
        expect(out).toContain("1.4.2 → 1.5.0")
      })
    })

    it("proposes a major bump for 0.x breaking changes", async () => {
      await withProject(PROFILE, { version: "0.3.2" }, async dir => {
        mockGh({
          "api repos/{owner}/{repo}/tags --jq '.[0].name'": "v0.3.2",
          "api repos/{owner}/{repo}/compare/v0.3.2...main --jq '.commits[] | {sha: .sha, title: (.commit.message | split(\"\\n\")[0])}'":
            `[{"sha":"aaa","title":"feat!: remove old flowrun"}]`,
        })
        const out = String(await call(dir, "propose-version"))
        expect(out).toContain("0.3.2 → 1.0.0")
      })
    })

    it("gate: asks the user to classify unclassified changes", async () => {
      await withProject(PROFILE, { version: "1.4.2" }, async dir => {
        mockGh({
          "api repos/{owner}/{repo}/tags --jq '.[0].name'": "v1.4.2",
          "api repos/{owner}/{repo}/compare/v1.4.2...main --jq '.commits[] | {sha: .sha, title: (.commit.message | split(\"\\n\")[0])}'":
            `[{"sha":"aaa","title":"fix(core): bug"},{"sha":"bbb","title":"random commit"}]`,
        })
        const out = String(await call(dir, "propose-version"))
        expect(out).toContain("Error")
        expect(out).toContain("未分类")
        expect(out).toContain("random commit")
      })
    })

    it("requires the Profile version file config", async () => {
      await withProject(null, { version: "1.4.2" }, async dir => {
        mockGh({ "api repos/{owner}/{repo}/tags --jq '.[0].name'": "v1.4.2" })
        const out = String(await call(dir, "propose-version"))
        expect(out).toContain("Error")
      })
    })

    it("fails when the repo has no tags yet", async () => {
      await withProject(PROFILE, { version: "1.4.2" }, async dir => {
        mockGh({ "api repos/{owner}/{repo}/tags --jq '.[0].name'": "" })
        const out = String(await call(dir, "propose-version"))
        expect(out).toContain("Error")
        expect(out).toContain("tag")
      })
    })
  })

  describe("open-release-pr", () => {
    it("requires proposed_version", async () => {
      await withProject(PROFILE, { version: "1.4.2" }, async dir => {
        const out = String(await call(dir, "open-release-pr"))
        expect(out).toContain("Error")
        expect(out).toContain("proposed_version")
      })
    })

    it("creates the release branch, bumps the version file, and opens a PR", async () => {
      await withProject(PROFILE, { version: "1.4.2" }, async dir => {
        mockGh({
          "api repos/{owner}/{repo}/commits/main --jq .sha": mainHeadSha,
          "api repos/{owner}/{repo}/tags --jq '.[] | select(.name == \"v1.5.0\") | .commit.sha'": "",
          "pr create --base main --head release/v1.5.0 --title 'release: v1.5.0' --body '*": "42",
        })
        setupGitMock()
        gitCalls.length = 0

        const out = String(await call(dir, "open-release-pr", { proposed_version: "1.5.0" }))
        expect(out).toContain("#42")
        expect(out).toContain("release/v1.5.0")

        // 版本文件已更新（技术栈无关：读取 package.json 的 version 字段）
        const updated = JSON.parse(await readFile(join(dir, "package.json"), "utf8"))
        expect(updated.version).toBe("1.5.0")

        expect(gitCalls.some(c => c.endsWith("|fetch origin"))).toBe(true)
        expect(gitCalls.some(c => c.includes("checkout -b release/v1.5.0"))).toBe(true)
        expect(gitCalls.some(c => c.includes("push -u origin release/v1.5.0"))).toBe(true)
      })
    })

    it("rejects re-pointing an existing tag", async () => {
      await withProject(PROFILE, { version: "1.4.2" }, async dir => {
        mockGh({
          "api repos/{owner}/{repo}/commits/main --jq .sha": mainHeadSha,
          "api repos/{owner}/{repo}/tags --jq '.[] | select(.name == \"v1.5.0\") | .commit.sha'": "othersha",
        })
        const out = String(await call(dir, "open-release-pr", { proposed_version: "1.5.0" }))
        expect(out).toContain("Error")
        expect(out).toContain("immutable")
      })
    })

    it("rejects an invalid proposed version", async () => {
      await withProject(PROFILE, { version: "1.4.2" }, async dir => {
        const out = String(await call(dir, "open-release-pr", { proposed_version: "v1.5.0" }))
        expect(out).toContain("Error")
      })
    })
  })

  describe("merge-release-pr", () => {
    it("merges the release PR, verifies the merge SHA, and pushes the tag", async () => {
      await withProject(PROFILE, { version: "1.4.2" }, async dir => {
        const ghCalls: string[] = []
        mockGh({
          "pr list --head release/v1.5.0 --json number --jq '.[0].number'": "12",
          "pr view 12 --json statusCheckRollup --jq '[.statusCheckRollup[] | select(.conclusion != null)] | map(.conclusion) | unique'":
            '["SUCCESS"]',
          "pr merge 12 --squash --delete-branch": "",
          "pr view 12 --json mergeCommit --jq '.mergeCommit.oid'": "deadbeef",
          "api repos/{owner}/{repo}/tags --jq '.[] | select(.name == \"v1.5.0\") | .commit.sha'": "",
          "api repos/{owner}/{repo}/git/refs -f ref=refs/tags/v1.5.0 -f sha=deadbeef": "",
        }, ghCalls)

        const out = String(await call(dir, "merge-release-pr", { proposed_version: "1.5.0", user_confirmed: true }))
        expect(out).toContain("Merged #12")
        expect(out).toContain("tagged v1.5.0")
        expect(out).toContain("deadbee")
        expect(ghCalls.some(c => c.includes("statusCheckRollup"))).toBe(true)
        expect(ghCalls.some(c => c.includes("git/refs"))).toBe(true)
      })
    })

    it("refuses without human approval (user_confirmed)", async () => {
      await withProject(PROFILE, { version: "1.4.2" }, async dir => {
        const out = String(await call(dir, "merge-release-pr", { proposed_version: "1.5.0" }))
        expect(out).toContain("Error")
        expect(out).toContain("user_confirmed")
      })
    })

    it("refuses when the release PR does not exist", async () => {
      await withProject(PROFILE, { version: "1.4.2" }, async dir => {
        mockGh({ "pr list --head release/v1.5.0 --json number --jq '.[0].number'": "" })
        const out = String(await call(dir, "merge-release-pr", { proposed_version: "1.5.0", user_confirmed: true }))
        expect(out).toContain("Error")
      })
    })

    it("refuses when CI checks have failed", async () => {
      await withProject(PROFILE, { version: "1.4.2" }, async dir => {
        mockGh({
          "pr list --head release/v1.5.0 --json number --jq '.[0].number'": "12",
          "pr view 12 --json statusCheckRollup --jq '[.statusCheckRollup[] | select(.conclusion != null)] | map(.conclusion) | unique'":
            '["FAILURE"]',
        })
        const out = String(await call(dir, "merge-release-pr", { proposed_version: "1.5.0", user_confirmed: true }))
        expect(out).toContain("Error")
        expect(out).toContain("CI")
      })
    })

    it("refuses when no CI checks are reported", async () => {
      await withProject(PROFILE, { version: "1.4.2" }, async dir => {
        mockGh({
          "pr list --head release/v1.5.0 --json number --jq '.[0].number'": "12",
          "pr view 12 --json statusCheckRollup --jq '[.statusCheckRollup[] | select(.conclusion != null)] | map(.conclusion) | unique'":
            "[]",
        })
        const out = String(await call(dir, "merge-release-pr", { proposed_version: "1.5.0", user_confirmed: true }))
        expect(out).toContain("Error")
        expect(out).toContain("没有任何 CI checks")
      })
    })
  })

  describe("monitor", () => {
    it("requires the release workflow config", async () => {
      await withProject("## Project Profile\n\n- version file: `package.json`\n", { version: "1.4.2" }, async dir => {
        const out = String(await call(dir, "monitor"))
        expect(out).toContain("Error")
        expect(out).toContain("workflow")
      })
    })

    it("reports success when the latest workflow run succeeded", async () => {
      await withProject(PROFILE, { version: "1.4.2" }, async dir => {
        mockGh({
          "run list --workflow .github/workflows/release.yml --limit 1 --json databaseId,status,conclusion,headBranch --jq '.[0]'":
            `{"databaseId": 77, "status": "completed", "conclusion": "success", "headBranch": "main"}`,
        })
        const out = String(await call(dir, "monitor"))
        expect(out).toContain("succeeded")
      })
    })

    it("reports pending while the run is not completed", async () => {
      await withProject(PROFILE, { version: "1.4.2" }, async dir => {
        mockGh({
          "run list --workflow .github/workflows/release.yml --limit 1 --json databaseId,status,conclusion,headBranch --jq '.[0]'":
            `{"databaseId": 77, "status": "in_progress", "conclusion": null, "headBranch": "release/v1.5.0"}`,
        })
        const out = String(await call(dir, "monitor"))
        expect(out).toContain("in_progress")
      })
    })

    it("reruns a failed run once", async () => {
      await withProject(PROFILE, { version: "1.4.2" }, async dir => {
        const ghCalls: string[] = []
        mockGh({
          "run list --workflow .github/workflows/release.yml --limit 1 --json databaseId,status,conclusion,headBranch --jq '.[0]'":
            `{"databaseId": 77, "status": "completed", "conclusion": "failure", "headBranch": "release/v1.5.0"}`,
          "run rerun 77": "",
        }, ghCalls)
        const out = String(await call(dir, "monitor"))
        expect(out).toContain("failed")
        expect(out).toContain("rerun")
        expect(ghCalls.some(c => c.startsWith("run rerun 77"))).toBe(true)
      })
    })
  })
})

import { describe, it, expect } from "vitest"
import {
  parseVersion,
  formatVersion,
  bumpVersion,
  highestBumpType,
  classifyCommitTitle,
  classifyChanges,
  proposeVersion,
  buildTag,
  validateTagFormat,
  buildReleaseNotes,
  latestTag,
  listCommitsSinceTag,
  existingTagSha,
  validateTagImmutability,
  setReleaseGhExecutor,
  parseVersionFileSpec,
  readVersionFromJson,
  updateVersionInJson,
} from "../../src/kernel/release.js"

describe("parseVersion", () => {
  it("parses a valid semver", () => {
    expect(parseVersion("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3 })
  })

  it("parses 0.x versions", () => {
    expect(parseVersion("0.3.2")).toEqual({ major: 0, minor: 3, patch: 2 })
  })

  it("rejects malformed versions", () => {
    for (const bad of ["1.2", "1.2.3.4", "v1.2.3", "1.2.x", "abc", "", "1.2.-3"]) {
      expect(parseVersion(bad), bad).toBeNull()
    }
  })
})

describe("formatVersion", () => {
  it("formats a version as x.y.z", () => {
    expect(formatVersion({ major: 1, minor: 0, patch: 0 })).toBe("1.0.0")
  })
})

describe("bumpVersion", () => {
  it("bumps major and resets minor/patch", () => {
    expect(bumpVersion({ major: 1, minor: 4, patch: 2 }, "major")).toEqual({ major: 2, minor: 0, patch: 0 })
  })

  it("bumps major from 0.x (0.x breaking also goes major)", () => {
    expect(bumpVersion({ major: 0, minor: 3, patch: 2 }, "major")).toEqual({ major: 1, minor: 0, patch: 0 })
  })

  it("bumps minor and resets patch", () => {
    expect(bumpVersion({ major: 1, minor: 4, patch: 2 }, "minor")).toEqual({ major: 1, minor: 5, patch: 0 })
  })

  it("bumps patch", () => {
    expect(bumpVersion({ major: 1, minor: 4, patch: 2 }, "patch")).toEqual({ major: 1, minor: 4, patch: 3 })
  })
})

describe("highestBumpType", () => {
  it("major wins over minor and patch", () => {
    expect(highestBumpType(["patch", "minor", "major"])).toBe("major")
  })

  it("minor wins over patch", () => {
    expect(highestBumpType(["patch", "minor"])).toBe("minor")
  })

  it("falls back to patch", () => {
    expect(highestBumpType(["patch"])).toBe("patch")
    expect(highestBumpType([])).toBe("patch")
  })
})

describe("classifyCommitTitle", () => {
  it("classifies feat as feature", () => {
    expect(classifyCommitTitle("feat(kernel): add release aggregation")).toEqual({
      category: "feature",
      breaking: false,
    })
  })

  it("classifies fix as fix", () => {
    expect(classifyCommitTitle("fix(core): resolve null deref")).toEqual({ category: "fix", breaking: false })
  })

  it("classifies chore/refactor/build/ci/perf/test as maintenance", () => {
    for (const type of ["chore", "refactor", "build", "ci", "perf", "test"]) {
      expect(classifyCommitTitle(`${type}(x): something`), type).toEqual({ category: "maintenance", breaking: false })
    }
  })

  it("classifies docs as docs", () => {
    expect(classifyCommitTitle("docs(readme): clarify usage")).toEqual({ category: "docs", breaking: false })
  })

  it("marks breaking via ! after the type", () => {
    expect(classifyCommitTitle("feat!: remove old flowrun")).toEqual({ category: "feature", breaking: true })
  })

  it("marks breaking via BREAKING CHANGE in the body", () => {
    const title = "feat(core): rework kernel\n\nBREAKING CHANGE: old cabinet removed"
    expect(classifyCommitTitle(title)).toEqual({ category: "feature", breaking: true })
  })

  it("classifies merge commits as maintenance", () => {
    expect(classifyCommitTitle("Merge pull request #120 from devcxl/feat/x")).toEqual({
      category: "maintenance",
      breaking: false,
    })
  })

  it("marks unknown commit types as unclassified", () => {
    expect(classifyCommitTitle("tweak some internal thing")).toEqual({ category: "unclassified", breaking: false })
    expect(classifyCommitTitle("random: whatever")).toEqual({ category: "unclassified", breaking: false })
  })
})

describe("classifyChanges", () => {
  it("classifies a batch of commits", () => {
    const changes = classifyChanges([
      { sha: "a", title: "feat(api): add endpoint" },
      { sha: "b", title: "fix(core): bug" },
      { sha: "c", title: "docs: readme" },
    ])
    expect(changes.map(c => c.category)).toEqual(["feature", "fix", "docs"])
  })
})

describe("proposeVersion", () => {
  const change = (category: "feature" | "fix" | "maintenance" | "docs" | "unclassified", breaking = false) => ({
    sha: "abc",
    title: "t",
    category,
    breaking,
  })

  it("proposes major for breaking changes", () => {
    const result = proposeVersion("1.4.2", [change("feature", true)])
    expect(result).toEqual({ ok: true, proposed: "2.0.0", type: "major" })
  })

  it("proposes major for breaking 0.x changes (0.x breaking goes major)", () => {
    const result = proposeVersion("0.3.2", [change("fix", true)])
    expect(result).toEqual({ ok: true, proposed: "1.0.0", type: "major" })
  })

  it("proposes minor for features", () => {
    const result = proposeVersion("1.4.2", [change("feature")])
    expect(result).toEqual({ ok: true, proposed: "1.5.0", type: "minor" })
  })

  it("proposes patch for fix/maintenance/docs", () => {
    for (const category of ["fix", "maintenance", "docs"] as const) {
      const result = proposeVersion("1.4.2", [change(category)])
      expect(result, category).toEqual({ ok: true, proposed: "1.4.3", type: "patch" })
    }
  })

  it("takes the highest level across mixed changes", () => {
    const result = proposeVersion("1.4.2", [change("fix"), change("feature"), change("docs")])
    expect(result).toEqual({ ok: true, proposed: "1.5.0", type: "minor" })
  })

  it("rejects unknown current version", () => {
    const result = proposeVersion("v1.4", [change("fix")])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("INVALID_VERSION")
    }
  })

  it("gate: rejects when any change is unclassified", () => {
    const result = proposeVersion("1.4.2", [change("fix"), change("unclassified")])
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe("UNCLASSIFIED_CHANGES")
    }
  })
})

describe("buildTag / validateTagFormat", () => {
  it("builds a tag with the default v{version} format", () => {
    expect(buildTag("1.0.0", "v{version}")).toBe("v1.0.0")
  })

  it("builds a tag with a custom format", () => {
    expect(buildTag("1.0.0", "release-{version}")).toBe("release-1.0.0")
  })

  it("validates tags against the format", () => {
    expect(validateTagFormat("v1.0.0", "v{version}")).toBe(true)
    expect(validateTagFormat("1.0.0", "v{version}")).toBe(false)
    expect(validateTagFormat("v1.0.0", "v{version}")).toBe(true)
  })
})

describe("buildReleaseNotes", () => {
  it("groups changes by category with a header", () => {
    const notes = buildReleaseNotes("1.5.0", [
      { sha: "a", title: "feat(api): add endpoint", category: "feature", breaking: false },
      { sha: "b", title: "fix(core): bug", category: "fix", breaking: false },
    ])
    expect(notes).toContain("## 1.5.0")
    expect(notes).toContain("### Features")
    expect(notes).toContain("feat(api): add endpoint")
    expect(notes).toContain("### Fixes")
    expect(notes).toContain("fix(core): bug")
  })

  it("mentions breaking changes", () => {
    const notes = buildReleaseNotes("2.0.0", [
      { sha: "a", title: "feat!: remove old flowrun", category: "feature", breaking: true },
    ])
    expect(notes).toContain("BREAKING")
  })
})

describe("gh aggregation and tag immutability (mock executor)", () => {
  type Call = { args: string; respond: (call: string) => string }
  let calls: string[]

  function withExecutor(responses: Record<string, string>, fn: () => Promise<void>) {
    return async () => {
      calls = []
      setReleaseGhExecutor(args => {
        calls.push(args)
        return Promise.resolve({ stdout: responses[args] ?? "", stderr: "" })
      })
      try {
        await fn()
      } finally {
        setReleaseGhExecutor(null)
      }
    }
  }

  it("latestTag returns the newest tag name", withExecutor(
    { "api repos/{owner}/{repo}/tags --jq '.[0].name'": "v1.4.2" },
    async () => {
      expect(await latestTag()).toBe("v1.4.2")
    },
  ))

  it("latestTag returns null when there are no tags", withExecutor(
    { "api repos/{owner}/{repo}/tags --jq '.[0].name'": "" },
    async () => {
      expect(await latestTag()).toBeNull()
    },
  ))

  it("listCommitsSinceTag returns sha and first-line titles", withExecutor(
    {
      "api repos/{owner}/{repo}/compare/v1.4.2...main --jq '.commits[] | {sha: .sha, title: (.commit.message | split(\"\\n\")[0])}'":
        `[{"sha":"aaa","title":"feat(kernel): add release aggregation"},{"sha":"bbb","title":"fix(core): bug\\nwith a body"}]`,
    },
    async () => {
      const commits = await listCommitsSinceTag("v1.4.2", "main")
      expect(commits).toEqual([
        { sha: "aaa", title: "feat(kernel): add release aggregation" },
        { sha: "bbb", title: "fix(core): bug" },
      ])
    },
  ))

  it("listCommitsSinceTag returns [] when the range is empty", withExecutor(
    { "api repos/{owner}/{repo}/compare/v1.4.2...main --jq '.commits[] | {sha: .sha, title: (.commit.message | split(\"\\n\")[0])}'": "[]" },
    async () => {
      expect(await listCommitsSinceTag("v1.4.2", "main")).toEqual([])
    },
  ))

  it("existingTagSha returns the sha a tag points at", withExecutor(
    { "api repos/{owner}/{repo}/tags --jq '.[] | select(.name == \"v1.4.2\") | .commit.sha'": "deadbeef" },
    async () => {
      expect(await existingTagSha("v1.4.2")).toBe("deadbeef")
    },
  ))

  it("existingTagSha returns null for a missing tag", withExecutor(
    { "api repos/{owner}/{repo}/tags --jq '.[] | select(.name == \"v1.4.2\") | .commit.sha'": "" },
    async () => {
      expect(await existingTagSha("v1.4.2")).toBeNull()
    },
  ))

  it("validateTagImmutability allows creating a new tag", withExecutor(
    { "api repos/{owner}/{repo}/tags --jq '.[] | select(.name == \"v1.5.0\") | .commit.sha'": "" },
    async () => {
      const result = await validateTagImmutability("v1.5.0", "abc123")
      expect(result).toEqual({ ok: true })
    },
  ))

  it("validateTagImmutability passes idempotently when the tag already points at the expected sha", withExecutor(
    { "api repos/{owner}/{repo}/tags --jq '.[] | select(.name == \"v1.5.0\") | .commit.sha'": "abc123" },
    async () => {
      const result = await validateTagImmutability("v1.5.0", "abc123")
      expect(result.ok).toBe(true)
    },
  ))

  it("validateTagImmutability rejects re-pointing an existing tag (tags are immutable)", withExecutor(
    { "api repos/{owner}/{repo}/tags --jq '.[] | select(.name == \"v1.5.0\") | .commit.sha'": "oldsha" },
    async () => {
      const result = await validateTagImmutability("v1.5.0", "newsha")
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.code).toBe("TAG_ALREADY_EXISTS")
        expect(result.message).toContain("immutable")
      }
    },
  ))
})

describe("version file read/write (Profile §9.1, tech-stack agnostic)", () => {
  it("parses a bare version file spec with the default $.version path", () => {
    expect(parseVersionFileSpec("package.json")).toEqual({ path: "package.json", key: "version" })
  })

  it("parses a spec with an explicit json path", () => {
    expect(parseVersionFileSpec("lib/version.json $.version")).toEqual({ path: "lib/version.json", key: "version" })
    expect(parseVersionFileSpec("pkg.json $.name.version")).toEqual({ path: "pkg.json", key: "name.version" })
  })

  it("returns null for a spec without a JSON path", () => {
    expect(parseVersionFileSpec("package.json metadata")).toBeNull()
    expect(parseVersionFileSpec("")).toBeNull()
  })

  it("reads the version from JSON by key", () => {
    expect(readVersionFromJson('{"version": "1.2.3"}', "version")).toBe("1.2.3")
    expect(readVersionFromJson('{"version": 12}', "version")).toBeNull()
    expect(readVersionFromJson('{"other": "1.0.0"}', "version")).toBeNull()
    expect(readVersionFromJson("not json", "version")).toBeNull()
  })

  it("updates the version in JSON by key", () => {
    expect(updateVersionInJson('{"version": "1.2.3"}', "version", "1.3.0")).toContain('"version": "1.3.0"')
    expect(updateVersionInJson('{"version": "1.2.3"}', "version", "1.3.0")).not.toContain("1.2.3")
  })

  it("preserves a trailing newline when updating", () => {
    expect(updateVersionInJson('{\n  "version": "1.2.3"\n}\n', "version", "1.3.0").endsWith("\n")).toBe(true)
  })
})

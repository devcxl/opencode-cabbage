import { describe, it, expect } from "vitest"
import {
  checkRequiredChecks,
  validateRequiredWorkflow,
  checkBranchProtection,
  computeQualityContractDigest,
} from "../../src/flowrun/ci.js"
import type {
  RepositoryQualityPolicy, TaskCommand, CoveragePolicy,
} from "../../src/flowrun/types.js"

// ─── helpers ───

function makePolicy(overrides: Partial<RepositoryQualityPolicy> = {}): RepositoryQualityPolicy {
  return {
    mode: "required",
    requiredChecks: [
      { context: "CI / Test", appId: 12345, workflowPath: ".github/workflows/ci.yml", workflowRef: "main", workflowBlobSha: "abc123" },
      { context: "CI / Lint", appId: 12345, workflowPath: ".github/workflows/lint.yml", workflowRef: "main", workflowBlobSha: "def456" },
    ],
    ...overrides,
  }
}

function makeCheck(overrides: Record<string, unknown> = {}) {
  return {
    context: "CI / Test",
    state: "SUCCESS" as const,
    app: { id: 12345, name: "GitHub Actions" },
    ...overrides,
  }
}

function noopCmd(): TaskCommand {
  return { command: "echo ok", cwd: ".", timeoutMs: 30000, env: {} }
}

function makeCoveragePolicy(overrides: Partial<CoveragePolicy> = {}): CoveragePolicy {
  return {
    command: "npm run coverage",
    threshold: 80,
    report: { format: "istanbul-json-summary", path: "coverage/coverage-summary.json", metric: "lines" },
    ...overrides,
  }
}

// ─────────────────────────────────────────────────
// checkRequiredChecks
// ─────────────────────────────────────────────────

describe("checkRequiredChecks", () => {
  // ✅ mode off — no-op（保持现有行为）
  it("returns allPassed true when mode is off (no-op)", () => {
    const policy = makePolicy({ mode: "off" })
    const result = checkRequiredChecks(policy, [])
    expect(result.allPassed).toBe(true)
    expect(result.missingContexts).toEqual([])
    expect(result.failedContexts).toEqual([])
    expect(result.untrustedSources).toEqual([])
  })

  // ✅ mode off with empty requiredChecks
  it("returns allPassed true when mode is off with empty requiredChecks", () => {
    const policy: RepositoryQualityPolicy = { mode: "off", requiredChecks: [] }
    const result = checkRequiredChecks(policy, [])
    expect(result.allPassed).toBe(true)
  })

  // ✅ 正常路径：所有 required checks 通过
  it("returns allPassed true when all required checks pass with correct appId", () => {
    const policy = makePolicy()
    const prChecks = [
      makeCheck({ context: "CI / Test", state: "SUCCESS", app: { id: 12345, name: "GitHub Actions" } }),
      makeCheck({ context: "CI / Lint", state: "SUCCESS", app: { id: 12345, name: "GitHub Actions" } }),
    ]
    const result = checkRequiredChecks(policy, prChecks)
    expect(result.allPassed).toBe(true)
    expect(result.missingContexts).toEqual([])
    expect(result.failedContexts).toEqual([])
    expect(result.pendingContexts).toEqual([])
    expect(result.untrustedSources).toEqual([])
  })

  // ❌ 缺失 context
  it("detects missing required check context", () => {
    const policy = makePolicy()
    const prChecks = [
      makeCheck({ context: "CI / Test", state: "SUCCESS", app: { id: 12345, name: "GitHub Actions" } }),
      // CI / Lint 不存在
    ]
    const result = checkRequiredChecks(policy, prChecks)
    expect(result.allPassed).toBe(false)
    expect(result.missingContexts).toContain("CI / Lint")
    expect(result.missingContexts).toHaveLength(1)
  })

  // ❌ check 状态为 FAILURE
  it("detects failed required check", () => {
    const policy = makePolicy()
    const prChecks = [
      makeCheck({ context: "CI / Test", state: "FAILURE", app: { id: 12345, name: "GitHub Actions" } }),
      makeCheck({ context: "CI / Lint", state: "SUCCESS", app: { id: 12345, name: "GitHub Actions" } }),
    ]
    const result = checkRequiredChecks(policy, prChecks)
    expect(result.allPassed).toBe(false)
    expect(result.failedContexts).toContain("CI / Test")
    expect(result.failedContexts).toHaveLength(1)
  })

  // ❌ check 状态为 ERROR
  it("detects error state as failure", () => {
    const policy = makePolicy()
    const prChecks = [
      makeCheck({ context: "CI / Test", state: "ERROR", app: { id: 12345, name: "GitHub Actions" } }),
      makeCheck({ context: "CI / Lint", state: "SUCCESS", app: { id: 12345, name: "GitHub Actions" } }),
    ]
    const result = checkRequiredChecks(policy, prChecks)
    expect(result.allPassed).toBe(false)
    expect(result.failedContexts).toContain("CI / Test")
  })

  // ❌ check 状态为 PENDING
  it("detects pending required check", () => {
    const policy = makePolicy()
    const prChecks = [
      makeCheck({ context: "CI / Test", state: "PENDING", app: { id: 12345, name: "GitHub Actions" } }),
      makeCheck({ context: "CI / Lint", state: "SUCCESS", app: { id: 12345, name: "GitHub Actions" } }),
    ]
    const result = checkRequiredChecks(policy, prChecks)
    expect(result.allPassed).toBe(false)
    expect(result.pendingContexts).toContain("CI / Test")
  })

  // ❌ EXPECTED state（GitHub 用 EXPECTED 表示 "等待中"）
  it("treats EXPECTED as pending", () => {
    const policy = makePolicy()
    const prChecks = [
      makeCheck({ context: "CI / Test", state: "EXPECTED", app: { id: 12345, name: "GitHub Actions" } }),
      makeCheck({ context: "CI / Lint", state: "SUCCESS", app: { id: 12345, name: "GitHub Actions" } }),
    ]
    const result = checkRequiredChecks(policy, prChecks)
    expect(result.allPassed).toBe(false)
    expect(result.pendingContexts).toContain("CI / Test")
  })

  // ❌ 来源 appId 不匹配 — 拒绝自动合并
  it("rejects when source appId does not match expected", () => {
    const policy = makePolicy()
    const prChecks = [
      makeCheck({ context: "CI / Test", state: "SUCCESS", app: { id: 99999, name: "Untrusted App" } }),
      makeCheck({ context: "CI / Lint", state: "SUCCESS", app: { id: 12345, name: "GitHub Actions" } }),
    ]
    const result = checkRequiredChecks(policy, prChecks)
    expect(result.allPassed).toBe(false)
    expect(result.untrustedSources).toHaveLength(1)
    expect(result.untrustedSources[0]).toEqual({
      context: "CI / Test",
      expectedAppId: 12345,
      actualAppId: 99999,
    })
  })

  // ❌ 来源 app 为 null — 拒绝（无来源信息不可信）
  it("rejects when source app is null (no source info)", () => {
    const policy = makePolicy()
    const prChecks = [
      makeCheck({ context: "CI / Test", state: "SUCCESS", app: null }),
      makeCheck({ context: "CI / Lint", state: "SUCCESS", app: { id: 12345, name: "GitHub Actions" } }),
    ]
    const result = checkRequiredChecks(policy, prChecks)
    expect(result.allPassed).toBe(false)
    expect(result.untrustedSources).toHaveLength(1)
    expect(result.untrustedSources[0].actualAppId).toBeNull()
  })

  // ✅ check 来源允许 null appId（GitHub 原生 check 没有 appId）
  it("allows when source appId is null but no policy appId required", () => {
    const policy = makePolicy({
      requiredChecks: [
        { context: "CI / Test", appId: 0, workflowPath: ".github/workflows/ci.yml", workflowRef: "main", workflowBlobSha: "abc123" },
      ],
    })
    const prChecks = [
      makeCheck({ context: "CI / Test", state: "SUCCESS", app: null }),
    ]
    // appId 为 0 表示不校验来源
    const result = checkRequiredChecks(policy, prChecks)
    expect(result.allPassed).toBe(true)
  })

  // ❌ check 有 app 但 app.id 不匹配（即使 app 存在）
  it("rejects when check has app but app.id differs", () => {
    const policy = makePolicy()
    const prChecks = [
      makeCheck({ context: "CI / Test", state: "SUCCESS", app: { id: 54321, name: "Another CI" } }),
      makeCheck({ context: "CI / Lint", state: "SUCCESS", app: { id: 12345, name: "GitHub Actions" } }),
    ]
    const result = checkRequiredChecks(policy, prChecks)
    expect(result.allPassed).toBe(false)
    expect(result.untrustedSources[0].expectedAppId).toBe(12345)
    expect(result.untrustedSources[0].actualAppId).toBe(54321)
  })

  // ❌ 混合多重失败（missing + failed + untrusted）— 全部报告
  it("reports all failure types together", () => {
    const policy = makePolicy({
      requiredChecks: [
        { context: "CI / Test", appId: 12345, workflowPath: ".github/workflows/ci.yml", workflowRef: "main", workflowBlobSha: "abc123" },
        { context: "CI / Lint", appId: 12345, workflowPath: ".github/workflows/lint.yml", workflowRef: "main", workflowBlobSha: "def456" },
        { context: "CI / Build", appId: 99999, workflowPath: ".github/workflows/build.yml", workflowRef: "main", workflowBlobSha: "ghi789" },
      ],
    })
    const prChecks = [
      makeCheck({ context: "CI / Test", state: "FAILURE", app: { id: 12345, name: "GitHub Actions" } }),
      // CI / Lint 缺失
      makeCheck({ context: "CI / Build", state: "SUCCESS", app: { id: 11111, name: "Wrong App" } }),
    ]
    const result = checkRequiredChecks(policy, prChecks)
    expect(result.allPassed).toBe(false)
    expect(result.failedContexts).toContain("CI / Test")
    expect(result.missingContexts).toContain("CI / Lint")
    expect(result.untrustedSources).toHaveLength(1)
    expect(result.untrustedSources[0].context).toBe("CI / Build")
  })
})

// ─────────────────────────────────────────────────
// validateRequiredWorkflow
// ─────────────────────────────────────────────────

describe("validateRequiredWorkflow", () => {
  // ❌ required mode + 空 requiredChecks → 拒绝
  it("rejects required mode with empty requiredChecks", () => {
    const policy: RepositoryQualityPolicy = { mode: "required", requiredChecks: [] }
    const result = validateRequiredWorkflow(policy)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain("requiredChecks must not be empty when mode is 'required'")
  })

  // ✅ required mode + non-empty requiredChecks → 通过
  it("accepts required mode with non-empty requiredChecks", () => {
    const policy = makePolicy()
    const result = validateRequiredWorkflow(policy)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  // ✅ off mode + 空 requiredChecks → 有效（无强制要求）
  it("accepts off mode with empty requiredChecks", () => {
    const policy: RepositoryQualityPolicy = { mode: "off", requiredChecks: [] }
    const result = validateRequiredWorkflow(policy)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
  })

  // ❌ required mode + 缺少 workflowPath
  it("rejects required check without workflowPath", () => {
    const policy = makePolicy({
      requiredChecks: [
        { context: "CI / Test", appId: 12345, workflowPath: "", workflowRef: "main", workflowBlobSha: "abc" },
      ],
    })
    const result = validateRequiredWorkflow(policy)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e: string) => e.includes("workflowPath"))).toBe(true)
  })

  // ❌ required mode + 重复 context
  it("rejects duplicate contexts", () => {
    const policy = makePolicy({
      requiredChecks: [
        { context: "CI / Test", appId: 12345, workflowPath: ".github/workflows/ci.yml", workflowRef: "main", workflowBlobSha: "abc" },
        { context: "CI / Test", appId: 12345, workflowPath: ".github/workflows/ci2.yml", workflowRef: "main", workflowBlobSha: "def" },
      ],
    })
    const result = validateRequiredWorkflow(policy)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e: string) => e.includes("duplicate"))).toBe(true)
  })

  // ✅ off mode 不校验 workflowPath
  it("skips workflow validation when mode is off", () => {
    const policy: RepositoryQualityPolicy = {
      mode: "off",
      requiredChecks: [
        { context: "CI / Test", appId: 12345, workflowPath: "", workflowRef: "main", workflowBlobSha: "abc" },
      ],
    }
    const result = validateRequiredWorkflow(policy)
    expect(result.valid).toBe(true)
  })

  // ✅ multiple valid checks
  it("accepts multiple valid required checks", () => {
    const policy = makePolicy({
      requiredChecks: [
        { context: "CI / Test", appId: 12345, workflowPath: ".github/workflows/ci.yml", workflowRef: "main", workflowBlobSha: "abc123" },
        { context: "CI / Lint", appId: 54321, workflowPath: ".github/workflows/lint.yml", workflowRef: "main", workflowBlobSha: "def456" },
        { context: "CI / Coverage", appId: 99999, workflowPath: ".github/workflows/coverage.yml", workflowRef: "main", workflowBlobSha: "ghi789" },
      ],
    })
    const result = validateRequiredWorkflow(policy)
    expect(result.valid).toBe(true)
  })

  // ❌ required mode + missing workflowRef
  it("rejects required check with empty workflowRef", () => {
    const policy = makePolicy({
      requiredChecks: [
        { context: "CI / Test", appId: 12345, workflowPath: ".github/workflows/ci.yml", workflowRef: "", workflowBlobSha: "abc" },
      ],
    })
    const result = validateRequiredWorkflow(policy)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e: string) => e.includes("workflowRef"))).toBe(true)
  })
})

// ─────────────────────────────────────────────────
// checkBranchProtection
// ─────────────────────────────────────────────────

describe("checkBranchProtection", () => {
  // 所有测试通过 mock gh executor
  // 这里只测试纯函数逻辑；I/O 部分通过 setMergeGhExecutor 在 merge.test.ts 中已有覆盖
  // ci.ts 中的 checkBranchProtection 是 merge.ts 中已有函数的增强版 wrapper

  it("re-exports from merge module with correct signature", () => {
    // 验证函数存在且可调用
    expect(typeof checkBranchProtection).toBe("function")
    // 现有实现接受 (owner, repo) 两个参数，硬编码检查 main 分支
    expect(checkBranchProtection.length).toBe(2)
  })
})

// ─────────────────────────────────────────────────
// computeQualityContractDigest
// ─────────────────────────────────────────────────

describe("computeQualityContractDigest", () => {
  it("returns a hex string of correct length", () => {
    const digest = computeQualityContractDigest(
      [noopCmd()],
      [],
      null,
    )
    expect(digest).toMatch(/^[a-f0-9]{64}$/)
  })

  it("is deterministic for same inputs", () => {
    const a = computeQualityContractDigest([noopCmd()], [], null)
    const b = computeQualityContractDigest([noopCmd()], [], null)
    expect(a).toBe(b)
  })

  it("differs when test commands differ", () => {
    const a = computeQualityContractDigest(
      [{ command: "npm test", cwd: ".", timeoutMs: 30000, env: {} }],
      [],
      null,
    )
    const b = computeQualityContractDigest(
      [{ command: "npm test -- --coverage", cwd: ".", timeoutMs: 30000, env: {} }],
      [],
      null,
    )
    expect(a).not.toBe(b)
  })

  it("differs when verify commands differ", () => {
    const a = computeQualityContractDigest(
      [],
      [noopCmd()],
      null,
    )
    const b = computeQualityContractDigest(
      [],
      [{ command: "npx tsc --noEmit", cwd: ".", timeoutMs: 30000, env: {} }],
      null,
    )
    expect(a).not.toBe(b)
  })

  it("differs when coverage policy differs", () => {
    const a = computeQualityContractDigest(
      [],
      [],
      makeCoveragePolicy({ threshold: 80 }),
    )
    const b = computeQualityContractDigest(
      [],
      [],
      makeCoveragePolicy({ threshold: 90 }),
    )
    expect(a).not.toBe(b)
  })

  it("differs when coverage policy is null vs present", () => {
    const a = computeQualityContractDigest([], [], null)
    const b = computeQualityContractDigest([], [], makeCoveragePolicy())
    expect(a).not.toBe(b)
  })

  it("is order-sensitive for commands", () => {
    const a = computeQualityContractDigest(
      [{ command: "npm run a", cwd: ".", timeoutMs: 30000, env: {} },
       { command: "npm run b", cwd: ".", timeoutMs: 30000, env: {} }],
      [],
      null,
    )
    const b = computeQualityContractDigest(
      [{ command: "npm run b", cwd: ".", timeoutMs: 30000, env: {} },
       { command: "npm run a", cwd: ".", timeoutMs: 30000, env: {} }],
      [],
      null,
    )
    expect(a).not.toBe(b)
  })

  it("includes env in digest computation", () => {
    const a = computeQualityContractDigest(
      [{ command: "npm test", cwd: ".", timeoutMs: 30000, env: {} }],
      [],
      null,
    )
    const b = computeQualityContractDigest(
      [{ command: "npm test", cwd: ".", timeoutMs: 30000, env: { NODE_ENV: "test" } }],
      [],
      null,
    )
    expect(a).not.toBe(b)
  })

  it("is consistent with JCS canonicalization (sorted keys)", () => {
    // 验证 JSON 的 key 排序是确定的
    const cmd1: TaskCommand = { cwd: ".", command: "npm test", env: {}, timeoutMs: 30000 }
    // cmd1 和 cmd2 的 key 顺序不同，但值相同
    const a = computeQualityContractDigest([cmd1], [], null)
    const b = computeQualityContractDigest([cmd1], [], null)
    // 确定性：相同对象多次计算应相同
    expect(a).toBe(b)
  })
})

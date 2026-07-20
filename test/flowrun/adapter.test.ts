import { describe, it, expect } from "vitest"
import type { TddRunnerPolicy, TddCommandEvidence } from "../../src/flowrun/types.js"
import { validateSelector, classifyVitestFailure, buildVitestArgs } from "../../src/flowrun/adapter.js"

// ─── 辅助函数 ───

function makePolicy(overrides: Partial<TddRunnerPolicy> = {}): TddRunnerPolicy {
  return {
    adapter: "vitest",
    baseCommand: "npx vitest run",
    timeoutMs: 30000,
    executionInputPatterns: ["package.json", "vitest.config.ts"],
    ...overrides,
  }
}

// ─── selector 语法校验 ───

describe("validateSelector", () => {
  it("accepts valid test file paths", () => {
    expect(() => validateSelector("test/sum.test.ts")).not.toThrow()
    expect(() => validateSelector("test/foo/bar.test.ts")).not.toThrow()
    expect(() => validateSelector("src/__tests__/sum.test.ts")).not.toThrow()
  })

  it("accepts valid vitest selectors like --grep or --bail", () => {
    expect(() => validateSelector("--bail=1")).not.toThrow()
    expect(() => validateSelector("--reporter=verbose")).not.toThrow()
    expect(() => validateSelector("--update")).not.toThrow()
  })

  it("rejects selector containing pipe", () => {
    expect(() => validateSelector("test/sum.test.ts | cat")).toThrow(/selector|invalid|dangerous/i)
  })

  it("rejects selector containing semicolon", () => {
    expect(() => validateSelector("test/sum.test.ts; rm -rf /")).toThrow(/selector|invalid|dangerous/i)
  })

  it("rejects selector containing ampersand", () => {
    expect(() => validateSelector("test/sum.test.ts &")).toThrow(/selector|invalid|dangerous/i)
  })

  it("rejects selector containing dollar sign", () => {
    expect(() => validateSelector("$(whoami)")).toThrow(/selector|invalid|dangerous/i)
  })

  it("rejects selector containing backtick", () => {
    expect(() => validateSelector("`whoami`")).toThrow(/selector|invalid|dangerous/i)
  })

  it("rejects selector containing parentheses used for command substitution", () => {
    expect(() => validateSelector("test/foo)(); rm -rf /")).toThrow(/selector|invalid|dangerous/i)
  })

  it("rejects empty selector", () => {
    expect(() => validateSelector("")).toThrow(/selector|empty/i)
  })

  it("rejects whitespace-only selector", () => {
    expect(() => validateSelector("   ")).toThrow(/selector|empty/i)
  })

  it("rejects selector with newline", () => {
    expect(() => validateSelector("test/sum.test.ts\nrm -rf /")).toThrow(/selector|invalid|dangerous/i)
  })

  it("rejects selector with carriage return", () => {
    expect(() => validateSelector("test/sum.test.ts\rrm -rf /")).toThrow(/selector|invalid|dangerous/i)
  })
})

// ─── vitest args 构建 ───

describe("buildVitestArgs", () => {
  it("parses simple baseCommand and appends selector", () => {
    const policy = makePolicy({ baseCommand: "npx vitest run" })
    const args = buildVitestArgs(policy, "test/sum.test.ts")
    expect(args).toEqual(["npx", "vitest", "run", "test/sum.test.ts"])
  })

  it("handles baseCommand with extra spaces", () => {
    const policy = makePolicy({ baseCommand: "  npx   vitest  run  " })
    const args = buildVitestArgs(policy, "test/sum.test.ts")
    expect(args[0]).toBe("npx")
  })

  it("appends selector after baseCommand args", () => {
    const policy = makePolicy({ baseCommand: "npx vitest run --reporter=json" })
    const args = buildVitestArgs(policy, "test/sum.test.ts")
    expect(args[args.length - 1]).toBe("test/sum.test.ts")
    expect(args).toContain("--reporter=json")
  })
})

// ─── 失败分类 ───

describe("classifyVitestFailure", () => {
  it("classifies assertion failure when tests collected and exit code non-zero", () => {
    const result = classifyVitestFailure({
      exitCode: 1,
      testsCollected: 3,
      testsFailed: 1,
      stderr: "AssertionError: expected 2 to be 3\n ❯ test/sum.test.ts:5:25",
    })
    expect(result).toBe("assertion")
  })

  it("classifies missing-behavior when module resolution error for implementation file", () => {
    const result = classifyVitestFailure({
      exitCode: 1,
      testsCollected: 0,
      testsFailed: 0,
      stderr: "Error: Cannot find module '../src/sum.js' imported from test/sum.test.ts",
    })
    expect(result).toBe("missing-behavior")
  })

  it("classifies as infrastructure for config error", () => {
    const result = classifyVitestFailure({
      exitCode: 1,
      testsCollected: 0,
      testsFailed: 0,
      stderr: "failed to load config from vitest.config.ts",
    })
    expect(result).toBe("infrastructure")
  })

  it("classifies as infrastructure for dependency missing", () => {
    const result = classifyVitestFailure({
      exitCode: 1,
      testsCollected: 0,
      testsFailed: 0,
      stderr: "Error: Cannot find package 'vitest' imported from ...",
    })
    expect(result).toBe("infrastructure")
  })

  it("classifies as infrastructure for transform error", () => {
    const result = classifyVitestFailure({
      exitCode: 1,
      testsCollected: 0,
      testsFailed: 0,
      stderr: "Transform failed with 1 error: src/broken.ts:1:0: ERROR: Unexpected token",
    })
    expect(result).toBe("infrastructure")
  })

  it("classifies as infrastructure when zero tests collected", () => {
    const result = classifyVitestFailure({
      exitCode: 1,
      testsCollected: 0,
      testsFailed: 0,
      stderr: "No test files found matching the pattern",
    })
    expect(result).toBe("infrastructure")
  })

  it("classifies as timeout when process timed out", () => {
    const result = classifyVitestFailure({
      exitCode: null, // killed by timeout
      testsCollected: null,
      testsFailed: null,
      stderr: "",
      timedOut: true,
    })
    expect(result).toBe("timeout")
  })

  it("returns null when all tests pass", () => {
    const result = classifyVitestFailure({
      exitCode: 0,
      testsCollected: 5,
      testsFailed: 0,
      stderr: "",
      timedOut: false,
    })
    expect(result).toBeNull()
  })

  it("returns unknown for unrecognized failure pattern", () => {
    const result = classifyVitestFailure({
      exitCode: 1,
      testsCollected: 1,
      testsFailed: 0, // exit code 1 but no test failed — unusual
      stderr: "Something went wrong",
    })
    expect(result).toBe("unknown")
  })

  it("classifies infrastructure for cant find module to vitest deps (not implementation)", () => {
    const result = classifyVitestFailure({
      exitCode: 1,
      testsCollected: 0,
      testsFailed: 0,
      stderr: "Error: Cannot find module '@testing-library/react'",
    })
    expect(result).toBe("infrastructure")
  })
})

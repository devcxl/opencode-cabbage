import { describe, it, expect } from "vitest"
import { writeFile, mkdir, rm } from "node:fs/promises"
import { resolve, join } from "node:path"
import { tmpdir } from "node:os"
import { randomUUID } from "node:crypto"
import type { CoverageEvidence, CoveragePolicy } from "../../src/flowrun/types.js"

import {
  validateCoveragePath,
  parseCoverageReport,
  buildCoverageEvidence,
  checkCoverageThreshold,
  resolveCoveragePath,
} from "../../src/flowrun/coverage.js"

// ─── 辅助函数 ───

async function createTempDir(): Promise<string> {
  const dir = join(tmpdir(), `coverage-test-${randomUUID()}`)
  await mkdir(dir, { recursive: true })
  return dir
}

async function writeCoverageFile(dir: string, filename: string, content: object): Promise<string> {
  const filePath = join(dir, filename)
  await writeFile(filePath, JSON.stringify(content))
  return filePath
}

// ─── validateCoveragePath 测试 ───

describe("validateCoveragePath", () => {
  it("accepts safe relative path inside sandbox", () => {
    const sandbox = "/tmp/worktree/tdd-task-1"
    expect(() => validateCoveragePath("coverage/coverage-summary.json", sandbox)).not.toThrow()
  })

  it("accepts nested relative path inside sandbox", () => {
    const sandbox = "/tmp/worktree/tdd-task-1"
    expect(() => validateCoveragePath("sub/dir/report.json", sandbox)).not.toThrow()
  })

  it("rejects path with .. traversal", () => {
    const sandbox = "/tmp/worktree/tdd-task-1"
    expect(() => validateCoveragePath("../etc/passwd", sandbox)).toThrow()
  })

  it("rejects path with .. in middle of path", () => {
    const sandbox = "/tmp/worktree/tdd-task-1"
    expect(() => validateCoveragePath("coverage/../../secret.txt", sandbox)).toThrow()
  })

  it("rejects absolute path", () => {
    const sandbox = "/tmp/worktree/tdd-task-1"
    expect(() => validateCoveragePath("/etc/passwd", sandbox)).toThrow()
  })

  it("rejects path with null bytes", () => {
    const sandbox = "/tmp/worktree/tdd-task-1"
    expect(() => validateCoveragePath("coverage/\0bad.json", sandbox)).toThrow()
  })

  it("rejects empty path", () => {
    const sandbox = "/tmp/worktree/tdd-task-1"
    expect(() => validateCoveragePath("", sandbox)).toThrow()
  })
})

// ─── resolveCoveragePath 测试 ───

describe("resolveCoveragePath", () => {
  it("resolves relative path within sandbox", () => {
    const sandbox = "/tmp/worktree/tdd-task-1"
    const resolved = resolveCoveragePath("coverage/report.json", sandbox)
    expect(resolved).toBe("/tmp/worktree/tdd-task-1/coverage/report.json")
  })

  it("throws when resolved path escapes sandbox", () => {
    const sandbox = "/tmp/worktree/tdd-task-1"
    expect(() => resolveCoveragePath("../outside.json", sandbox)).toThrow()
  })
})

// ─── parseCoverageReport 测试 ───

describe("parseCoverageReport", () => {
  it("parses valid istanbul-json-summary report", async () => {
    const dir = await createTempDir()
    try {
      const reportPath = await writeCoverageFile(dir, "coverage-summary.json", {
        total: {
          lines: {
            total: 100,
            covered: 85,
            skipped: 0,
            pct: 85.0,
          },
          statements: { total: 110, covered: 95, skipped: 0, pct: 86.36 },
          functions: { total: 20, covered: 18, skipped: 0, pct: 90.0 },
          branches: { total: 30, covered: 24, skipped: 0, pct: 80.0 },
        },
      })

      const result = await parseCoverageReport(reportPath, "lines")

      expect(result).not.toBeNull()
      expect(result!.actual).toBe(85.0)
      expect(result!.metric).toBe("lines")
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("returns null when report file does not exist", async () => {
    const result = await parseCoverageReport("/nonexistent/path/coverage-summary.json", "lines")
    expect(result).toBeNull()
  })

  it("returns null when total.lines is missing", async () => {
    const dir = await createTempDir()
    try {
      const reportPath = await writeCoverageFile(dir, "coverage-summary.json", {
        total: {
          statements: { total: 110, covered: 95, skipped: 0, pct: 86.36 },
        },
      })

      const result = await parseCoverageReport(reportPath, "lines")
      expect(result).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("returns null when lines.pct is NaN", async () => {
    const dir = await createTempDir()
    try {
      const reportPath = await writeCoverageFile(dir, "coverage-summary.json", {
        total: {
          lines: {
            total: 0,
            covered: 0,
            skipped: 0,
            pct: "Unknown",
          },
        },
      })

      const result = await parseCoverageReport(reportPath, "lines")
      expect(result).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("returns null when lines.pct is explicitly NaN", async () => {
    const dir = await createTempDir()
    try {
      const reportPath = await writeCoverageFile(dir, "coverage-summary.json", {
        total: {
          lines: {
            total: 0,
            covered: 0,
            skipped: 0,
            pct: NaN,
          },
        },
      })

      const result = await parseCoverageReport(reportPath, "lines")
      expect(result).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("returns null when pct is out of range (> 100)", async () => {
    const dir = await createTempDir()
    try {
      const reportPath = await writeCoverageFile(dir, "coverage-summary.json", {
        total: {
          lines: {
            total: 100,
            covered: 200,
            skipped: 0,
            pct: 200.0,
          },
        },
      })

      const result = await parseCoverageReport(reportPath, "lines")
      expect(result).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("returns null when pct is negative", async () => {
    const dir = await createTempDir()
    try {
      const reportPath = await writeCoverageFile(dir, "coverage-summary.json", {
        total: {
          lines: {
            total: 100,
            covered: -10,
            skipped: 0,
            pct: -10.0,
          },
        },
      })

      const result = await parseCoverageReport(reportPath, "lines")
      expect(result).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("returns null when report JSON is malformed", async () => {
    const dir = await createTempDir()
    try {
      const filePath = join(dir, "coverage-summary.json")
      await writeFile(filePath, "not valid json {{{")

      const result = await parseCoverageReport(filePath, "lines")
      expect(result).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("returns null when total is not an object", async () => {
    const dir = await createTempDir()
    try {
      const reportPath = await writeCoverageFile(dir, "coverage-summary.json", {
        total: "not-an-object",
      })

      const result = await parseCoverageReport(reportPath, "lines")
      expect(result).toBeNull()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it("extracts correct pct from valid total.lines", async () => {
    const dir = await createTempDir()
    try {
      const reportPath = await writeCoverageFile(dir, "coverage-summary.json", {
        total: {
          lines: { total: 50, covered: 45, skipped: 0, pct: 90.0 },
        },
      })

      const result = await parseCoverageReport(reportPath, "lines")
      expect(result).not.toBeNull()
      expect(result!.actual).toBe(90.0)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

// ─── buildCoverageEvidence 测试 ───

describe("buildCoverageEvidence", () => {
  it("builds pass evidence when actual meets threshold", () => {
    const result = buildCoverageEvidence({
      actual: 85.0,
      threshold: 80.0,
      metric: "lines",
      headSha: "abc123",
      reportDigest: "digest-abc",
    })

    expect(result.status).toBe("pass")
    expect(result.actual).toBe(85.0)
    expect(result.threshold).toBe(80.0)
    expect(result.metric).toBe("lines")
    expect(result.headSha).toBe("abc123")
    expect(result.reportDigest).toBe("digest-abc")
    expect(result.summary).toContain("85%")
  })

  it("builds fail evidence when actual is below threshold", () => {
    const result = buildCoverageEvidence({
      actual: 75.0,
      threshold: 80.0,
      metric: "lines",
      headSha: "abc123",
      reportDigest: "digest-def",
    })

    expect(result.status).toBe("fail")
    expect(result.actual).toBe(75.0)
    expect(result.summary).toContain("75%")
    expect(result.summary).toContain("80%")
  })

  it("builds pending evidence when actual is null", () => {
    const result = buildCoverageEvidence({
      actual: null,
      threshold: 80.0,
      metric: "lines",
      headSha: "abc123",
      reportDigest: null,
    })

    expect(result.status).toBe("pending")
    expect(result.actual).toBeNull()
    expect(result.reportDigest).toBeNull()
  })

  it("exact match at threshold is pass", () => {
    const result = buildCoverageEvidence({
      actual: 80.0,
      threshold: 80.0,
      metric: "lines",
      headSha: "abc123",
      reportDigest: "digest",
    })

    expect(result.status).toBe("pass")
  })
})

// ─── checkCoverageThreshold 测试 ───

describe("checkCoverageThreshold", () => {
  it("pass when actual >= threshold", () => {
    expect(checkCoverageThreshold(85, 80)).toBe(true)
    expect(checkCoverageThreshold(80, 80)).toBe(true)
    expect(checkCoverageThreshold(100, 80)).toBe(true)
  })

  it("fail when actual < threshold", () => {
    expect(checkCoverageThreshold(75, 80)).toBe(false)
    expect(checkCoverageThreshold(0, 80)).toBe(false)
  })
})

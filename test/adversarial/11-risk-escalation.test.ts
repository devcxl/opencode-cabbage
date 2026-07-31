/**
 * 对抗测试 #11 — 高风险 diff 自动升级（只升不降）：
 * 低质量模型初判 low，但 diff 命中 migrations/auth/permissions/release workflow/密钥 → 内核升级 high；
 * 模型谎报 high 不得被降级。
 */
import { describe, it, expect } from "vitest"
import { escalateRisk, matchRiskPattern, BUILTIN_RISK_PATTERNS } from "../../src/kernel/task.js"

describe("adversarial #11 — 高风险 diff 升级（只升不降）", () => {
  it.each([
    ["src/db/migrations/001.sql"],
    ["src/service/auth/login.ts"],
    ["src/policy/permissions/grant.ts"],
    [".github/workflows/release.yml"],
    [".env"],
    ["secrets/prod.key"],
  ])("diff 命中 %s → 内核把模型 low 升级为 high", (file) => {
    expect(escalateRisk("low", [file], BUILTIN_RISK_PATTERNS)).toBe("high")
  })

  it("模型初判 high 即使 diff 干净也不降级", () => {
    expect(escalateRisk("high", ["README.md"], BUILTIN_RISK_PATTERNS)).toBe("high")
    expect(escalateRisk("high", ["src/util/fs.ts"], BUILTIN_RISK_PATTERNS)).toBe("high")
  })

  it("干净 diff + 模型 low → 维持 low", () => {
    expect(escalateRisk("low", ["src/util/fs.ts"], BUILTIN_RISK_PATTERNS)).toBe("low")
  })

  it("matchRiskPattern 精确匹配（前缀/目录不得误伤）", () => {
    expect(matchRiskPattern("src/db/migrations/001.sql", "**/migrations/**")).toBe(true)
    expect(matchRiskPattern("src/util/fs.ts", "**/migrations/**")).toBe(false)
    expect(matchRiskPattern("README.md", "**/auth/**")).toBe(false)
  })

  it("Profile 追加的风险 pattern 与内置合并生效", () => {
    expect(escalateRisk("low", ["src/money/calc.ts"], [...BUILTIN_RISK_PATTERNS, "**/money/**"])).toBe("high")
  })
})

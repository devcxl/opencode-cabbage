import { describe, it, expect } from "vitest"
import { parsePrUrlNumber } from "../../src/util/gh.js"

describe("parsePrUrlNumber", () => {
  it("从 PR URL 解析编号", () => {
    expect(parsePrUrlNumber("https://github.com/devcxl/opencode-cabbage/pull/42")).toBe(42)
    expect(parsePrUrlNumber("https://github.com/devcxl/opencode-cabbage/pull/42\n")).toBe(42)
  })

  it("解析失败返回 null", () => {
    expect(parsePrUrlNumber("")).toBe(null)
    expect(parsePrUrlNumber("error: something went wrong")).toBe(null)
    expect(parsePrUrlNumber("0")).toBe(null)
    expect(parsePrUrlNumber("https://github.com/devcxl/opencode-cabbage/pull/abc")).toBe(null)
  })
})

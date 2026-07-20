import { describe, it, expect } from "vitest"
import { sum } from "../src/sum.js"

describe("sum", () => {
  it("1 + 2 = 3", () => {
    expect(sum(1, 2)).toBe(3)
  })

  it("0 + 0 = 0", () => {
    expect(sum(0, 0)).toBe(0)
  })
})

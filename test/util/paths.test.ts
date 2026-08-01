import { describe, it, expect } from "vitest"
import { resolveProjectDir } from "../../src/util/paths.js"

describe("resolveProjectDir", () => {
  it("优先使用会话级绝对目录", () => {
    expect(resolveProjectDir("/home/user/proj", "/fallback")).toBe("/home/user/proj")
  })

  it("workspace root 异常为 / 时回退到插件级 projectDir", () => {
    expect(resolveProjectDir("/", "/home/user/proj")).toBe("/home/user/proj")
  })

  it("空字符串回退", () => {
    expect(resolveProjectDir("", "/home/user/proj")).toBe("/home/user/proj")
    expect(resolveProjectDir(undefined, "/home/user/proj")).toBe("/home/user/proj")
  })

  it("相对路径（测试 mock 场景）回退", () => {
    expect(resolveProjectDir(".", "/home/user/proj")).toBe("/home/user/proj")
    expect(resolveProjectDir("relative/path", "/home/user/proj")).toBe("/home/user/proj")
  })
})

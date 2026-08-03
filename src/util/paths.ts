import path from "node:path"

export const PLUGIN_ID = "opencode-cabbage"

/**
 * 解析会话级项目目录。
 * 插件级 ctx.directory/worktree 是 workspace 根，异常会话下可能是文件系统根 `/`；
 * ToolContext.directory 才是 session 的项目目录。优先使用它，无效（空/相对/`/`）时退化到插件级 projectDir。
 */
export function resolveProjectDir(ctxDirectory: string | undefined, fallback: string): string {
  if (
    typeof ctxDirectory === "string" &&
    ctxDirectory.trim() !== "" &&
    ctxDirectory !== "/" &&
    path.isAbsolute(ctxDirectory)
  ) {
    return ctxDirectory
  }
  return fallback
}

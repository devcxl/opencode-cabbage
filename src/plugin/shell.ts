// ─── Shell 环境 ───

/**
 * 为 Agent 生成 shell 环境变量。
 *
 * 复用宿主 gh auth：不再清空 GH_TOKEN/GITHUB_TOKEN、不替换 HOME/GH_CONFIG_DIR，
 * Agent shell 内只读 gh 可用（PRD R4「模型可直接只读 git/gh」）。
 * 写操作凭据只存在于插件进程（util/gh.ts 继承 process.env），Agent shell 永不获得。
 */
export function createAgentShellEnv(): Record<string, string> {
  return {
    // 防系统 gitconfig 干扰
    GIT_CONFIG_NOSYSTEM: "1",
    // 禁止交互式凭据提示（失败即失败，不挂起等待输入）
    GIT_TERMINAL_PROMPT: "0",
  }
}

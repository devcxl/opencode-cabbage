// ─── Shell 环境 ───

/**
 * 为 Agent 生成 shell 环境变量。
 *
 * 复用宿主 gh auth：不再清空 GH_TOKEN/GITHUB_TOKEN、不替换 HOME/GH_CONFIG_DIR，
 * Agent shell 内只读 gh/git 可用（PRD R4「模型可直接只读 git/gh」）。
 * 安全边界：写操作凭据与模型 shell 共享宿主 auth，因此**写操作靠 permission 规则
 * （deny 置尾、最后匹配优先、auto 模式 deny 生效）收敛到生命周期工具**，
 * 而非依赖凭据隔离——见 spec §7.3 的取舍说明。
 */
export function createAgentShellEnv(): Record<string, string> {
  return {
    // 防系统 gitconfig 干扰
    GIT_CONFIG_NOSYSTEM: "1",
    // 禁止交互式凭据提示（失败即失败，不挂起等待输入）
    GIT_TERMINAL_PROMPT: "0",
  }
}

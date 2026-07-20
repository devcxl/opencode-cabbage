import fs from "node:fs"
import path from "node:path"
import os from "node:os"
import type { AgentEntry } from "./agents.js"

// ─── 类型 ───

export interface AmbientCredentialSource {
  source: string
  /** "env" | "config_file" | "credential_helper" */
  kind: "env" | "config_file" | "credential_helper"
  /** 具体位置（如 "GH_TOKEN" 或 "~/.config/gh/hosts.yml"） */
  location: string
}

export interface AmbientCredentialReport {
  hasWriteCredentials: boolean
  hasGitCredentialHelper: boolean
  sources: AmbientCredentialSource[]
}

// ─── 凭证检测 ───

const GITHUB_WRITE_TOKEN_PATTERNS = [
  /^ghp_/,        // classic PAT
  /^github_pat_/, // fine-grained PAT
  /^gho_/,        // OAuth token
  /^ghu_/,        // user-to-server token
  /^ghs_/,        // server-to-server token
  /^ghr_/,        // refresh token
]

/**
 * 检测 token 值是否看起来是 GitHub 写凭证。
 */
function looksLikeGithubToken(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  return GITHUB_WRITE_TOKEN_PATTERNS.some(p => p.test(trimmed))
}

/**
 * 检测环境变量中的 GitHub API 凭证。
 */
function detectEnvTokens(): AmbientCredentialSource[] {
  const sources: AmbientCredentialSource[] = []
  const keys = ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN"]

  for (const key of keys) {
    const value = process.env[key]
    if (value && looksLikeGithubToken(value)) {
      sources.push({
        source: key,
        kind: "env",
        location: `$${key}`,
      })
    }
  }

  return sources
}

/**
 * 检测 ~/.config/gh/hosts.yml 中的 oauth_token。
 */
function detectGhHostsConfig(): AmbientCredentialSource[] {
  const sources: AmbientCredentialSource[] = []
  const home = process.env.HOME || os.homedir()
  const hostsPath = path.join(home, ".config", "gh", "hosts.yml")

  try {
    if (!fs.existsSync(hostsPath)) return sources

    const content = fs.readFileSync(hostsPath, "utf8")
    // 简单检测 oauth_token 字段
    if (/oauth_token\s*:\s*\S+/.test(content)) {
      sources.push({
        source: "gh_hosts_config",
        kind: "config_file",
        location: hostsPath,
      })
    }
  } catch {
    // 读取失败时静默忽略
  }

  return sources
}

/**
 * 检测 git credential helper 配置。
 * 检查 ~/.gitconfig 中是否配置了 credential.helper。
 */
function detectGitCredentialHelper(): { hasHelper: boolean; sources: AmbientCredentialSource[] } {
  const sources: AmbientCredentialSource[] = []
  const home = process.env.HOME || os.homedir()
  const gitconfigPath = path.join(home, ".gitconfig")

  let hasHelper = false

  try {
    if (!fs.existsSync(gitconfigPath)) return { hasHelper, sources }

    const content = fs.readFileSync(gitconfigPath, "utf8")
    if (/credential\s*\]\s*\n\s*helper\s*=/.test(content) || /\[credential\s+"[^"]*"\]/.test(content)) {
      hasHelper = true
      sources.push({
        source: "git_credential_helper",
        kind: "credential_helper",
        location: gitconfigPath,
      })
    }
  } catch {
    // 读取失败静默忽略
  }

  return { hasHelper, sources }
}

/**
 * 检测宿主环境中的 GitHub 写凭证。
 *
 * 检查内容：
 * - GH_TOKEN / GITHUB_TOKEN / GH_ENTERPRISE_TOKEN 环境变量
 * - ~/.config/gh/hosts.yml（GitHub CLI OAuth token）
 * - ~/.gitconfig 中的 credential helper
 *
 * 注意：这只能检测常见模式，不是完备的安全审计。
 */
export function detectAmbientCredentials(): AmbientCredentialReport {
  const envSources = detectEnvTokens()
  const ghConfigSources = detectGhHostsConfig()
  const { hasHelper, sources: helperSources } = detectGitCredentialHelper()

  const allSources = [...envSources, ...ghConfigSources, ...helperSources]
  const hasWriteCredentials = allSources.length > 0

  return {
    hasWriteCredentials,
    hasGitCredentialHelper: hasHelper,
    sources: allSources,
  }
}

// ─── Shell 隔离 ───

/**
 * 为 Worker agent 创建隔离 shell 环境变量。
 *
 * 隔离措施：
 * - HOME 设为临时目录（避免访问宿主 ~/.ssh, ~/.gitconfig 等）
 * - GH_CONFIG_DIR 设为临时目录下的隔离路径
 * - GH_TOKEN / GITHUB_TOKEN 显式清空
 * - GIT_CONFIG_PARAMETERS 不传递（避免继承宿主 git config）
 *
 * 重要：shell.env 只作为附加措施，不作为唯一隔离边界。
 * 真正的权限控制来自 agent permission 字段 + ambient credential 检测。
 */
export function createIsolatedShellEnv(agent: AgentEntry): Record<string, string> {
  const shellHome = fs.mkdtempSync(path.join(os.tmpdir(), "cabbage-shell-"))
  const ghConfigDir = path.join(shellHome, ".config", "gh")
  fs.mkdirSync(ghConfigDir, { recursive: true })

  const env: Record<string, string> = {
    HOME: shellHome,
    GH_CONFIG_DIR: ghConfigDir,
  }

  // 清除所有 GitHub API token 环境变量
  // shell.env 是附加措施 — 主要隔离由 agent permission 提供
  env.GH_TOKEN = ""
  env.GITHUB_TOKEN = ""
  env.GH_ENTERPRISE_TOKEN = ""

  // 不传递宿主 git config（隔离 HOME 已处理此问题，但显式清空更安全）
  env.GIT_CONFIG_NOSYSTEM = "1"

  return env
}

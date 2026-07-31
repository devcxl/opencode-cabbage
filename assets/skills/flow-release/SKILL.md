---
name: flow-release
description: 版本 → Release PR → GitHub Actions 发布（release_control，仅人工）
---

# flow-release

通过 `release_control` 完成版本提议、Release PR、合并发布与发布监控。
发布流程技术栈无关：按 Profile 的版本规则（version file / tag format / release workflow）执行，
最终发布走项目自己的 GitHub Actions release workflow（不假设 npm 或任何特定生态）。

## 核心：调用 release_control

1. `release_control{op:"propose-version"}` — 聚合上一 tag 后全部 commit，按 Profile 版本规则分类，输出提议版本
2. `release_control{op:"open-release-pr"}` — 固定顺序：release branch → 按 Profile 写规则更新版本 → Release PR（人工确认后）
3. `release_control{op:"merge-release-pr"}` — CI + 人工批准 → merge → SHA 校验 → 打 tag push
4. `release_control{op:"monitor"}` — 轮询 GitHub Actions release workflow 至成功；瞬时失败 rerun；代码/配置缺陷 → Corrective Flow

## 版本规则（Profile）

版本分类依赖 AGENTS.md `## Project Profile` 的 `version bump rule`：
`breaking→major, feature→minor, fix→patch`（0.x breaking 也 major）。
未分类 commit → release_control 要求用户分类后重试。

## Output
- 提议版本
- Release PR（合并 + tag push）
- GitHub Actions release workflow 运行结果

## 后续
- 发布完成后 Flow 结束（goal-verify 独立验证 → complete-flow）

## Contract

### Trigger
由 `/release` 命令触发。**仅手动触发**，不包含在自动流程中。

### Inputs
- 用户对提议版本/Release 的确认

### Preconditions
- 所有 PR 已合并
- 默认分支最新且 CI 通过
- Release Profile 已确认（AGENTS.md Project Profile）

### Procedure
1. 调用 `release_control{op:"propose-version"}` 确定版本
2. 调用 `release_control{op:"open-release-pr"}` 创建 Release PR（人工确认）
3. 调用 `release_control{op:"merge-release-pr"}` 合并 + 打 tag
4. 调用 `release_control{op:"monitor"}` 监控发布 workflow

### Outputs
- GitHub Release（经项目 release workflow）
- tag 已推送

### Failure
- 发布 workflow 失败 → monitor 识别瞬时失败并 rerun；代码/配置缺陷 → Corrective Flow + 新版本
- tag 已存在 → 提示版本冲突

### Idempotency
- 相同版本号 → 阻止重复发布

### Prohibited Actions
- 不在自动模式中执行（release 为人工流程）
- 不假设 npm 或其他特定技术生态（按 Profile 规则 + 项目 GitHub Actions release workflow）
- 不跳过测试/CI 直接发布

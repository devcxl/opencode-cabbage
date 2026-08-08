---
name: flow-release
description: 版本 → Release PR → GitHub Actions 发布（仅人工）
---

# flow-release

完成版本提议、Release PR、合并发布与发布监控。
发布流程技术栈无关：按 Profile 的版本规则（version file / tag format / release workflow）执行，
最终发布走项目自己的 GitHub Actions release workflow（不假设 npm 或任何特定生态）。

## 核心流程

1. **确定版本**：聚合上一 tag 后全部 commit，按 Profile 版本规则分类（breaking→major, feature→minor, fix→patch），输出提议版本
   ```bash
   git describe --tags --abbrev=0
   git log --oneline <last-tag>..HEAD
   ```
2. **创建 Release 分支 + 更新版本文件**
   ```bash
   git checkout -b "release/<version>"
   # 按 Profile 版本文件规则更新版本号（如 package.json 的 version 字段）
   git add -A && git commit -m "chore: release <version>"
   git push -u origin "release/<version>"
   ```
3. **创建 Release PR**（人工确认后）
   ```bash
   gh pr create --base <default> --head "release/<version>" \
     --title "release: <version>" --body "<release notes>"
   ```
4. **合并 + 打 tag push**
   ```bash
   HEAD_SHA=$(gh pr view <pr-number> --json headRefOid --jq .headRefOid)
   gh pr merge <pr-number> --squash --delete-branch --match-head-commit "$HEAD_SHA"
   MERGE_SHA=$(gh pr view <pr-number> --json mergeCommit --jq .mergeCommit.oid)
   git tag "v<version>" "$MERGE_SHA"
   git push origin "v<version>"
   ```
5. **监控发布**：tag push 触发项目 GitHub Actions release workflow，跟踪其运行结果；瞬时失败可重跑；代码/配置缺陷 → Corrective Flow

## 版本规则（Profile）

版本分类依赖 AGENTS.md `## Project Profile` 的 `version bump rule`：
`breaking→major, feature→minor, fix→patch`（0.x breaking 也 major）。
未分类 commit → 请用户分类后重试。

## Output
- 提议版本
- Release PR（合并 + tag push）
- GitHub Actions release workflow 运行结果

## 后续
- 发布完成后 Flow 结束（goal-verify 独立验证 → goal complete）

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
1. 聚合 commit 确定版本
2. 创建 release 分支 + 更新版本文件
3. 创建 Release PR（人工确认）
4. 合并 + 打 tag push
5. 监控发布 workflow

### Outputs
- GitHub Release（经项目 release workflow）
- tag 已推送

### Failure
- 发布 workflow 失败 → 识别瞬时失败并重跑；代码/配置缺陷 → Corrective Flow + 新版本
- tag 已存在 → 提示版本冲突，不强制覆盖

### Idempotency
- 相同版本号 → 阻止重复发布（tag 不可变）

### Prohibited Actions
- 不在自动模式中执行（release 为人工流程）
- 不假设 npm 或其他特定技术生态（按 Profile 规则 + 项目 GitHub Actions release workflow）
- 不跳过测试/CI 直接发布
- 不强制覆盖已存在的 tag

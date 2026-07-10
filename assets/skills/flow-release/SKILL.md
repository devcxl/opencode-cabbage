---
name: flow-release
description: 版本 → Changelog → Release → npm publish（仅人工）
---

# flow-release

版本号更新 → tag 推送 → Release 草稿 → 人工审核发布 → 自动 npm publish。

## Prerequisites
- main 分支最新，所有 PR 已合并
- CI 通过

## Workflow

### 1. 确认版本号
从 conventional commits 自动确定 semver bump：
```bash
git log $(git describe --tags --abbrev=0)..HEAD --oneline
```
- `fix:` → patch | `feat:` → minor | `BREAKING:` → major

### 2. 更新版本号 → 打 tag → 推送
```bash
npm version <major|minor|patch> --no-git-tag-version
# 更新 CHANGELOG.md
git commit -m "chore(release): v<version>"
git tag v<version>
git push origin main --tags
```

### 3. Release 草稿（自动）
tag 推送触发 `.github/workflows/release-draft.yml`：
- 构建 + 测试
- 生成 Release 草稿（含自动 release notes）

### 4. 人工审核发布
GitHub Releases 页面 → 检查 Release 草稿 → 点击 **Publish release**。

发布触发 `.github/workflows/release-publish.yml`：
- 自动 `npm publish`（需要 `NPM_TOKEN` 仓库 Secret）

## Output
- 版本已更新
- tag 已推送
- Release 草稿已创建（待人工发布）
- 发布后自动推送 npm

## 后续
无需后续阶段。Flow 完成。

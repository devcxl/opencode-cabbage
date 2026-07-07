# flow-release

自动版本号 → Changelog → GitHub Release → npm publish。

## Prerequisites
- main 分支最新，所有 PR 已合并

## Workflow

### 1. 确认版本号
从 conventional commits 自动确定 semver bump：
```bash
git log $(git describe --tags --abbrev=0)..HEAD --oneline
```
- `fix:` → patch | `feat:` → minor | `BREAKING:` → major

### 2. 更新 → Tag → Release → Publish
```bash
npm version <major|minor|patch> --no-git-tag-version
# 更新 CHANGELOG.md
git commit -m "chore(release): v<version>"
git tag v<version>
git push origin main --tags
gh release create v<version> --generate-notes
npm publish
```

## Output
- 版本已更新
- GitHub Release 已创建
- npm 包已发布

## 后续
无需后续阶段。Flow 完成。

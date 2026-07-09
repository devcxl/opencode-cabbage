---
title: "E. CI/CD 更新"
status: "pending"
parent: "https://github.com/devcxl/opencode-cabbage/issues/17"
---

## 描述

将 `.github/workflows/pages.yml` 从 Jekyll 构建流程改为 VitePress 构建流程，保留 GitHub Pages 部署。

## 验收标准

- [ ] `.github/workflows/pages.yml` 使用 VitePress 构建而非 Jekyll
- [ ] workflow 包含 `npm ci` + `npm run docs:build` 步骤
- [ ] 使用 `actions/upload-pages-artifact@v3` 上传 `.vitepress-dist` 目录
- [ ] 使用 `actions/deploy-pages@v4` 部署到 GitHub Pages
- [ ] `permissions` 包含 `pages: write` 和 `id-token: write`
- [ ] `concurrency` 配置防止并发部署
- [ ] push 到 main 分支时自动触发

## 实现要点

### 替换文件内容

将 `pages.yml` 完整替换为：

```yaml
name: Deploy VitePress to GitHub Pages

on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm

      - name: Install dependencies
        run: npm ci

      - name: Build VitePress
        run: npm run docs:build

      - name: Upload artifact
        uses: actions/upload-pages-artifact@v3
        with:
          path: .vitepress-dist

      - name: Deploy to GitHub Pages
        uses: actions/deploy-pages@v4
```

### 关键变更

| 旧 (Jekyll) | 新 (VitePress) |
|-------------|----------------|
| `actions/configure-pages@v5` | 移除（不需要） |
| `actions/jekyll-build-pages@v1` | `npm ci` + `npm run docs:build` |
| `upload-pages-artifact` 无 path | `path: .vitepress-dist` |
| `deploy` job 独立 | 合并到 `build` job |

### 注意事项

- 仓库 Settings → Pages 需要设置 Source 为 "GitHub Actions"
- 现有 trigger 条件 `paths: docs/**, README.md, _config.yml` 需移除（或改为通用触发），因为 `_config.yml` 将被删除
- Node.js 版本使用 20（与项目 `engines` 约束一致）
- 使用 `npm ci` 而非 `npm install`（更快、更可靠）
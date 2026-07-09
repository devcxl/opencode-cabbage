---
name: "创建 GitHub Pages 自动部署 workflow"
depends_on: []
labels: ["infra", "ci"]
---

## 目标

创建 GitHub Actions workflow，在 docs/ 变更时自动构建并部署到 GitHub Pages。

## 实现要点

- pages.yml：push → main + path filter
- Jekyll 构建（source: ./docs）
- Pages artifact 上传 + 部署
- 并发控制、权限配置

## 验收标准

- [x] .github/workflows/pages.yml 已创建
- [x] push 到 main 且 docs/ 变更时触发
- [x] 构建产物正确部署到 GitHub Pages

# ADR 0002: 使用 Jekyll + GitHub Pages 部署文档站点

**状态:** Superseded（被 [ADR 0003](/adr/2026-07-10-jekyll-to-vitepress) 替代）
**日期:** 2026-07-10

## 背景

opencode-cabbage 插件的用户文档（配置指南、使用说明、架构概览）需要可公开访问的部署方式。当前文档仅存在于仓库本地，用户无法在线查阅。

## 决策

使用 Jekyll + GitHub Pages 作为文档站点方案，以 `docs/` 目录为 Jekyll source。

## 备选方案

| 方案 | 未采纳原因 |
|------|-----------|
| Docusaurus | 需要 Node.js 构建步骤和额外依赖维护，对于纯文档站过于重 |
| VitePress | 同上，需额外 CI 构建步骤 |
| 纯 HTML | 需手动管理布局和导航，维护成本高 |
| 仅 README | 单文件无法承载多篇深度文档 |

## 后果

- 正向：零运维成本，push 即部署，免费 HTTPS
- 正向：Jekyll 原生支持 GitHub Pages，无需额外配置
- 正向：`jekyll-relative-links` 插件让文档间链接在 GitHub 和 Pages 上同时可用
- 风险：Jekyll 主题和插件选择受 GitHub Pages 支持列表限制
- 风险：需要用户在仓库 Settings 中手动开启 GitHub Actions 作为 Pages 源

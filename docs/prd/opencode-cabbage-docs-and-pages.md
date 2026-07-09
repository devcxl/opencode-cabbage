# PRD: opencode-cabbage 配置指南与 GitHub Pages 自动部署

**Status:** Approved

## 背景与动机

opencode-cabbage 插件功能完整（9 个命令、5 个 agent、FlowRun 引擎），但缺少系统的配置指南、使用文档和架构说明。用户安装后无从了解完整能力，需要一份可公开访问的文档站点。

## 目标

- 提供完整的配置指南、使用指南和架构概览
- 通过 GitHub Pages 自动部署，让文档可公开访问
- 降低用户上手门槛（5 分钟内完成安装到运行）

## 范围

### In Scope

- `docs/guides/quickstart.md` — 快速开始
- `docs/guides/configuration.md` — 配置指南
- `docs/guides/usage.md` — 使用指南
- `docs/guides/architecture.md` — 架构概览
- `docs/index.md` — 站点首页
- `docs/_config.yml` — Jekyll 站点配置
- `.github/workflows/pages.yml` — Pages 自动部署 workflow
- README.md 更新为完整门户文档

### Out of Scope

- API 文档自动生成（typedoc 等）
- 多语言/国际化文档
- 文档搜索功能
- 版本化文档（多版本切换）

## 用户故事

- 作为**插件使用者**，我希望看到完整的配置说明，以便正确安装和配置插件
- 作为**插件使用者**，我希望有快速开始指南，以便 5 分钟内上手
- 作为**插件开发者**，我希望了解架构设计，以便参与贡献
- 作为**任何人**，我希望文档在浏览器中可访问，而不是只能读本地文件

## 验收标准

- [ ] `docs/guides/` 下包含 quickstart、configuration、usage、architecture 四篇文档
- [ ] `docs/index.md` 作为站点首页，包含命令一览和快速链接
- [ ] `docs/_config.yml` Jekyll 配置正确
- [ ] `.github/workflows/pages.yml` 自动部署 workflow 完成
- [ ] push 到 main 且 docs/ 变更时自动触发 Pages 部署

## 技术约束

- 站点构建：Jekyll + GitHub Pages
- 部署触发：push 到 main 且 docs/ 路径变更
- 无额外构建依赖（纯 markdown）
- GitHub Pages Source 需设置为 GitHub Actions

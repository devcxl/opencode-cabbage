# VitePress 文档站迁移

## 概述

将现有 Jekyll 文档站迁移到 VitePress，获得更好的开发体验、更快的构建速度和更现代的交互能力。

## 用户故事

- 作为**开发者/贡献者**，我希望文档站加载快、支持全文搜索、有清晰的导航结构
- 作为**项目维护者**，我希望文档站构建简单、与项目技术栈一致（TypeScript/Vite）

## In Scope

1. **Jekyll → VitePress 迁移**
   - 初始化 VitePress 配置（默认主题）
   - 迁移 `docs/` 下全部 `.md` 文件
   - 配置自动侧边栏 + 导航栏
   - 开启全文搜索

2. **首页改造**
   - VitePress 默认首页布局
   - 展示 npm 版本号（`0.1.0`）
   - 纯文字标题，无 Logo

3. **CI/CD 更新**
   - 更新 `.github/workflows/pages.yml`：Jekyll → VitePress 构建
   - 保留 GitHub Pages 部署

4. **清理**
   - 删除 Jekyll 配置（`docs/_config.yml`）
   - 确认无残留 Jekyll 依赖

## Out of Scope

- 自定义 VitePress 主题 — 使用默认主题
- 自定义域名配置
- 多语言支持
- 文档内容重写/重组 — 仅迁移，不修改内容

## 验收标准

- [x] 本地 `npm run docs:dev` 可正常预览
- [x] 全部 18 个 `.md` 文件迁移无遗漏
- [x] 侧边栏按目录结构自动生成
- [x] 全文搜索可用
- [x] 首页展示项目名称 + 版本号
- [x] GitHub Pages 部署成功可访问
- [x] 旧 Jekyll 文件已清理

## 技术约束

- 使用 VitePress 最新稳定版
- 项目本身是 TypeScript 包，VitePress 构建与之兼容
- Node.js >= 18
- 部署到 GitHub Pages（现有 Pages 配置上修改）
- Jekyll 配置（`_config.yml`）需在构建前移除，否则 GitHub Pages 默认 Jekyll 会干扰

## 优先级

| 项 | 优先级 |
|----|--------|
| VitePress 初始化 + 配置 | P0 |
| 内容迁移 | P0 |
| CI/CD 更新 | P0 |
| 首页版本号 | P1 |
| Jekyll 清理 | P1 |

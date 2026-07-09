# ADR 0003: 从 Jekyll 迁移到 VitePress

**状态:** Accepted
**日期:** 2026-07-10
**上级:** [ADR 0002](/adr/2026-07-10-jekyll-github-pages-docs)（被替代）

## 背景

[ADR 0002](/adr/2026-07-10-jekyll-github-pages-docs) 选择了 Jekyll + GitHub Pages 作为文档站方案，理由是"零运维成本、push 即部署"。但在实际使用中暴露了以下问题：

1. **Ruby 生态割裂**：项目是 TypeScript/Vite 技术栈，Jekyll 需要 Ruby 环境和 Bundler，贡献者本地调试需要额外安装 Ruby，增加了入门门槛
2. **构建受限**：Jekyll 的 GitHub Pages 构建基于 GitHub 的托管环境，无法自定义构建流程，Gemfile 依赖受限
3. **搜索缺失**：Jekyll 默认不提供全文搜索，需要集成第三方插件（如 lunr.js），而 GitHub Pages 不运行自定义插件
4. **开发体验差**：Jekyll 的 livereload 需要额外配置，修改配置后需要重启

## 决策

将文档站从 Jekyll 迁移到 **VitePress**，使用 GitHub Actions 构建并部署到 GitHub Pages。

## 选择 VitePress 的原因

| 维度 | VitePress | Jekyll |
|------|-----------|--------|
| 技术栈 | TypeScript + Vite，与项目一致 | Ruby，与项目割裂 |
| 开发体验 | 热更新 < 1s，配置热重载 | 需手动刷新，配置需重启 |
| 搜索 | 内置 minisearch，零配置 | 需第三方插件 |
| 构建速度 | Vite 二次构建极快 | Jekyll 每次全量构建 |
| 维护方 | Vue 团队（Evan You） | 社区 |
| 导航/侧边栏 | 内置自动生成 | 需手动配置或插件 |
| 主题 | 默认主题即开即用 | 受 GitHub Pages 支持列表限制 |

## 备选方案

| 方案 | 未采纳原因 |
|------|-----------|
| 保留 Jekyll | 已暴露上述问题，且文档站有 19 个 `.md` 文件，搜索和导航需求日益迫切 |
| Docusaurus | 功能丰富但偏重，对于 19 个页面的文档站是过度设计；React 技术栈与项目 Vue 倾向不一致 |
| Nextra | 依赖 Next.js，引入额外框架依赖 |
| 纯 HTML | 维护成本高，不符合"文档站"定位 |

## 迁移范围

- **保留**：全部 19 个 `.md` 文件内容不变，目录结构不变
- **新增**：`docs/.vitepress/config.ts`（VitePress 配置）、`.github/workflows/pages.yml`（CI 构建部署）
- **删除**：`docs/_config.yml`（Jekyll 配置）
- **改造**：`docs/index.md`（从 Jekyll 首页改为 VitePress 首页布局）
- **不修改**：文档内容、目录结构、文件名

## 后果

### 正向

- 技术栈统一：贡献者无需安装 Ruby，仅需 Node.js >= 18
- 开发体验提升：`npm run docs:dev` 即可启动热更新开发服务器
- 全文搜索：内置 minisearch，用户在文档站内即可搜索全部内容
- 自动侧边栏：按目录结构自动生成，新增文档无需手动注册
- 构建可控：GitHub Actions 上自定义构建流程，不受 GitHub Pages 托管限制
- 未来扩展：VitePress 支持自定义主题、Vue 组件嵌入，为后续扩展留空间

### 风险

- 需要创建 GitHub Actions workflow（`.github/workflows/pages.yml`），而非 Jekyll 的自动构建
- 需要在仓库 Settings → Pages 中将 Build source 从 "Deploy from a branch" 改为 "GitHub Actions"
- 旧版 Jekyll 链接（如有外部引用）需要重定向（影响极小，文档站尚未广泛传播）

## 技术方案

详见 [VitePress 文档站迁移技术方案](/dev/specs/vitepress-docs-migration)。
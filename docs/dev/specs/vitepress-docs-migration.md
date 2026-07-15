# VitePress 文档站迁移 — 技术方案

## 概述

将现有 Jekyll 文档站迁移到 VitePress，与项目已有的 TypeScript/Vite 技术栈统一，获得内置全文搜索、更快的 HMR 开发体验和更简洁的 CI/CD 构建流程。

## 1. 依赖安装

```bash
npm install -D vitepress
```

版本约束：`vitepress@^1`（最新稳定版 1.x），要求 Node.js >= 24。

## 2. package.json scripts

新增 3 个 script：

```json
{
  "scripts": {
    "docs:dev": "vitepress dev docs",
    "docs:build": "vitepress build docs",
    "docs:preview": "vitepress preview docs"
  }
}
```

## 3. 目录结构

```
docs/
├── .vitepress/
│   └── config.ts              # 新增：VitePress 配置
├── index.md                   # 保留：VitePress 首页
├── adr/                       # 保留：架构决策记录
├── dev/                       # 保留：开发文档
├── guides/                    # 保留：使用指南
├── prd/                       # 保留：产品需求文档
├── _config.yml                # 删除：Jekyll 残留
```

- VitePress 的 `srcDir` 设为 `docs/`，`outDir` 设为 `../.vitepress-dist`（构建产物放在项目根目录，不污染 `docs/`）
- 所有 `.md` 文件无需移动，目录结构不变

## 4. VitePress 配置

文件：`docs/.vitepress/config.ts`

### 4.1 基本配置

```ts
import { defineConfig } from 'vitepress'
import pkg from '../../package.json'

export default defineConfig({
  title: 'opencode-cabbage',
  description: '全流程开发 OpenCode 插件 — 需求→设计→任务→编码→测试→审查→自动合并',
  srcDir: '.',
  outDir: '../.vitepress-dist',
  lastUpdated: true,
  cleanUrls: true,
  // ...
})
```

- `title`：作为站点标题，显示在导航栏和浏览器标签
- `srcDir: '.'`：以 `docs/` 为 VitePress 源目录
- `outDir: '../.vitepress-dist'`：构建产物输出到项目根目录的 `.vitepress-dist/`，避免与文档源文件混淆
- `lastUpdated: true`：基于 git 显示每页最后更新时间
- `cleanUrls: true`：URL 去掉 `.html` 后缀

### 4.2 首页配置

VitePress 默认首页布局（hero + features）：

```ts
themeConfig: {
  // ...
}
```

在 `docs/index.md` 中使用 frontmatter 配置首页：

```yaml
---
layout: home

hero:
  name: opencode-cabbage
  text: 全流程开发 OpenCode 插件
  tagline: 需求→设计→任务→编码→测试→审查→自动合并
  actions:
    - theme: brand
      text: 快速开始
      link: /guides/quickstart
    - theme: alt
      text: 配置指南
      link: /guides/configuration

features:
  - title: 全流程覆盖
    details: 从需求到发布，9 个 slash command 覆盖完整开发生命周期
  - title: 自动编排
    details: @dev-lifecycle 一键触发全流程自动执行
  - title: 并行 Subagent
    details: 编码阶段自动拆分任务并行执行，提升效率
---
```

版本号展示：在 hero 区域的 `name` 或 `tagline` 中通过 `{{ version }}` 引用。由于 VitePress 首页是静态 Markdown + frontmatter，无法直接使用模板变量。替代方案：在主页 `# 开源 cabbage` 标题下方用 Markdown 显示 Badge 和版本号：

```markdown
---
layout: home
# ... hero 配置
---

<p align="center">
  <a href="https://www.npmjs.com/package/@devcxl/opencode-cabbage">
    <img src="https://img.shields.io/npm/v/@devcxl/opencode-cabbage" alt="npm version">
  </a>
</p>
```

这样通过 npm badge 自动展示最新版本号，无需手动维护。

### 4.3 导航栏

```ts
themeConfig: {
  nav: [
    { text: '首页', link: '/' },
    { text: '快速开始', link: '/guides/quickstart' },
    {
      text: '文档',
      items: [
        { text: '使用指南', items: [
          { text: '快速开始', link: '/guides/quickstart' },
          { text: '配置指南', link: '/guides/configuration' },
          { text: '使用指南', link: '/guides/usage' },
          { text: '架构概览', link: '/guides/architecture' },
        ]},
        { text: '开发文档', items: [
          { text: '贡献指南', link: '/dev/guides/contributing' },
          { text: '技术方案', link: '/dev/specs/opencode-cabbage-docs-and-pages' },
          { text: 'Out of Scope', link: '/dev/out-of-scope' },
        ]},
        { text: 'ADR', items: [
          { text: 'ADR 0001', link: '/adr/0001-replace-openspec-with-full-flow' },
          { text: 'ADR 0002', link: '/adr/2026-07-10-jekyll-github-pages-docs' },
          { text: 'ADR 0003', link: '/adr/2026-07-10-jekyll-to-vitepress' },
        ]},
        { text: 'PRD', items: [
          { text: 'Docs & Pages', link: '/prd/opencode-cabbage-docs-and-pages' },
          { text: 'VitePress 迁移', link: '/prd/vitepress-docs-migration' },
        ]},
      ],
    },
  ],
}
```

### 4.4 自动侧边栏

按目录自动生成侧边栏，使用 `getSidebar()` 工具函数：

```ts
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { DefaultTheme } from 'vitepress'

function getSidebar(): DefaultTheme.Sidebar {
  const docsDir = join(import.meta.dirname, '..')
  const sidebar: DefaultTheme.Sidebar = {}

  function walk(dir: string, base: string) {
    const entries = readdirSync(dir).sort()
    for (const entry of entries) {
      if (entry.startsWith('.') || entry === 'index.md') continue
      const fullPath = join(dir, entry)
      const relativePath = relative(docsDir, fullPath)

      if (statSync(fullPath).isDirectory()) {
        const items = walk(fullPath, base)
        if (items.length > 0) {
          sidebar[`/${relativePath}/`] = items
        }
      } else if (entry.endsWith('.md')) {
        // 返回 { text, link } 对象，后续由调用方组装
        // 此处简化：直接返回路径列表
      }
    }
  }

  // 为每个目录生成侧边栏
  ;['guides', 'dev', 'adr', 'prd'].forEach(dir => {
    const fullDir = join(docsDir, dir)
    const items: DefaultTheme.SidebarItem[] = []
    const entries = readdirSync(fullDir).sort()
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const fullPath = join(fullDir, entry)
      if (entry.endsWith('.md')) {
        const name = entry.replace('.md', '')
        items.push({
          text: name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          link: `/${dir}/${name}`,
        })
      } else if (statSync(fullPath).isDirectory()) {
        const subEntries = readdirSync(fullPath).sort()
        const subItems: DefaultTheme.SidebarItem[] = subEntries
          .filter(e => e.endsWith('.md'))
          .map(e => ({
            text: e.replace('.md', '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            link: `/${dir}/${entry}/${e.replace('.md', '')}`,
          }))
        if (subItems.length > 0) {
          items.push({
            text: entry.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            collapsed: false,
            items: subItems,
          })
        }
      }
    }
    if (items.length > 0) {
      sidebar[`/${dir}/`] = [{ text: dir.charAt(0).toUpperCase() + dir.slice(1), items }]
    }
  })

  return sidebar
}
```

### 4.5 搜索配置

VitePress 内置 minisearch，无需额外配置即可启用。在 `themeConfig` 中配置：

```ts
themeConfig: {
  search: {
    provider: 'local',
    options: {
      translations: {
        button: {
          buttonText: '搜索',
          buttonAriaLabel: '搜索文档',
        },
        modal: {
          displayDetails: '显示详情',
          noResultsText: '未找到相关结果',
          resetButtonTitle: '清除搜索',
          footer: {
            selectText: '选择',
            navigateText: '切换',
            closeText: '关闭',
          },
        },
      },
    },
  },
}
```

### 4.6 完整配置

```ts
// docs/.vitepress/config.ts
import { defineConfig } from 'vitepress'
import { readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { DefaultTheme } from 'vitepress'

function getSidebar(): DefaultTheme.Sidebar {
  const docsDir = join(import.meta.dirname, '..')
  const sidebar: DefaultTheme.Sidebar = {}

  const dirLabels: Record<string, string> = {
    guides: '使用指南',
    adr: '架构决策记录',
    dev: '开发文档',
    prd: '产品需求文档',
  }

  for (const dir of ['guides', 'adr', 'dev', 'prd']) {
    const fullDir = join(docsDir, dir)
    const items: DefaultTheme.SidebarItem[] = []
    const entries = readdirSync(fullDir).sort()
    for (const entry of entries) {
      if (entry.startsWith('.')) continue
      const fullPath = join(fullDir, entry)
      if (entry.endsWith('.md')) {
        const name = entry.replace('.md', '')
        items.push({
          text: name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          link: `/${dir}/${name}`,
        })
      } else if (statSync(fullPath).isDirectory()) {
        const subEntries = readdirSync(fullPath).sort().filter(e => e.endsWith('.md'))
        if (subEntries.length > 0) {
          items.push({
            text: entry.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            collapsed: false,
            items: subEntries.map(e => ({
              text: e.replace('.md', '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
              link: `/${dir}/${entry}/${e.replace('.md', '')}`,
            })),
          })
        }
      }
    }
    if (items.length > 0) {
      sidebar[`/${dir}/`] = [{ text: dirLabels[dir] || dir, items }]
    }
  }

  return sidebar
}

export default defineConfig({
  title: 'opencode-cabbage',
  description: '全流程开发 OpenCode 插件 — 需求→设计→任务→编码→测试→审查→自动合并',
  srcDir: '.',
  outDir: '../.vitepress-dist',
  lastUpdated: true,
  cleanUrls: true,

  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '快速开始', link: '/guides/quickstart' },
      {
        text: '使用指南',
        items: [
          { text: '快速开始', link: '/guides/quickstart' },
          { text: '配置指南', link: '/guides/configuration' },
          { text: '使用指南', link: '/guides/usage' },
          { text: '架构概览', link: '/guides/architecture' },
        ],
      },
      {
        text: '开发',
        items: [
          { text: '贡献指南', link: '/dev/guides/contributing' },
          { text: '技术方案', link: '/dev/specs/opencode-cabbage-docs-and-pages' },
          { text: 'VitePress 迁移', link: '/dev/specs/vitepress-docs-migration' },
          { text: 'Out of Scope', link: '/dev/out-of-scope' },
          { text: '任务拆解', link: '/dev/tasks/pages-deployment-workflow' },
        ],
      },
      {
        text: 'ADR',
        items: [
          { text: '0001 - 替换 OpenSpec', link: '/adr/0001-replace-openspec-with-full-flow' },
          { text: '0002 - Jekyll 文档站', link: '/adr/2026-07-10-jekyll-github-pages-docs' },
          { text: '0003 - 迁移 VitePress', link: '/adr/2026-07-10-jekyll-to-vitepress' },
        ],
      },
      {
        text: 'PRD',
        items: [
          { text: 'Docs & Pages', link: '/prd/opencode-cabbage-docs-and-pages' },
          { text: 'VitePress 迁移', link: '/prd/vitepress-docs-migration' },
        ],
      },
    ],

    sidebar: getSidebar(),

    search: {
      provider: 'local',
      options: {
        translations: {
          button: {
            buttonText: '搜索',
            buttonAriaLabel: '搜索文档',
          },
          modal: {
            displayDetails: '显示详情',
            noResultsText: '未找到相关结果',
            resetButtonTitle: '清除搜索',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭',
            },
          },
        },
      },
    },

    socialLinks: [
      { icon: 'github', link: 'https://github.com/devcxl/opencode-cabbage' },
    ],

    editLink: {
      pattern: 'https://github.com/devcxl/opencode-cabbage/edit/main/docs/:path',
    },

    lastUpdated: {
      text: '最后更新',
    },

    docFooter: {
      prev: '上一页',
      next: '下一页',
    },
  },
})
```

## 5. 首页改造

文件：`docs/index.md`

将现有 Jekyll 首页内容替换为 VitePress 首页布局：

```markdown
---
layout: home

hero:
  name: opencode-cabbage
  text: 全流程开发 OpenCode 插件
  tagline: 需求→设计→任务→编码→测试→审查→自动合并
  actions:
    - theme: brand
      text: 快速开始
      link: /guides/quickstart
    - theme: alt
      text: 配置指南
      link: /guides/configuration

features:
  - title: 全流程覆盖
    details: 从需求到发布，9 个 slash command 覆盖完整开发生命周期
    icon: 🔄
  - title: 自动编排
    details: 需求确认后输入 @dev-lifecycle，全自动完成剩余流程
    icon: 🤖
  - title: 并行 Subagent
    details: 编码阶段自动拆分任务并行执行，大幅提升开发效率
    icon: ⚡
  - title: 双轴审查
    details: 规范审查 + 规格审查，确保代码质量与需求一致性
    icon: ✅
---

<p align="center">
  <a href="https://www.npmjs.com/package/@devcxl/opencode-cabbage">
    <img src="https://img.shields.io/npm/v/@devcxl/opencode-cabbage" alt="npm version">
  </a>
  <a href="https://github.com/devcxl/opencode-cabbage/blob/main/LICENSE">
    <img src="https://img.shields.io/npm/l/@devcxl/opencode-cabbage" alt="license">
  </a>
</p>

## 命令一览

| 命令 | 阶段 | 产出 |
|------|------|------|
| `/setup` | 初始化 | docs/ 目录结构、环境验证 |
| `/requirements` | 需求 | PRD → GitHub Issue |
| `/design` | 设计 | 技术方案 + ADR |
| `/tasks` | 任务拆解 | DAG 任务 + Sub Issues |
| `/code` | 编码 | 分支 + 代码 + PR |
| `/test` | 测试 | CI + 监控 + 汇报 |
| `/review` | 审查 | 双轴审查 + 自动合并 |
| `/release` | ⚠️ 手动 | 版本 → Changelog → Release → npm publish |
| `/handoff` | 交接 | 打包上下文，跨会话传递 |

## 快速安装

```json
{
  "plugin": ["@devcxl/opencode-cabbage"]
}
```

插件启动后自动注入 9 个 slash command、9 个 flow skill、5 个 agent。
```

## 6. CI/CD 更新

当前不存在 `.github/workflows/pages.yml`，需新建。

文件：`.github/workflows/pages.yml`

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
          node-version: 24
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

关键点：
- `actions/upload-pages-artifact@v3` 上传 `.vitepress-dist/` 目录作为 Pages 部署源
- 使用 `actions/deploy-pages@v4` 替代旧版 `peaceiris/actions-gh-pages`，这是 GitHub 官方推荐的 Pages 部署方式
- `permissions` 配置 `pages: write` 和 `id-token: write` 是 `deploy-pages` action 的必需权限
- `concurrency` 防止并发部署

## 7. Jekyll 残留清理

需删除/修改的文件：

| 文件 | 操作 | 原因 |
|------|------|------|
| `docs/_config.yml` | 删除 | Jekyll 配置文件，不再需要 |
| `.nojekyll` | 无需创建 | VitePress 构建输出已包含 `.nojekyll`，或由 GitHub Pages Action 处理 |

注意：GitHub Pages 在部署时，如果检测到 `_config.yml` 或 Jekyll 标记文件，会默认使用 Jekyll 构建。旧版 `peaceiris/actions-gh-pages` 需要手动添加 `.nojekyll`；但使用 `actions/upload-pages-artifact` + `actions/deploy-pages` 时，部署的是静态 HTML 产物，不会触发 Jekyll 构建，因此无需 `.nojekyll`。

## 8. 版本号读取方案

首页使用 npm badge 动态展示版本号，无需从 `package.json` 读取。VitePress 配置中如需读取版本号用于其他用途（如 `title` 后缀），可以在 `config.ts` 中直接 import：

```ts
import pkg from '../../package.json'
// pkg.version → "0.1.0"
```

## 9. 实施计划

| 步骤 | 子任务 | 验收标准 | 预估影响文件 |
|------|--------|----------|-------------|
| 1 | 安装 vitepress | `npm ls vitepress` 显示版本 | `package.json` |
| 2 | 添加 scripts | `npm run docs:dev` 可启动 | `package.json` |
| 3 | 创建 VitePress 配置 | `docs/.vitepress/config.ts` 语法正确 | 新建 1 文件 |
| 4 | 改造首页 | 首页显示 hero + features + 命令一览 | 修改 `docs/index.md` |
| 5 | 创建 CI workflow | `.github/workflows/pages.yml` 存在 | 新建 1 文件 |
| 6 | 删除 Jekyll 配置 | `docs/_config.yml` 已删除 | 删除 1 文件 |
| 7 | 本地验证 | `npm run docs:dev` 可预览全部页面 | — |
| 8 | 构建验证 | `npm run docs:build` 成功，无 dead link | — |

## 10. 风险与对策

| 风险 | 影响 | 对策 |
|------|------|------|
| VitePress 将 `.md` 内部链接的处理方式与 Jekyll 不同 | 部分链接可能 404 | 构建后使用 `vitepress build` 的 `ignoreDeadLinks` 检查，或手动遍历所有页面 |
| `actions/deploy-pages` 需要仓库 Settings 中开启 Pages 源为 "GitHub Actions" | 部署失败 | 在 PR 中注明需要手动配置 |
| 子目录 `dev/tasks/` 等有 7 个文件，侧边栏可能过长 | 导航体验差 | 使用 `collapsed: true` 默认折叠 tasks 子目录 |
| ESM 项目 (`"type": "module"`) 的 config.ts 文件扩展名冲突 | VitePress 配置加载失败 | VitePress 支持 `.ts` 配置文件，与 `"type": "module"` 兼容 |

## 11. 技术选型与约束

- **VitePress 版本**: `^1.x`（最新稳定版）
- **Node.js**: >= 18（与项目现有约束一致）
- **构建输出**: `.vitepress-dist/`（Git 忽略）
- **部署方式**: GitHub Actions + GitHub Pages
- **主题**: 默认主题（不做自定义）
- **搜索**: 本地 minisearch（无需外部服务）

---
title: "C. 内容迁移"
status: "pending"
parent: "https://github.com/devcxl/opencode-cabbage/issues/17"
---

## 描述

验证全部 21 个 `.md` 文件在 VitePress 下可正常访问，修复内部链接格式（`.md` 后缀 → clean URL），确保 frontmatter 兼容。

## 验收标准

- [ ] 全部 21 个 `.md` 文件在 `npm run docs:dev` 下可正常访问
- [ ] 所有内部链接使用 clean URL 格式（不带 `.md` 后缀）
- [ ] 所有文件的 frontmatter 与 VitePress 兼容（无报错）
- [ ] 无 dead link（404 页面）

## 文件清单

| 目录 | 文件 | 数量 |
|------|------|------|
| 根 | `docs/index.md` | 1 |
| guides/ | `quickstart.md`, `configuration.md`, `usage.md`, `architecture.md` | 4 |
| adr/ | `0001-replace-openspec-with-full-flow.md`, `2026-07-10-jekyll-github-pages-docs.md`, `2026-07-10-jekyll-to-vitepress.md` | 3 |
| dev/ | `out-of-scope.md` | 1 |
| dev/guides/ | `contributing.md` | 1 |
| dev/specs/ | `opencode-cabbage-docs-and-pages.md`, `vitepress-docs-migration.md` | 2 |
| dev/tasks/ | `pages-deployment-workflow.md`, `architecture-doc.md`, `site-index-and-config.md`, `quickstart-guide.md`, `usage-guide.md`, `readme-update.md`, `configuration-guide.md` | 7 |
| prd/ | `opencode-cabbage-docs-and-pages.md`, `vitepress-docs-migration.md` | 2 |

**合计：21 个文件**

## 实现要点

### 链接格式修正

全局搜索 `.md)` 后缀的内部链接，替换为 clean URL 格式：

- `[快速开始](guides/quickstart.md)` → `[快速开始](/guides/quickstart)`
- `[贡献指南](dev/guides/contributing.md)` → `[贡献指南](/dev/guides/contributing)`

搜索范围：`docs/` 下所有 `.md` 文件。

### 检查命令

```bash
# 搜索所有包含 .md 后缀的内部链接
rg '\([^)]*\.md\)' docs/ --glob '*.md'
```

### 需要注意的文件

- `docs/guides/quickstart.md` — 可能包含对 `configuration.md` 等文件的引用
- `docs/guides/usage.md` — 可能包含对其他 guide 文件的引用
- `docs/guides/architecture.md` — 可能包含对实现文件的引用
- `docs/index.md` (任务 B 处理) — 首页链接已处理

### 不需要修改的内容

- **文档内容**本身不做任何修改（Out of Scope）
- **frontmatter** 如已存在且格式正确，不做修改
- **外部链接**（`https://` 开头）不做修改
- **图片链接**（如 shields.io badge）不做修改
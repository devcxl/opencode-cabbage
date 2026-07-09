---
title: "A. 任务目录重组"
status: "pending"
parent: "https://github.com/devcxl/opencode-cabbage/issues/25"
---

## 描述

将 `docs/dev/tasks/` 下平铺的 14 个文件按 feature 迁移到 `YYYY-MM-DD-NNN-slug/` 子目录中。

## 验收标准

- [ ] `docs/dev/tasks/2026-07-09-001-docs-and-pages/` 目录已创建，包含 7 个 .md 文件
- [ ] `docs/dev/tasks/2026-07-10-001-vitepress-migration/` 目录已创建，包含 7 个 .md 文件（含 DAG.md）
- [ ] `docs/dev/tasks/` 根目录下无残留的平铺 .md 文件
- [ ] `git mv` 操作，保留 git 历史

## 实现要点

### 文件归属

**2026-07-09-001-docs-and-pages/**
- architecture-doc.md, configuration-guide.md, quickstart-guide.md, readme-update.md, site-index-and-config.md, usage-guide.md, pages-deployment-workflow.md

**2026-07-10-001-vitepress-migration/**
- DAG.md, vitepress-init.md, homepage-config.md, content-migration.md, sidebar-nav-config.md, cicd-update.md, jekyll-cleanup.md

### 执行

```bash
mkdir -p docs/dev/tasks/2026-07-09-001-docs-and-pages
mkdir -p docs/dev/tasks/2026-07-10-001-vitepress-migration
git mv docs/dev/tasks/architecture-doc.md docs/dev/tasks/2026-07-09-001-docs-and-pages/
# ... 全部移动
```

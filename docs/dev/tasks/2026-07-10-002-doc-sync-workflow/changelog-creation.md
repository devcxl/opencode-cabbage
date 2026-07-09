---
title: "C. 创建 changelog 目录"
status: "pending"
parent: "https://github.com/devcxl/opencode-cabbage/issues/25"
---

## 描述

创建 `docs/dev/changelog/` 目录，为现有的两个 feature 创建空 changelog 文件。

## 验收标准

- [ ] `docs/dev/changelog/` 目录已创建
- [ ] `docs/dev/changelog/2026-07-09-001-docs-and-pages.md` 存在，含标题和 tasks 链接
- [ ] `docs/dev/changelog/2026-07-10-001-vitepress-migration.md` 存在，含标题和 tasks 链接

## 实现要点

### 文件模板

```markdown
# Changelog: <feature-title>

> 对应 tasks: `docs/dev/tasks/<YYYY-MM-DD-NNN-slug>/`

## 实现偏差

（PR 合并前由 reviewer 追加）

## 未实现项

（如适用）

## 额外实现项

（如适用）
```

### 执行

```bash
mkdir -p docs/dev/changelog
```

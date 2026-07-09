---
title: "F. Jekyll 清理"
status: "pending"
parent: "https://github.com/devcxl/opencode-cabbage/issues/17"
---

## 描述

删除 Jekyll 配置文件 `docs/_config.yml`，确认无 Jekyll 残留，确保 GitHub Pages 部署后使用 VitePress 构建产物。

## 验收标准

- [ ] `docs/_config.yml` 已删除
- [ ] 无其他 Jekyll 相关文件残留（如 `Gemfile`、`Gemfile.lock`、`_layouts/`、`_includes/` 等）
- [ ] GitHub Pages 部署成功后，访问站点显示 VitePress 页面（而非 Jekyll 页面）
- [ ] `.vitepress-dist` 目录已加入 `.gitignore`（任务 A 处理）

## 实现要点

### 删除文件

```bash
rm docs/_config.yml
```

### 检查 Jekyll 残留

```bash
# 检查是否存在 Jekyll 典型文件
ls -la docs/_layouts docs/_includes docs/_posts docs/_data 2>/dev/null
ls -la Gemfile Gemfile.lock 2>/dev/null
```

### 注意事项

- 使用 `actions/upload-pages-artifact` + `actions/deploy-pages` 部署的是静态 HTML 产物，不会触发 Jekyll 构建，因此无需 `.nojekyll` 文件
- 如果仓库 Settings 中 Pages Source 仍为 "Deploy from a branch"，需改为 "GitHub Actions"
- 删除 `_config.yml` 后，GitHub Pages 不会自动触发 Jekyll 构建

### 部署验证

1. 合并 PR 到 main 分支
2. 等待 GitHub Actions 完成部署
3. 访问 `https://devcxl.github.io/opencode-cabbage/` 确认显示 VitePress 页面
4. 检查首页是否显示 hero + features + npm badge
5. 检查侧边栏和导航栏是否正常工作
6. 检查全文搜索是否可用

### 风险

| 风险 | 对策 |
|------|------|
| 部署后短暂 404 | 等待 GitHub Pages 缓存刷新（通常 1-2 分钟） |
| 旧 Jekyll 页面缓存 | 浏览器强制刷新（Ctrl+Shift+R） |
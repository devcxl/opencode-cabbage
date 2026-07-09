---
title: "VitePress 迁移 — DAG 任务依赖图"
status: "pending"
parent: "https://github.com/devcxl/opencode-cabbage/issues/17"
---

## DAG 拓扑

```
A (VitePress 初始化)
├── B (首页配置)
├── C (内容迁移)
├── D (侧边栏与导航栏)
└── E (CI/CD 更新)
     └── F (Jekyll 清理)
```

## 任务列表

| 批次 | 任务 | 依赖 | 可并行 |
|------|------|------|--------|
| Batch 1 | A. VitePress 初始化 | 无 | — |
| Batch 2 | B. 首页配置 | A | ✓ |
| Batch 2 | C. 内容迁移 | A | ✓ |
| Batch 2 | D. 侧边栏与导航栏 | A | ✓ |
| Batch 2 | E. CI/CD 更新 | A | ✓ |
| Batch 3 | F. Jekyll 清理 | E | — |

## 执行顺序

### Batch 1 — 基础设施

**A. VitePress 初始化**
- 安装 vitepress 依赖
- 添加 npm scripts
- 创建 `docs/.vitepress/config.ts`（完整配置）
- 更新 `.gitignore`

→ 验证：`npm run docs:dev` 可启动

### Batch 2 — 并行执行（4 个任务无相互依赖）

**B. 首页配置**
- 替换 `docs/index.md` 为 VitePress 首页布局
- 添加 hero、features、npm badge、命令一览表

**C. 内容迁移**
- 验证全部 21 个 `.md` 文件可访问
- 修正内部链接（`.md` 后缀 → clean URL）

**D. 侧边栏与导航栏**
- 验证 `getSidebar()` 自动生成正确
- 验证导航栏下拉菜单链接全部可达
- 调整 `dev/tasks/` 子目录默认折叠

**E. CI/CD 更新**
- 替换 `.github/workflows/pages.yml` 为 VitePress 构建流程
- 使用 `actions/upload-pages-artifact@v3` + `actions/deploy-pages@v4`

→ 验证：`npm run docs:build` 成功 + pages.yml 语法正确

### Batch 3 — 收尾

**F. Jekyll 清理**
- 删除 `docs/_config.yml`
- 确认无 Jekyll 残留
- 验证 GitHub Pages 部署成功

→ 验证：线上站点显示 VitePress 页面

## 影响文件

| 文件 | 操作 | 任务 |
|------|------|------|
| `package.json` | 修改（deps + scripts） | A |
| `docs/.vitepress/config.ts` | 新建 | A |
| `.gitignore` | 修改（追加） | A |
| `docs/index.md` | 修改 | B |
| 各 `.md` 文件内部链接 | 修改（如有需要） | C |
| `.github/workflows/pages.yml` | 修改 | E |
| `docs/_config.yml` | 删除 | F |

## 风险

| 风险 | 影响 | 对策 | 涉及任务 |
|------|------|------|----------|
| VitePress 内部链接处理与 Jekyll 不同 | 部分链接 404 | 构建后检查 dead link，任务 C 中修正 | C |
| `actions/deploy-pages` 需要 Pages Source 设为 "GitHub Actions" | 部署失败 | PR 中注明需手动配置仓库 Settings | E |
| `dev/tasks/` 7 个文件侧边栏过长 | 导航体验差 | 默认折叠（`collapsed: true`） | D |
| ESM 项目 `"type": "module"` 与配置文件兼容性 | 配置加载失败 | VitePress `.ts` 配置文件与 ESM 兼容 | A |
---
title: "A. VitePress 初始化"
status: "pending"
parent: "https://github.com/devcxl/opencode-cabbage/issues/17"
---

## 描述

安装 VitePress 依赖，创建完整配置文件，添加 npm scripts，更新 `.gitignore`。

## 验收标准

- [ ] `npm ls vitepress` 显示 `vitepress@^1` 已安装
- [ ] `package.json` 包含 `docs:dev`、`docs:build`、`docs:preview` 三个 scripts
- [ ] `docs/.vitepress/config.ts` 存在且语法正确
- [ ] `.gitignore` 包含 `.vitepress-dist`
- [ ] `npm run docs:dev` 可启动 VitePress 开发服务器（首页可能空白，任务 B 完成后才显示内容）

## 实现要点

### 安装依赖

```bash
npm install -D vitepress
```

### 添加 scripts

在 `package.json` 的 `scripts` 中新增：

```json
"docs:dev": "vitepress dev docs",
"docs:build": "vitepress build docs",
"docs:preview": "vitepress preview docs"
```

### 创建配置文件

`docs/.vitepress/config.ts` — 完整配置包含：

- **基本配置**：`title`、`description`、`srcDir`、`outDir`、`lastUpdated`、`cleanUrls`
- **导航栏**：首页、快速开始、使用指南下拉、开发下拉、ADR 下拉、PRD 下拉
- **自动侧边栏**：`getSidebar()` 函数遍历 `guides/`、`dev/`、`adr/`、`prd/` 目录生成侧边栏
- **搜索**：本地 minisearch，中文翻译
- **社交链接**：GitHub
- **编辑链接**：指向 GitHub 仓库
- **页脚配置**：中文上下页文案

详见技术方案 4.6 节完整配置代码。

### 更新 .gitignore

追加一行 `.vitepress-dist`。

### 特殊处理

- `dev/tasks/` 子目录有 7 个文件，侧边栏中设为 `collapsed: true` 默认折叠
- 项目 `"type": "module"`，VitePress `.ts` 配置文件与之兼容
- `outDir` 设为 `../.vitepress-dist`，构建产物在项目根目录
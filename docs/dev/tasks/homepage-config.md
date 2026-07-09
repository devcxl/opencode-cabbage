---
title: "B. 首页配置"
status: "pending"
parent: "https://github.com/devcxl/opencode-cabbage/issues/17"
---

## 描述

将 `docs/index.md` 从 Jekyll 格式改造为 VitePress 首页布局（hero + features），展示 npm 版本号 badge 和命令一览表。

## 验收标准

- [ ] 首页显示 hero 区域：项目名称 + 描述 + 两个 CTA 按钮（快速开始、配置指南）
- [ ] 首页显示 features 区域：4 个功能卡片（全流程覆盖、自动编排、并行 Subagent、双轴审查）
- [ ] 首页显示 npm 版本号 badge（通过 shields.io）
- [ ] 首页显示命令一览表（9 个 slash command）
- [ ] 首页显示快速安装代码块
- [ ] 首页无 Jekyll 残留内容

## 实现要点

### 首页 frontmatter

```yaml
---
layout: home
---
```

### hero 配置

- `name`: `opencode-cabbage`
- `text`: `全流程开发 OpenCode 插件`
- `tagline`: `需求→设计→任务→编码→测试→审查→自动合并`
- `actions`: 两个按钮分别指向 `/guides/quickstart` 和 `/guides/configuration`

### features 配置

4 个功能卡片，每个包含 `title`、`details`、`icon`。

### 版本号

使用 npm badge 动态展示，无需手动维护：

```html
<p align="center">
  <a href="https://www.npmjs.com/package/@devcxl/opencode-cabbage">
    <img src="https://img.shields.io/npm/v/@devcxl/opencode-cabbage" alt="npm version">
  </a>
  <a href="https://github.com/devcxl/opencode-cabbage/blob/main/LICENSE">
    <img src="https://img.shields.io/npm/l/@devcxl/opencode-cabbage" alt="license">
  </a>
</p>
```

### 命令一览表

保留现有 Markdown 表格，格式不做修改。

### 快速安装

保留现有代码块，不做修改。

### 注意事项

- VitePress 首页模式下，hero 和 features 通过 frontmatter 配置，其下方的 Markdown 内容（命令一览、安装代码块）会正常渲染在 features 下方
- 旧 Jekyll 首页的 `[快速链接](guides/quickstart.md)` 格式需改为 `(/guides/quickstart)` 不带 `.md` 后缀（VitePress clean URLs）
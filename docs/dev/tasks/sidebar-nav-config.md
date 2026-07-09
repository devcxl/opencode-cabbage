---
title: "D. 侧边栏与导航栏配置"
status: "pending"
parent: "https://github.com/devcxl/opencode-cabbage/issues/17"
---

## 描述

验证 VitePress 配置中的自动侧边栏和导航栏在所有目录下正确工作，必要时调整 `getSidebar()` 函数和导航栏配置。

## 验收标准

- [ ] `guides/` 下 4 个文件在侧边栏中正确显示，标题为中文
- [ ] `adr/` 下 3 个文件在侧边栏中正确显示，文件名转标题格式正确
- [ ] `dev/` 下子目录（`guides/`、`specs/`、`tasks/`）在侧边栏中正确嵌套显示
- [ ] `dev/tasks/` 子目录（7 个文件）默认折叠（`collapsed: true`）
- [ ] `prd/` 下 2 个文件在侧边栏中正确显示
- [ ] 导航栏下拉菜单链接全部可达
- [ ] 导航栏"首页"和"快速开始"链接正确

## 实现要点

### 侧边栏配置

使用 `getSidebar()` 函数自动遍历目录生成侧边栏，在 `config.ts` 中已实现（任务 A）。本任务重点验证：

1. **目录标签映射**：
   ```ts
   const dirLabels: Record<string, string> = {
     guides: '使用指南',
     adr: '架构决策记录',
     dev: '开发文档',
     prd: '产品需求文档',
   }
   ```

2. **文件名转标题**：`pages-deployment-workflow` → `Pages Deployment Workflow`

3. **tasks 子目录默认折叠**：`collapsed: true`

### 导航栏配置

已实现的导航栏结构：

```
首页 | 快速开始 | 使用指南 ▼ | 开发 ▼ | ADR ▼ | PRD ▼
```

### 验证方法

```bash
# 启动开发服务器，逐一检查每个目录的侧边栏
npm run docs:dev
```

需要人工验证的页面：
- `/guides/quickstart` — 侧边栏显示 4 个 guide 文件
- `/adr/0001-replace-openspec-with-full-flow` — 侧边栏显示 3 个 ADR 文件
- `/dev/guides/contributing` — 侧边栏嵌套显示 dev 子目录
- `/dev/tasks/pages-deployment-workflow` — tasks 子目录默认折叠
- `/prd/opencode-cabbage-docs-and-pages` — 侧边栏显示 2 个 PRD 文件

### 可能需要的调整

- 如果 `getSidebar()` 函数中 `readdirSync` 排序不符合预期，调整排序逻辑
- 如果文件名转标题格式不美观，调整 `replace` 正则
- 如果某些子目录不需要显示在侧边栏中，添加排除逻辑
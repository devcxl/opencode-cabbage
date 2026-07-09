# 文档同步流程与任务目录重构

## 概述

当前项目存在两个问题：

1. **文档同步缺失**：代码变更后，用户文档（`docs/guides/`）没有自动化的同步机制，导致文档与最新功能脱节
2. **任务目录混乱**：所有 feature 的 task 文件平铺在 `docs/dev/tasks/` 下，无法区分属于哪个需求，也看不出依赖关系和创建顺序

## 用户故事

- 作为**开发者**，我希望在实现功能后有一个明确的文档同步检查流程，确保用户文档与代码一致
- 作为**项目维护者**，我希望任务文件按 feature 组织，能按时间排序且清楚归属
- 作为**代码审查者**，我希望知道实际实现与设计之间的偏差，并记录到 changelog

## In Scope

### 1. 任务目录重构

```
docs/dev/tasks/
├── 2026-07-09-001-docs-and-pages/
│   ├── DAG.md
│   ├── architecture-doc.md
│   ├── configuration-guide.md
│   ├── quickstart-guide.md
│   ├── readme-update.md
│   ├── site-index-and-config.md
│   └── usage-guide.md
├── 2026-07-10-001-vitepress-migration/
│   ├── DAG.md
│   ├── vitepress-init.md
│   ├── homepage-config.md
│   ├── content-migration.md
│   ├── sidebar-nav-config.md
│   ├── cicd-update.md
│   └── jekyll-cleanup.md
```

- 目录命名格式：`YYYY-MM-DD-NNN-slug/`
  - `NNN` 从 `001` 开始，每天独立递增
  - `slug` 简短描述 feature
- `getSidebar()` 正则剥离日期前缀，显示纯名称
- 现有平铺文件迁移到对应 feature 目录

### 2. 新增 changelog 目录

```
docs/dev/changelog/
└── 2026-07-10-001-vitepress-migration.md
```

- 记录实际实现与设计的偏差
- reviewer 在 PR 合并前追加
- 格式：`<feature-slug>.md`

### 3. 文档同步流程（doc sync）

作为 flow-code 技能中的固定步骤：

```
分支 → 编码 → 单测 → 文档同步检查 → PR
```

文档同步检查步骤：

1. flow-code 技能自动输出文档同步 checklist：

```
## 文档同步检查清单
□ guides/quickstart.md — 安装方式或前置条件有变化吗？
□ guides/configuration.md — 新增/修改了配置项吗？
□ guides/usage.md — 命令或行为有变化吗？
□ guides/architecture.md — 架构或流程有变化吗？
□ docs/dev/guides/contributing.md — 开发流程有变化吗？
```

2. 开发者逐项评估，无需修改的跳过
3. 需要修改的文档随代码一起提交到同一个 PR
4. PR body 中列出已同步的文档

### 4. 更新 `getSidebar()` 配置

- 适配新的 `YYYY-MM-DD-NNN-slug/` 目录结构
- tasks 目录名在侧边栏中显示纯 slug

### 5. 更新 flow-code skill 文档

- 加入文档同步步骤
- 加入 checklist 模板

### 6. 更新 flow-review skill 文档

- 加入 changelog 追加职责
- reviewer 合并前检查文档同步是否完成

## Out of Scope

- 自动检测代码变更影响哪些文档（AI 辅助但最终人工判断）
- specs/ 技术方案自动更新 — 设计阶段产物，代码阶段不改
- adr/ 架构决策记录自动更新 — 设计偏离时单独更新
- task 文件修改 — 保留原始设计意图，变更记入 changelog

## 验收标准

- [x] 任务文件已按 `YYYY-MM-DD-NNN-slug/` 目录重组
- [x] `getSidebar()` 适配新目录结构，tasks 侧边栏按日期排序
- [x] flow-code skill 包含文档同步检查步骤
- [x] flow-review skill 包含 changelog 追加和文档同步确认职责
- [x] changelog 目录已创建，reviewer 合并前追加 delta 记录
- [x] 现有 task 文件全部迁移无遗漏

## 优先级

| 项 | 优先级 |
|----|--------|
| 任务目录重构 | P0 |
| flow-code + doc sync 步骤 | P0 |
| getSidebar() 适配 | P0 |
| changelog 目录 | P1 |
| flow-review 更新 | P1 |

# 文档同步流程与任务目录重构 — 技术方案

## 概述

解决两个问题：
1. 代码变更后 `docs/guides/` 用户文档缺少同步机制
2. `docs/dev/tasks/` 下所有 task 文件平铺，无法区分 feature 归属

## 1. 任务目录重构

### 1.1 目标结构

```
docs/dev/tasks/
├── 2026-07-09-001-docs-and-pages/
│   ├── DAG.md
│   ├── architecture-doc.md
│   ├── configuration-guide.md
│   ├── quickstart-guide.md
│   ├── readme-update.md
│   ├── site-index-and-config.md
│   ├── usage-guide.md
│   └── pages-deployment-workflow.md
└── 2026-07-10-001-vitepress-migration/
    ├── DAG.md
    ├── vitepress-init.md
    ├── homepage-config.md
    ├── content-migration.md
    ├── sidebar-nav-config.md
    ├── cicd-update.md
    └── jekyll-cleanup.md
```

### 1.2 目录命名格式

`YYYY-MM-DD-NNN-slug/`

- `YYYY-MM-DD`：创建日期，确保按时间排序
- `NNN`：当天编号，从 `001` 开始递增，同一天有多个 feature 时区分
- `slug`：简短 feature 描述（kebab-case）

### 1.3 文件归属映射

**2026-07-09-001-docs-and-pages/（7 个文件）**

| 现有文件 | 目标路径 |
|----------|----------|
| `docs/dev/tasks/architecture-doc.md` | `docs/dev/tasks/2026-07-09-001-docs-and-pages/architecture-doc.md` |
| `docs/dev/tasks/configuration-guide.md` | `docs/dev/tasks/2026-07-09-001-docs-and-pages/configuration-guide.md` |
| `docs/dev/tasks/quickstart-guide.md` | `docs/dev/tasks/2026-07-09-001-docs-and-pages/quickstart-guide.md` |
| `docs/dev/tasks/readme-update.md` | `docs/dev/tasks/2026-07-09-001-docs-and-pages/readme-update.md` |
| `docs/dev/tasks/site-index-and-config.md` | `docs/dev/tasks/2026-07-09-001-docs-and-pages/site-index-and-config.md` |
| `docs/dev/tasks/usage-guide.md` | `docs/dev/tasks/2026-07-09-001-docs-and-pages/usage-guide.md` |
| `docs/dev/tasks/pages-deployment-workflow.md` | `docs/dev/tasks/2026-07-09-001-docs-and-pages/pages-deployment-workflow.md` |

> 注：该 feature 无 DAG.md，因为 `docs-and-pages` 在引入 DAG 模式之前完成。

**2026-07-10-001-vitepress-migration/（7 个文件）**

| 现有文件 | 目标路径 |
|----------|----------|
| `docs/dev/tasks/DAG.md` | `docs/dev/tasks/2026-07-10-001-vitepress-migration/DAG.md` |
| `docs/dev/tasks/vitepress-init.md` | `docs/dev/tasks/2026-07-10-001-vitepress-migration/vitepress-init.md` |
| `docs/dev/tasks/homepage-config.md` | `docs/dev/tasks/2026-07-10-001-vitepress-migration/homepage-config.md` |
| `docs/dev/tasks/content-migration.md` | `docs/dev/tasks/2026-07-10-001-vitepress-migration/content-migration.md` |
| `docs/dev/tasks/sidebar-nav-config.md` | `docs/dev/tasks/2026-07-10-001-vitepress-migration/sidebar-nav-config.md` |
| `docs/dev/tasks/cicd-update.md` | `docs/dev/tasks/2026-07-10-001-vitepress-migration/cicd-update.md` |
| `docs/dev/tasks/jekyll-cleanup.md` | `docs/dev/tasks/2026-07-10-001-vitepress-migration/jekyll-cleanup.md` |

### 1.4 getSidebar() 更新方案

`docs/.vitepress/config.ts` 中 `getSidebar()` 需做以下修改：

**变更点**：`dev/tasks/` 目录下的子目录不再是 `.md` 文件，而是 `YYYY-MM-DD-NNN-slug/` 格式的 feature 目录。需要新增一层嵌套处理。

**方案**：对 `dev/tasks/` 做特殊处理——遍历其子目录，为每个 feature 目录生成一个可折叠的侧边栏分组，显示名称时正则剥离日期前缀。

**核心代码**（替换现有 `dev/tasks` 处理逻辑）：

```ts
// 在 getSidebar() 中，处理 dev/tasks/ 的特殊逻辑
if (dir === 'dev' && entry === 'tasks') {
  const featureDirs = readdirSync(fullPath).sort().filter(e => {
    if (e.startsWith('.')) return false
    return statSync(join(fullPath, e)).isDirectory()
  })
  if (featureDirs.length > 0) {
    const taskItems: DefaultTheme.SidebarItem[] = featureDirs.map(fd => {
      const fdPath = join(fullPath, fd)
      const fdFiles = readdirSync(fdPath).sort().filter(e => e.endsWith('.md'))
      // 正则剥离日期前缀：2026-07-09-001- → ''
      const displayName = fd
        .replace(/^\d{4}-\d{2}-\d{2}-\d{3}-/, '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase())
      return {
        text: displayName,
        collapsed: true,
        items: fdFiles.map(f => ({
          text: f.replace('.md', '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
          link: `/${dir}/${entry}/${fd}/${f.replace('.md', '')}`,
        })),
      }
    })
    items.push({
      text: 'Tasks',
      collapsed: false,
      items: taskItems,
    })
  }
  continue // 跳过正常的目录处理（因为 tasks 子目录不包含 .md 文件）
}
```

**替换位置**：`getSidebar()` 函数中，`for (const entry of entries)` 循环内，在 `statSync(fullPath).isDirectory()` 分支中，对 `dir === 'dev' && entry === 'tasks'` 做特殊处理。

**正则说明**：`/^\d{4}-\d{2}-\d{2}-\d{3}-/` 匹配 `2026-07-10-001-` 前缀，剥离后剩余 `vitepress-migration`，再经过 `replace(/-/g, ' ')` 和 `replace(/\b\w/g, c => c.toUpperCase())` 转换为 `Vitepress Migration`。

**排序**：`readdirSync(fullPath).sort()` 保证按字符串排序，即 `YYYY-MM-DD-NNN` 的字典序等于时间序。

### 1.5 导航栏更新

`docs/.vitepress/config.ts` 中移除指向具体 task 文件的导航链接（如 `/dev/tasks/pages-deployment-workflow`），因为 tasks 由侧边栏自动生成，无需在导航栏硬编码。

## 2. Changelog 目录方案

### 2.1 目录结构

```
docs/dev/changelog/
├── 2026-07-10-001-vitepress-migration.md
└── 2026-07-09-001-docs-and-pages.md
```

### 2.2 文件命名

`<YYYY-MM-DD-NNN-feature-slug>.md`，与 `docs/dev/tasks/` 下的 feature 目录名一一对应。

### 2.3 内容格式模板

```markdown
# Changelog: <feature-title>

> 对应 tasks: `docs/dev/tasks/<YYYY-MM-DD-NNN-slug>/`

## 实现偏差

| 设计项 | 预期 | 实际 | 原因 |
|--------|------|------|------|
| ... | ... | ... | ... |

## 未实现项

- ...

## 额外实现项

- ...
```

### 2.4 生命周期

1. **创建时机**：`/tasks` 完成后，创建空的 changelog 文件（仅含标题和 tasks 链接）
2. **追加时机**：`/review` 阶段，reviewer 发现实现与设计偏差时追加 delta 记录
3. **最终化**：PR 合并前，reviewer 确认 changelog 完整

## 3. 文档同步流程（Doc Sync）

### 3.1 嵌入位置

作为 flow-code 技能的第 4 步，在 "分支 → 编码 → 单测" 之后，"PR" 之前：

```
分支 → 编码 → 单测 → 文档同步检查 → PR
```

### 3.2 流程步骤

1. flow-code 自动输出文档同步 checklist
2. 开发者逐项评估，标记需要更新的文档
3. 需要修改的文档随代码一起提交到同一个 PR
4. PR body 中列出已同步的文档

### 3.3 Checklist 模板

```markdown
## 文档同步检查清单

□ guides/quickstart.md — 安装方式或前置条件有变化吗？
□ guides/configuration.md — 新增/修改了配置项吗？
□ guides/usage.md — 命令或行为有变化吗？
□ guides/architecture.md — 架构或流程有变化吗？
□ docs/dev/guides/contributing.md — 开发流程有变化吗？
```

### 3.4 flow-code 技能更新

在 `assets/skills/flow-code/SKILL.md` 中：

**Workflow 部分**，在步骤 3（分支→编码→单测→PR）和步骤 4（更新开发文档）之间插入新步骤 4：

```markdown
### 4. 文档同步检查

完成编码后，逐项检查以下文档是否需要同步更新：

\`\`\`
## 文档同步检查清单
□ guides/quickstart.md — 安装方式或前置条件有变化吗？
□ guides/configuration.md — 新增/修改了配置项吗？
□ guides/usage.md — 命令或行为有变化吗？
□ guides/architecture.md — 架构或流程有变化吗？
□ docs/dev/guides/contributing.md — 开发流程有变化吗？
\`\`\`

- 逐项评估，无需修改的跳过
- 需要修改的文档随代码一起提交到同一个 PR
- PR body 中列出已同步的文档
```

原步骤 4（更新开发文档）重编号为步骤 5。

**Output 部分**，追加：
```markdown
- 文档同步 checklist 已完成
- 已同步的文档随 PR 提交
```

## 4. flow-review 更新方案

### 4.1 新增审查维度

在 `assets/skills/flow-review/SKILL.md` 的 Workflow 中，步骤 3（双轴审查）之前插入新步骤 3'，原步骤 3 重编号为 4：

```markdown
### 3. 文档同步确认

确认 PR 中是否包含文档同步：
- 检查 PR body 是否列出已同步的文档
- 检查 `docs/guides/` 和 `docs/dev/guides/` 是否有相应变更
- 如涉及配置/API 变更但文档未同步 → 标记为阻断性问题
```

### 4.2 Changelog 追加

在步骤 4（双轴审查）中，规格轴追加子步骤：

```markdown
**规格轴（Specification）** — 代码是否忠实实现了需求？
对照 PRD（`docs/prd/`）和设计方案（`docs/dev/specs/`）验证。
- 如发现实现与设计偏差 → 追加到 `docs/dev/changelog/<YYYY-MM-DD-NNN-slug>.md`
```

### 4.3 合并前检查清单

在步骤 5（等待 CI + 自动合并）之前插入：

```markdown
### 5. 合并前检查

在合并前确认以下项：
- 文档同步已完成（`docs/guides/` 已更新或无需更新）
- changelog 已记录偏差（如有）
- CI 已通过
```

## 5. 迁移计划

### 5.1 执行步骤

| 步骤 | 操作 | 验证 | 影响 |
|------|------|------|------|
| 1 | 创建 `docs/dev/tasks/2026-07-09-001-docs-and-pages/` 目录 | 目录存在 | 新建 |
| 2 | 移动 7 个 docs-and-pages 文件到新目录 | 文件已移动，原位置已空 | 移动 7 文件 |
| 3 | 创建 `docs/dev/tasks/2026-07-10-001-vitepress-migration/` 目录 | 目录存在 | 新建 |
| 4 | 移动 7 个 vitepress-migration 文件（含 DAG.md）到新目录 | 文件已移动，原位置已空 | 移动 7 文件 |
| 5 | 创建 `docs/dev/changelog/` 目录 | 目录存在 | 新建 |
| 6 | 创建空 changelog 文件 | 2 个 `.md` 文件存在 | 新建 2 文件 |
| 7 | 更新 `docs/.vitepress/config.ts` 中 `getSidebar()` | `npm run docs:dev` 侧边栏正确显示 | 修改 1 文件 |
| 8 | 更新导航栏链接 | 导航栏无死链 | 修改 1 文件 |
| 9 | 更新 `assets/skills/flow-code/SKILL.md` | 技能文档包含 doc sync 步骤 | 修改 1 文件 |
| 10 | 更新 `assets/skills/flow-review/SKILL.md` | 技能文档包含 changelog 和文档确认 | 修改 1 文件 |
| 11 | 构建验证 | `npm run docs:build` 成功，无 dead link | — |

### 5.2 风险评估

| 风险 | 影响 | 对策 |
|------|------|------|
| 外部引用旧 task 文件路径 | 旧链接 404 | VitePress 站点尚未广泛传播，影响极小；如有外部引用再添加重定向 |
| 拼音 slug 在侧边栏显示不佳 | 显示不友好 | 使用 PRD 中的英文 slug（已确认） |
| 嵌套目录导致 `getSidebar()` 逻辑复杂 | 维护成本 | 仅对 `dev/tasks` 做特殊处理，不影响其他目录 |
| `readdirSync` 对嵌套目录执行路径假设 | 构建失败 | 步骤 11 的构建验证覆盖此场景 |

## 6. 影响范围

| 文件 | 操作 | 说明 |
|------|------|------|
| `docs/dev/tasks/*.md`（14 个） | 移动 | 按 feature 重组到子目录 |
| `docs/.vitepress/config.ts` | 修改 | `getSidebar()` 适配新结构 + 导航栏更新 |
| `assets/skills/flow-code/SKILL.md` | 修改 | 新增文档同步步骤 |
| `assets/skills/flow-review/SKILL.md` | 修改 | 新增 changelog + 文档确认 |
| `docs/dev/changelog/`（2 个 .md） | 新建 | 空 changelog 模板 |
| `docs/dev/tasks/2026-07-09-001-docs-and-pages/` | 新建 | 目录 |
| `docs/dev/tasks/2026-07-10-001-vitepress-migration/` | 新建 | 目录 |

## 7. Out of Scope

- 自动检测代码变更影响哪些文档（AI 辅助但最终人工判断）
- specs/ 技术方案自动更新 — 设计阶段产物，代码阶段不改
- adr/ 架构决策记录自动更新 — 设计偏离时单独更新
- task 文件修改 — 保留原始设计意图，变更记入 changelog
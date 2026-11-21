---
name: flow-docs
description: Write and organize unified living project documentation — docs/specs/ current-state specs, docs/adr/ decisions, OpenSpec delta-to-spec semantic sync, relative links, Mermaid diagrams, and site build validation.
---

# flow-docs

统一维护项目的**当前状态规格与长期文档**（系统现在如何工作），实现 OpenSpec「变更增量 → 活规格同步」的沉淀闭环。

## 统一文档结构

只维护一套文档结构，不再并存两套目录树：

| 路径 | 定位 | 更新策略 |
| --- | --- | --- |
| `CONTEXT.md` | 项目领域术语权威 | 发现并确认新术语时即时更新 |
| `docs/specs/` | **系统当前规格（Living Specs）**：按模块/能力描述当前行为、接口契约与 `Testing Decisions` | 功能合并或行为变更后，**语义同步**更新对应模块规格 |
| `docs/adr/` | 架构决策记录（仅重大架构边界/选型决策） | 只增不改（不可改写的历史；新决策显式取代旧决策） |
| `docs/prd/` | 大功能流需求 PRD | 需求确认后沉淀，不作为日常最新状态替代品 |
| `docs/dev/research/` | 调研与事实核查报告 | 按专题保存 |
| `docs/guides/` | 用户与开发者使用指南 | 随面向用户的功能/配置变动同步更新 |
| `.cabbage/changes/` | 需留痕变更的临时记录（验证过门后归档至 `.cabbage/archive/`） | 合并后语义同步进 `docs/specs/` 再归档 |

- **不再以 18 个编号子目录作为规范入口**：存量项目若曾用 `cabbage init` 生成编号目录，只保留已有实际内容的目录，新活规格统一收敛至 `docs/specs/`。
- **单一任务账本**：Task 进度与依赖保存在 GitHub Sub Issues，不写本地 task Markdown。

## OpenSpec 语义同步规则

1. **Delta → Living Spec**：变更本身（PR / `.cabbage/changes/`）只描述“本次改了什么”；合并后必须把**当前仍然成立的行为变化**语义合入 `docs/specs/<module>.md`，而不是直接把临时提案原样覆盖过去。
2. **单一事实来源**：一个事实只在一处定义，其他文档用相对路径链接过去，不复制正文。
3. **当前状态 vs 决策历史**：`docs/specs/` 原地更新反映最新现实；`docs/adr/` 与归档记录是不可改写的历史。
4. **稳定路径**：不使用 `spec-v2-final.md`、`_latest.md`、`_copy.md` 这类文件名，版本交给 Git。
5. **相对链接**：仓内链接一律用相对路径并带文件扩展名，不写 `/docs/...` 绝对路径。
6. **不写占位内容**：禁止留存 `TODO`、`TBD`、`FIXME`。

## 校验与站点

```bash
cabbage({op:"validate"})            # 结构、标题锚点、相对路径、Mermaid 围栏（存在 .cabbage/ 时适用）
```

站点（如仓库使用 VitePress）：在项目根目录执行 `npm run docs:build`（或项目 Profile 指定的文档构建命令）验证无死链与围栏闭合。

## 图表

使用 Mermaid，写在 ` ```mermaid ` 围栏内；围栏必须闭合，否则校验与站点构建都会失败。常用类型：流程图、时序图、状态图。图表只画难以用文字表达的关系。

## 归属与评审

关键长期文档可在 frontmatter 声明维护方（`owner`、`maintained-by`、`last-reviewed`），并用 `.github/CODEOWNERS` 让架构、安全等目录的改动由对应负责人评审。

## Contract

### Trigger
撰写或更新 `docs/specs/` 活规格、同步变更到长期文档、修复死链或构建文档站点时触发。

### Inputs
- 需要沉淀的行为变化或文档问题
- 对应的 `docs/specs/<module>.md` 或目标文档路径

### Preconditions
- 涉及的变更行为已确认（PR 已合并或设计基线已确认）

### Procedure
1. 确定文档归属：`docs/specs/`（活规格）/ `docs/adr/`（不可变决策）/ `docs/guides/`（指南）
2. 执行 OpenSpec 语义同步：把新增/修改/废弃的行为合入 `docs/specs/` 对应模块，不直接覆盖丢失既有上下文
3. 检查相对链接、Mermaid 围栏闭合、无 `TODO`/`TBD` 占位符
4. 如存在 `.cabbage/` 或文档站点，执行结构校验或站点构建确认无错误

### Outputs
- 更新后的 `docs/specs/` 或归属文档（链接与结构校验通过）

### Failure
- `broken link` → 修正相对路径层级或锚点 slug，确认目标文件存在
- 链接越出项目根 → 改用仓内相对路径
- 站点构建失败 → 检查死链、未闭合 Mermaid 围栏或非法 HTML 标签

### Idempotency
- 重复执行文档校验与构建检查为幂等只读操作
- 重复将同一已合并变更同步至 `docs/specs/` 时，保持幂等不产生重复段落

### Prohibited Actions
- 不用 `final-v2`、`_latest`、`_copy` 之类文件名
- 不改写已归档的历史记录（`docs/adr/` / `.cabbage/archive/`）
- 不新建本地 task Markdown 或多套重复目录树
- 不直接把临时变更文件盲目覆盖替代 `docs/specs/` 既有活规格

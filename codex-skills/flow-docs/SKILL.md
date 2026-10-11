---
name: flow-docs
description: Write and organize long-lived project documentation — numbered docs tree placement, stable naming, relative links and anchors, Mermaid diagrams, ownership, and site preview or build. Use when authoring or moving current-state docs, fixing broken links, or running the documentation site.
---

# flow-docs

面向长期存在的**当前状态文档**（系统现在如何工作）。变更记录与门禁由 `flow-change` 负责。

## 目录归属（编号树）

`cabbage init` 生成的当前状态文档写入 `docs/` 下的编号目录，只创建有实际内容的目录：

| 目录 | 内容 |
| --- | --- |
| `00-overview/` | 项目概览、范围、快速上手 |
| `01-product/` | 需求、用户故事、验收标准 |
| `02-design/` | 交互与视觉设计、原型说明 |
| `03-architecture/` | 系统设计、`adr/`、`rfc/` |
| `04-domain/` | 数据模型、数据库设计、迁移与回滚 |
| `05-api/` | 接口契约、事件、集成 |
| `06-development/` | 本地开发环境、构建与调试 |
| `07-standards/` | 编码规范、评审约定 |
| `08-testing/` | 测试策略与用例 |
| `09-security/` | 威胁模型、权限与合规控制 |
| `10-infrastructure/` | 部署拓扑、容量、环境配置 |
| `11-ci-cd/` | 流水线定义与门禁说明 |
| `12-release/` | 发布流程与版本策略 |
| `13-operations/` | 运行手册、监控、应急预案 |
| `14-performance/` | 性能基线与压测结果 |
| `15-incidents/` | 事故记录与复盘（不可改写的历史） |
| `16-dependencies/` | 外部依赖清单与升级策略 |
| `17-compliance/` | 合规要求与审计证据 |

- 变更记录归档时 `archive` 自动 `sync`，把专项文档复制进对应编号目录；`sync` 只按映射复制，
  不做语义合并。
- 流程阶段产出的 PRD / 技术方案 / ADR 保留各自路径（`docs/prd/`、`docs/dev/specs/`、`docs/adr/`），
  与编号树各司其职：前者是流程产物，后者是长期当前状态。
- `.cabbage/changes/` 是变更历史，`docs/` 是当前状态，两者不互相复制内容。

## 写作原则

1. **单一事实来源**：一个事实只在一处定义，其他文档链接过去，不复制正文。
2. **当前状态 vs 决策历史**：当前状态文档原处更新；ADR/RFC/事故记录是不可改写的历史。
3. **稳定路径**：不使用 `spec-v2-final.md`、`_latest.md`、`_copy.md` 这类文件名，版本交给 Git。
4. **相对链接**：仓内链接一律用相对路径并带文件扩展名，不写 `/docs/...` 绝对路径。
5. **不写占位内容**：`TODO`、`TBD`、`FIXME` 会导致校验失败。

## 校验与站点

```bash
cabbage({op:"validate"})            # 结构、标题锚点、相对路径、Mermaid 围栏（不要求先建变更）
cabbage({op:"validate", change:"x"})  # 或只校验某条记录
```

站点（如仓库使用 VitePress）：`pnpm --dir docs run dev` 预览、`pnpm --dir docs run build` 构建；
构建失败先跑 `validate`（省略 `change` 校验全部）定位死链，再检查围栏闭合与 HTML 标签。

## 图表

使用 Mermaid，写在 ` ```mermaid ` 围栏内；围栏必须闭合，否则校验与站点构建都会失败。
常用类型：流程图、时序图、状态图、ER 图。图表只画难以用文字表达的关系。

## 归属与评审

关键长期文档应在 frontmatter 声明维护方：

```yaml
---
owner: team-billing
maintained-by: ["@alice"]
last-reviewed: 2026-03-01
---
```

用 `.github/CODEOWNERS` 让架构、安全等目录的改动必须由对应负责人评审。
该 frontmatter 是约定，CLI 不校验也不强制；真正的强制来自代码托管平台的分支保护。

## Contract

### Trigger
撰写或移动当前状态文档、修复死链、整理文档归属、预览或构建文档站点时触发。

### Inputs
- 文档内容或需要修复的链接/结构问题
- 目标编号目录（按内容性质选择）

### Preconditions
- 项目 docs 树已存在（未初始化时先经 `flow-change` 执行 `op:"init"`）

### Procedure
1. 按内容性质选择编号目录；只创建有实际内容的目录
2. 遵循写作原则（单一事实来源、稳定路径、相对链接、无占位）
3. `op:"validate"` 校验结构与链接；站点项目再执行构建
4. 关键文档补 frontmatter 归属；治理目录配 CODEOWNERS

### Outputs
- `docs/` 编号目录下的当前状态文档（或修复后的链接/结构）

### Failure
- `broken link` → 修正相对路径层级或锚点 slug，确认目标文件存在
- 链接越出项目根 → 改用仓内相对路径
- 站点依赖缺失 → 重新安装站点依赖后再构建

### Idempotency
- 重复 `validate` → 幂等只读
- 同一批移动操作分批提交 → 每批后校验保持可构建

### Prohibited Actions
- 不用 `final-v2`、`_latest`、`_copy` 之类文件名
- 不改写已归档的历史记录（ADR/RFC/事故）
- 不在当前状态文档与变更记录间复制正文

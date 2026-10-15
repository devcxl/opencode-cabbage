# 提案 04：退役 ADR 0007 并修复 ADR 树编号与交叉引用

**状态:** 已实施（2026-10-15）
**日期:** 2026-10-14
**扫描域:** docs/adr/、docs/prd/、docs/dev/specs/ 与全部入链

## 问题

### A. ADR 0007 是完全过时记录（"加后又删"）

原 ADR 0007（FlowRun 接入 Spike，2026-07-15，状态 Accepted）的决策是"阶段性接入 FlowRun（Option A）"，但其全部引用物已被删除：

- `src/flowrun/` 16 个模块：`fd70ec5`（2026-08-01）整体删除；
- 生命周期工具内核：`ab47197`（2026-08-02）删除；
- 现行防线：`rg "flowrun" src/ test/` = 0 命中；`npm run test:pack` 主动禁止 `dist/flowrun/`；`test/skills.test.ts:178` 禁止已删工具名回流。
- 无任何代码/配置/schema/持久化/兼容行为依赖它，无测试把它当受支持行为。

实际走向是 ADR 0007 备选表里的 **Option C（删除 FlowRun，简化为 Goal 增强）**。按"完全过时记录"规则，须先合并其独有信息，再删除。

### B. 删除前必须合并的内容（当前 owner = 薄内核篇 ADR 的 Superseded banner）

1. 实际结局：Option A 未以最终形态落地，2026-08 全量删除，等于选择 Option C。
2. 删除理由：双轨状态与 GitHub 权威源重复、约 4000 行已实现未接入代码、Prompt 侧实际走 Goal + gh CLI（薄内核篇 ADR 背景已部分记录，但缺 FlowRun 的结局句）。
3. Spike 验证证据：gate/checkpoint 逻辑曾通过 141 项测试（ADR 0007 结果节）——保留一句"验证过但未接入、最终删除"，防止后人误读为"未验证被删"。

### C. 编号冲突：两个 "ADR 0002"

- `docs/adr/2026-07-10-jekyll-github-pages-docs.md`（标题 ADR 0002，2026-07-10）与薄内核篇 ADR（标题亦为 ADR 0002，2026-08-01，现编号 0011）并存。
- 引用分裂：导航（`docs/.vitepress/config.ts:115`）与 ADR 0003 指 Jekyll 篇为 0002；ADR 0009:5、ADR 0010:5、ADR 0008:3 指薄内核篇为 0002。

### D. ADR 0008 交叉引用失真

- `:3` 声称"见 ADR 0002 的 Superseded 说明"，但该 banner 只讲内核回归，不含 TDD 工具链移除。
- `:5` 上级链接指向将被删除的 ADR 0007。

### E. 状态回填（小项）

ADR 0004/0005/0006 状态仍为 Proposed，而其交付物早已落地（任务目录 + changelog 流程、worktree 工作流、prompt 契约与 prompt-lint）。

## 提案

1. 将 B 节 1-3 写入薄内核篇 ADR（原 0002，现 0011）的 Superseded banner 状态行之后，建议文案：

   > FlowRun 的接入 Spike（原 ADR 0007，2026-07-15）曾选定 Option A 阶段性接入；2026-08-01/02 全量删除 `src/flowrun/` 与生命周期内核（fd70ec5、ab47197），实际结局为 Option C（删除 FlowRun，简化为 Goal 增强）。Spike 已验证 gate/checkpoint 逻辑（141 测试通过）；删除理由是双轨状态与 GitHub 权威源重复、约 4000 行未接入代码。

2. 删除原 ADR 0007 记录文件。
3. 修复入链：
   - ADR 0008:5 删除对 0007 的上级链接；
   - ADR 0008:3 改为"Runtime TDD 工具链与 FlowRun 相关门禁已于 2026-07-25 至 2026-08-02 整体移除（见 ADR 0011 的 Superseded 说明），TDD 回归 advisory self-report + CI 把关"；
   - `docs/dev/specs/tdd-integration-draft.md:6` 的 "ADR 0007" 改为"（原 ADR 0007，已退役并入 ADR 0011）"；
   - `docs/dev/tasks/2026-07-15-001-prompt-contract-refactor/manifest.yaml:89` 属历史交付清单（ADR 0004 约定设计态记录不改），保持不动。
4. 编号去重：将薄内核篇 ADR 的文件名与标题由 0002 改为 0011（`0011-adopt-thin-workflow-kernel.md`，标题 `ADR 0011`），并更新入链：ADR 0009:5、ADR 0010:5、ADR 0008:3、`docs/prd/thin-kernel-workflow.md:171`、`docs/dev/specs/thin-kernel-workflow.md:4`。Jekyll 篇保留 0002（时间在先，导航已按此标注）。
5. 状态回填：ADR 0004/0005/0006 改为 `Accepted`（0005 可标注"实现部分被 2026-08-02 回归移除，工作流形态保留"）。

## 我们放弃什么

- ADR 0007 作为独立页面与 URL 消失（git 历史保留全文）；对外站点的历史外链可能 404。可接受：站点规模小，其存在理由与结局已并入 ADR 0011。
- 薄内核篇改号会改 URL（薄内核篇 URL 由 0002 改为 `/adr/0011-adopt-thin-workflow-kernel`）；VitePress 构建期死链检查会抓出遗漏引用。
- 不删除薄内核篇 ADR（0002 → 0011）：它虽被取代，但仍是 FlowRun/内核删除的当前记录与防误重引入理由（规则要求的"删除记录"）。

## 验收标准

- 已达成：全仓库 `rg` 验证无指向原 ADR 0007 的链接/路径残留；历史 Task ID 与交付清单按 ADR 0004 约定保留（见第 3 条）。
- 已达成：全仓库 `rg` 验证无薄内核篇 ADR 旧文件名残留，引用全部指向 0011。
- ADR 目录编号唯一且有序（0002 = Jekyll，0011 = 薄内核；0007 随退役留空）。
- `npm run docs:build` 通过（死链检查）。

## 风险

- 若维护者偏好保留全部历史 ADR：最低限度动作 = 给 0007 加 Superseded banner 并补结局说明；本提案推荐完整合并，理由：其独有理由已被准确承接，保留独立记录持续误导"FlowRun 阶段性接入"仍有效。
- 改号属一次性 churn（5 个引用点），无代码依赖。

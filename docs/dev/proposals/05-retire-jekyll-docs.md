# 提案 05：退役 Jekyll 时代文档产物（banner + 导航纠偏）

**状态:** 待评审
**日期:** 2026-10-14
**扫描域:** docs/prd/、docs/dev/specs/、docs/.vitepress/config.ts

## 问题

- `docs/dev/specs/opencode-cabbage-docs-and-pages.md` 描述 Jekyll 站点（`docs/_config.yml`、`actions/jekyll-build-pages`），但仓库既无 `_config.yml`，Pages workflow 已是 VitePress（`.github/workflows/pages.yml:39` 执行 `npm run docs:build`；ADR 0003 已替代 Jekyll）。
- `docs/prd/opencode-cabbage-docs-and-pages.md` 状态为 "Approved"，范围/验收仍全为 Jekyll；背景句"9 个命令、5 个 agent、FlowRun 引擎"对 2.0.0 已失真（实际 7 命令 / 6 agent / 无 FlowRun）。
- 两者仍被导航当作现状展示：`docs/.vitepress/config.ts:107`（技术方案 → docs-and-pages spec）与 `:122`（PRD "Docs & Pages"）。
- 同类先行做法（不加正文修改、仅加废弃 banner）：`docs/prd/thin-kernel-workflow.md:3`、`docs/dev/specs/thin-kernel-workflow.md:3-5`、`docs/dev/specs/tdd-integration-draft.md:3-7`。

## 提案

1. 给 spec 与 PRD 各加 banner（不改正文，遵循 ADR 0004 保留设计原貌）：
   - spec 建议文案："已废弃（2026-10-14）：本方案描述的 Jekyll + GitHub Pages 已由 VitePress 迁移替代（ADR 0003、`docs/dev/specs/vitepress-docs-migration.md`）。保留作为历史设计记录。"
   - PRD 建议文案：同款 banner，另加一句"文中命令/agent 数量与 FlowRun 描述为当时状态，现状见 README"。
2. 导航纠偏（`docs/.vitepress/config.ts`）：
   - 移除 `:107` 的"技术方案"条目（sidebar 仍自动列出全部 dev/specs）；
   - 移除 `:122` 的 "Docs & Pages" 条目（与既有"VitePress 迁移"条目重复；PRD 仍在 sidebar 可见）。

   替代方案：保留条目但改指 `vitepress-docs-migration`；本提案建议直接移除，避免导航重复。

## 我们放弃什么

- 站点导航少两个入口；文档仍在 sidebar 可达，可达性不受影响。
- 不重写 PRD 正文中的过期数字与 Jekyll 范围（避免与"设计态记录不改"冲突）；banner 是既定先例。

## 验收标准

- 两个文件首部含废弃 banner；导航不再把 Jekyll 方案列为现状入口。
- `npm run docs:build` 通过。

## 风险

- 低；纯文档。

# 紧急修复（Hotfix）

> 归属：`docs/guides/sops/`
> 触发：线上 P0/P1 缺陷，需立即修复并尽快发版
> 关联概念：`01-bug-fix`、`08-rollback`、`flow-release`、Worktree Lifecycle

## 场景定义

对**已发布线上版本**的紧急缺陷，以最短路径修复并立即产出一个 patch 补丁发布。区别于常规 Bug 修复（`01-bug-fix`）：Hotfix 有明确时效约束，跳过非必要的流程步骤，并需在发布前后做回滚就绪。

## 目标与不做什么

- 目标：在最短时间内让线上行为恢复正确，且不引入新回归。
- 不做：不执行完整 `requirements → design → tasks` 流程；不做大规模重构；不在 Hotfix 里夹带无关改动。

## 标准方法论（行业通行）

借鉴 GitFlow 的 hotfix 分支约定与事故处理：

1. **严重度升级**：只有 P0/P1 才走 Hotfix 路径；P2/P3 走常规 `01-bug-fix`。
2. **从生产基线拉分支**：基于最近**发布 tag / release 分支**创建 `hotfix/<slug>`，而非开发最新分支——避免夹带未发布改动。
3. **最小修复 + 针对性测试**：只改暴露缺陷的代码；跑针对性测试 + 关键回归，确保修补不引入新问题。
4. **快速合并 + patch 发版**：合并回默认分支并立即打 patch tag（版本规则 `fix → patch`），发布流程走项目 GitHub Actions release workflow。
5. **双向合并**：修复同时合并回默认分支与当前开发主干，防止主开发线继续带病。
6. **回滚就绪**：发布前确认回滚策略（`08-rollback`），发布后监控，失败即回滚。
7. **事后复盘**：发布稳定后补 RCA 与预防措施（转 `01-bug-fix` 的复盘步骤）。

## 本项目落地流程

1. **确认紧急度**：P0/P1 → Hotfix；否则回退到 `01-bug-fix` 常规路径。
2. **拉生产基线分支**：
   ```bash
   LAST_TAG=$(git describe --tags --abbrev=0)
   git worktree add ".worktree/<slug>" -b "hotfix/<slug>" "$LAST_TAG"
   ```
3. **最小修复 + 针对性测试**：在 worktree 内修复，跑受影响模块测试 + 关键回归（复用 `flow-tdd` 的 RED→GREEN，但允许聚焦、不放宽门禁）。
4. **创建并合并 Hotfix PR**：`gh pr create` 指向默认分支；CI 绿 + 快速审查（`flow-review`）后 `--match-head-commit` 合并。
5. **patch 发布**：复用 `flow-release` 的 patch 路径——版本规则 `fix → patch`，更新版本文件 → Release PR → 合并打 tag → 触发 GitHub Actions release workflow，监控成功。
6. **合并回开发主干**：若默认分支与开发主干分离，将修复 cherry-pick / 合并到主干，防止复发。
7. **回滚预案 + 监控**：确认 `08-rollback` 策略；发布 workflow 失败区分「瞬时失败 rerun」与「代码缺陷 → Corrective Flow + 新版本」。
8. **复盘**：稳定后补 RCA、根因、预防措施。

## 验证与门禁

- [ ] 严重度确认 P0/P1（P2/P3 走常规 bug 修复）
- [ ] 受影响模块测试 + 关键回归通过
- [ ] CI 绿 + 审查通过后合并
- [ ] patch 发布 workflow 成功
- [ ] 修复已同步回开发主干
- [ ] 回滚预案就绪（发布前确认）

## 产出物

- `hotfix/<slug>` PR（合并回默认分支）
- patch Release（tag + GitHub Actions 发布）
- 回滚预案说明

## 复用与新增资产

- 复用：`flow-tdd`、`flow-review`、`flow-release`（patch 路径）、goal 工具、Worktree Lifecycle。
- 新增（缺口）：Hotfix 最短路径入口、patch 发布通道、`hotfix/<slug>` 分支约定。

## 反模式 / 注意事项

- 从开发最新分支拉 hotfix（会夹带未发布改动）。
- 在 Hotfix 里夹带重构或无关功能。
- 跳过针对性测试直接发版。
- 发布前不准备回滚预案。
- 修复后不同步回开发主干（后续合并冲突 / 复发）。

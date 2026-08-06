# 发布回滚与生命周期异常收尾

> 归属：`docs/guides/sops/`
> 触发：发布失败需回滚；Flow 中途放弃/阻塞/范围变更需受控收尾
> 关联概念：goal 工具、`flow-release`、`01-bug-fix`、Worktree Lifecycle

## 场景定义

两条相关但独立的路径：(1) **发布回滚**——线上行为被新版本破坏，需恢复到上一稳定状态；(2) **生命周期异常收尾**——一个 Flow 被放弃、阻塞或范围变化，需受控清理而非无限推进。

## 目标与不做什么

- 目标：快速恢复线上稳定、受控关闭异常 Flow，并记录教训。
- 不做：不无限重试失败的发布；不把「回滚」当作修复的终点（回滚后仍需 Corrective Flow 根治）。

## 标准方法论（行业通行）

### A. 发布回滚

1. **回滚策略**：按发布方式选择——`git revert`（改记录）或 revert PR（保留历史、可追溯）。**优先 revert PR**，避免直接改写共享历史。
2. **回滚就绪**：发布前就明确回滚路径（revert / feature flag / 降级），发布后监控，异常即回滚。
3. **回滚 ≠ 修复**：回滚只是恢复稳定，根因仍需 `01-bug-fix` 的 Corrective Flow + 新版本根治。
4. **区分瞬时失败**：发布 workflow 瞬时失败可 rerun；代码/配置缺陷才回滚。

### B. 生命周期异常收尾

5. **放弃 / 阻塞**：受控 `goal({op:"cancel"})` 或标记 blocked；清理 worktree、session-index、中间产物。
6. **范围变更**：区分「新增范围 → 新 Flow」与「原意澄清 → 更新验收」；不无限在原 Flow 上追加。
7. **教训记录**：异常后记录原因与处理，避免重复踩坑。

## 本项目落地流程

### A. 发布回滚

1. **识别回滚触发**：发布后监控到行为破坏 / workflow 失败且非瞬时。
2. **选择回滚方式**：优先 revert 对应 PR（`gh pr revert`），保留合并历史；保留可追溯性。
3. **确认恢复**：回滚后默认分支 CI 绿，线上行为恢复上一稳定版本。
4. **根治**：回滚后开 `01-bug-fix` Corrective Flow 定位根因，修复 + 回归，随 `flow-release` 新版本发布。

### B. 生命周期异常收尾

5. **放弃**：`goal({op:"cancel"})`；`git worktree remove` 清理 worktree；清理 session-index 残留。
6. **阻塞**：重试上限（如 3 次）用尽后标记 blocked、停止下游，通知用户介入；记录阻塞原因。
7. **范围变更**：按 `03-business-adjustment` 分诊——新增范围开新 Flow，原意澄清更新验收。
8. **教训记录**：在对应 Issue / 复盘文档记录异常原因与处理方式。

## 验证与门禁

- [ ] 回滚后线上行为恢复上一稳定版本
- [ ] 回滚 PR 保留可追溯历史（revert PR 而非改写历史）
- [ ] 根因已定位（回滚后转 `01-bug-fix`），非仅停留在回滚
- [ ] 异常 Flow 已受控收尾：worktree / session-index / 中间产物已清理
- [ ] 教训已记录

## 产出物

- 回滚 PR / revert（可追溯）
- Corrective Flow Issue（根因与修复）
- 异常收尾清理记录

## 复用与新增资产

- 复用：goal 工具（cancel/blocked）、`flow-release`（发布监控）、`01-bug-fix`（根治）、Worktree Lifecycle（清理）。
- 新增（缺口）：回滚策略入口；异常收尾（cancel/blocked/范围变更）的可执行流程文档。

## 反模式 / 注意事项

- 把回滚当终点，不追根因（回滚后必须转 Corrective Flow 根治）。
- 用 `git revert` 改写共享历史 / 强行重指 tag（`flow-release` 禁止覆盖已存在 tag）。
- 无限重试失败发布。
- 异常 Flow 不清理 worktree / session 残留，留脏状态。
- 范围变更无限在原 Flow 上追加而不分诊。

---
name: "pr5-flowrun-spike"
depends_on: []
labels: ["backend"]
worktree_root: ".worktree/pr5-flowrun-spike/"
---

## 目标

完成 FlowRun 接入 Spike：验证 Goal/FlowRun 状态边界，实现 PoC，输出最终 ADR。

## 实现要点

1. **PoC 接入**: server.ts 最小接入 `createInitialFlowRun`、`readFlowRun`、`getReadyTasks`、`canStartTask`
2. **Continuation 增强**: `queueContinuation` 注入 FlowRun 状态摘要
3. **Gate 验证**: canStartTask 正确阻止依赖未满足的任务
4. **Checkpoint 验证**: `validatePRCheckpoints` 在合并路径中的可用性
5. **兼容性**: 不修改 Goal tool 对外 API，现有测试不回归

## 验收标准

- [ ] PoC 测试：FlowRun 创建、Ready Tasks 计算、Gate 阻止、Checkpoint 拦截全链路通过
- [ ] 125 个现有测试不回归
- [ ] ADR 记录最终决策及理由
- [ ] 文档不再声称 FlowRun 已驱动 Runtime

## Worktree
- 路径: `.worktree/pr5-flowrun-spike/`
- 分支: `feat/pr5-flowrun-spike`
- 创建时机: `/code` 阶段首次执行时自动创建
- 清理时机: PR 合并后自动删除

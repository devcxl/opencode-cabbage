---
name: "worktree-dev-lifecycle"
depends_on: ["worktree-flow-code", "worktree-flow-tasks"]
labels: ["skill"]
worktree_root: ".worktree/worktree-dev-lifecycle/"
---

## 目标

改造 `assets/agents/dev-lifecycle.md` 中 Phase 3（并行编码实现），支持 batch 并行创建 worktree、派发 agent 到独立 worktree、合并后清理 worktree。

## 实现要点

### 改造前 Phase 3

```
Phase 3: 按 DAG 拓扑排序逐 batch 处理
  1. 创建分支 feat/<task-slug>
  2. 并行派发 @backend/@frontend 实现代码 + 单测
  3. 创建 PR
  4. 委派 @reviewer 审查 PR
  5. CI 通过后自动合并
```

### 改造后 Phase 3

```
Phase 3: 按 DAG 拓扑排序逐 batch 处理

For each batch:
  For each task in batch (可并行):
    1. 检查 worktree 是否存在
       - 不存在 → git worktree add .worktree/<task-slug> feat/<task-slug>
       - 存在（串行复用）→ 跳过
    2. 并行派发 agent 到各 worktree 路径
    3. 每个 agent 在 worktree 内:
       - npm install（如未安装）
       - 编码 + 单测
       - 提交 + push + 创建 PR
    4. 等待 batch 内所有 task 完成
    5. 委派 @reviewer 审查各 PR
    6. CI 通过后自动合并
    7. 合并后清理 worktree（git worktree remove --force）

For 串行 task（有依赖关系）:
  - 默认使用 Option A（清理后重建）：
    上一 task 合并后 → git worktree remove → git worktree add 新 task
```

### 约束处理

- `git worktree add` 约束：同一分支不能在多个 worktree 同时检出
  - 并行 task 使用不同分支（`feat/<task-slug>` 各不相同），不会冲突
  - 如果意外冲突 → 编排器暂停，提示用户手动清理
- 每个 agent 启动时显式 `cd .worktree/<task-slug>` 并验证 `pwd`

### 编辑文件

`assets/agents/dev-lifecycle.md` — 替换 Phase 3 内容。

## 验收标准

- [ ] Phase 3 支持 batch 并行创建多个 worktree
- [ ] 每个 agent 在独立 worktree 路径下执行编码任务
- [ ] 串行 task 使用清理后重建策略（Option A）
- [ ] 合并后自动执行 `git worktree remove --force`
- [ ] 分支冲突时编排器暂停并提示用户

## Worktree

- 路径: `.worktree/worktree-dev-lifecycle/`
- 分支: `feat/worktree-dev-lifecycle`
- 创建时机: `/code` 阶段首次执行时自动创建
- 清理时机: PR 合并后自动删除
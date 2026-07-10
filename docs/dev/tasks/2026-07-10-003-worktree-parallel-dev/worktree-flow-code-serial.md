---
name: "worktree-flow-code-serial"
depends_on: ["worktree-flow-code"]
labels: ["skill"]
worktree_root: ".worktree/worktree-flow-code-serial/"
---

## 目标

确保 flow-code 在串行 task（有依赖关系）场景下正确复用 worktree，使用"清理后重建"策略（Option A），保证每个 task 环境完全隔离。

## 实现要点

### 串行 task 场景

当 DAG 中存在依赖关系，下一 task 需要等待上一 task 完成合并后才能执行。

### 策略：清理后重建（Option A）

```
上一 task 合并 → git worktree remove .worktree/<old-slug> --force
              → git worktree add .worktree/<new-slug> feat/<new-slug>
              → npm install（在 worktree 内）
              → 编码 + 单测 + PR
```

### 与 flow-code 改造的关系

flow-code 改造（worktree-flow-code）已实现"检查 worktree 是否存在 → 不存在则创建"的逻辑，天然支持串行 task：

- 第一个 task：worktree 不存在 → 创建
- 第一个 task 合并后，worktree 被 flow-review 清理（worktree-flow-review）
- 第二个 task：worktree 不存在 → 创建（干净状态）

本 task 确保此流程在串行场景下正确运作，无需额外代码改动。

### 验证要点

1. 串行 task A → task B 完整流程测试
2. task A 合并后，`.worktree/task-a/` 被删除
3. task B 创建新 worktree `.worktree/task-b/`，从干净状态开始
4. task B 的 `npm install` 安装独立依赖，无 task A 残留

### 编辑文件

`assets/skills/flow-code/SKILL.md` — 确认 worktree 复用逻辑已覆盖串行场景，如需补充说明则追加。

## 验收标准

- [ ] 串行 2 个 task 时，第二个 task 的 worktree 从干净状态创建
- [ ] 第一个 task 的 worktree 在合并后已被清理
- [ ] 第二个 task 的 `node_modules` 无第一个 task 残留
- [ ] flow-code SKILL.md 中有串行 worktree 复用说明（如需要）

## Worktree

- 路径: `.worktree/worktree-flow-code-serial/`
- 分支: `feat/worktree-flow-code-serial`
- 创建时机: `/code` 阶段首次执行时自动创建
- 清理时机: PR 合并后自动删除
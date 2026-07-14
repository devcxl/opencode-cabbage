---
name: flow-requirements
description: 需求访谈 → PRD 输出 → GitHub Issue 创建
---

# flow-requirements

通过采访式对话澄清需求，输出 PRD 文档并创建 GitHub Issue。

## Prerequisites
- `/setup` 已完成（gh CLI 可用）

## Workflow

### 1. 需求访谈
按参考文档 `references/interview-guide.md` 进行深度盘问，澄清：
- 用户故事与业务价值
- 边界条件
- 验收标准
- 技术约束
- 排除范围（记录到 out-of-scope）

### 2. 输出 PRD
整理为 PRD 文档保存到 `docs/prd/<title>.md`。

参考 `_prompts/prd-format` 中的格式要求。

### 3. 记录 Out-of-Scope
将在访谈中明确排除的需求记入 `docs/dev/out-of-scope.md`：
- 便于后续回顾为什么某些功能不做
- 避免重复讨论

### 4. 创建 Parent GitHub Issue
```bash
mkdir -p tmp
gh issue create \
  --title "<PRD Title>" \
  --label "enhancement" \
  --body-file docs/prd/<title>.md
```

## Output
- `docs/prd/<title>.md` — PRD 文档
- `docs/dev/out-of-scope.md` — 排除范围记录
- GitHub Parent Issue 已创建

## 下一阶段
- **/design** — 基于此 PRD 进行技术设计

## Contract

### Trigger
由 `/requirements` 命令或 `@dev-lifecycle` Phase 0 触发。

### Inputs
- 用户提供的功能描述（来自消息文本）

### Preconditions
- `/setup` 已完成（gh CLI 可用，docs 目录就绪）

### Procedure
1. 按 interview-guide 进行需求访谈
2. 输出 PRD 到 `docs/prd/<title>.md`
3. 记录 Out of Scope 到 `docs/dev/out-of-scope.md`
4. 创建 Parent GitHub Issue

### Outputs
- `docs/prd/<title>.md` — PRD 文档
- `docs/dev/out-of-scope.md` — 排除范围记录
- GitHub Parent Issue

### Failure
- gh CLI 不可用 → 提示先执行 /setup
- Issue 创建失败 → 记录错误，不阻塞 PRD 写入

### Idempotency
- 如果 PRD 文件已存在 → 更新而非覆盖
- 如果 Parent Issue 已创建 → 追加评论而非重复创建

### Prohibited Actions
- 不跳过访谈直接输出 PRD
- 不省略 Out of Scope 记录

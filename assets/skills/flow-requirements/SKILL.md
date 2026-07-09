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

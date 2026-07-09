# flow-design

基于 PRD 进行技术方案设计，输出方案文档和 ADR。

## Prerequisites
- `/requirements` 已完成 → `docs/prd/<title>.md` + Parent Issue 存在
- 阅读 `../CONTEXT.md` 了解领域术语

## Workflow

### 1. 阅读上下文
- 阅读 PRD：`docs/prd/<title>.md`
- 阅读已有 ADR：`docs/adr/`（确保设计不与已有架构决策冲突）
- 阅读 `docs/dev/out-of-scope.md`（了解已排除范围）

### 2. 技术方案设计
输出到 `docs/dev/specs/<title>.md`，包含：
- 技术选型与理由
- 架构与数据流
- API / 数据模型
- 与已有的 ADR 的兼容性检查

### 3. 记录 ADR
为每个关键决策记录 ADR 到 `docs/adr/<YYYY-MM-DD>-<slug>.md`。
ADR 格式参考 `../_prompts/adr-format`。

ADR 至少记录：
- 技术选型决策
- 架构模式决策
- 任何可能有争议的方案选择

### 4. 附到 GitHub Issue
```bash
mkdir -p docs/dev/handoff
cat > docs/dev/handoff/design-comment.md << 'EOF'
## 技术方案

...（摘要）

## ADR

...（ADR 列表）

完整文档：docs/dev/specs/<title>.md
EOF
gh issue comment <issue-number> --body-file docs/dev/handoff/design-comment.md
```

## Output
- `docs/dev/specs/<title>.md` — 技术方案
- `docs/adr/<date>-<slug>.md` — ADR 决议
- Parent Issue 收到设计评论

## 后续
- **/tasks** — 基于设计方案拆解为 DAG 任务

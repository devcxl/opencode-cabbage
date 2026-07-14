# ADR 0006: Prompt 资产采用 Contract-first 约定式 Markdown

**状态:** Proposed
**日期:** 2026-07-15
**上级:** [ADR 0001](/adr/0001-replace-openspec-with-full-flow)

## 背景

当前 9 个 Skill、5 个 Agent、3 个 Prompt 和 9 个 Command 均为自由格式 Markdown。存在三类问题：

1. **执行不确定性**：输入来源、前置条件、输出格式、失败处理均为自然语言约定，模型可能误解或跳过。
2. **引用断链**：Skill 通过自然语言引用模板和上下文，路径不存在时无编译期检测。
3. **冲突不可见**：Agent 能力声明（Prompt 正文）、工具权限（Frontmatter permission）和文档描述（guides/）三方可能不一致。

## 决策

### 1. Stage Contract 采用约定式 Markdown，不引入结构化解析器

**选择**：每个 Skill 在 Markdown body 中追加 8 个固定二级标题段落：`Trigger`、`Inputs`、`Preconditions`、`Procedure`、`Outputs`、`Failure`、`Idempotency`、`Prohibited Actions`。

**理由**：

| 方案 | 可读性 | 可验证性 | 复杂度 | 结论 |
|------|--------|---------|--------|------|
| 约定式 Markdown 段落 | 高（人与模型均直观） | 中（正则匹配段落存在性） | 低 | ✅ |
| 结构化 Frontmatter | 中（YAML 复杂时难读） | 高（Schema 校验） | 高（需解析器） | ❌ |
| 独立 Contract 文件 | 低（需要跨文件对照） | 高 | 中 | ❌ |

**备选方案**：
- 结构化 Frontmatter：需要 Schema 定义和解析器，9 个 Skill × 8 字段 × 复杂嵌套结构会使 Frontmatter 过于庞大，且模型在阅读 YAML 块时可能不如 Markdown 段落准确。
- 独立 Contract 文件：增加维护成本，Skill 主体和 Contract 分离容易漂移。

### 2. Task Manifest 采用 YAML 文件，作为依赖关系唯一权威源

**选择**：每个 Feature 目录下放置 `manifest.yaml`，包含所有 Task 的 ID、依赖、Agent、预估工时、验证命令和 Worktree 路径。Mermaid 图和 Markdown 表格从 Manifest 自动生成。

**理由**：
- 当前 Task 依赖散落在 Frontmatter、Sub Issue Body、Mermaid 和表格中，已出现不一致（Mermaid 漏边）
- YAML 同时被人类和模型可读，且易于用脚本校验环形依赖
- Mermaid 和表格的自动生成消除了多源漂移

### 3. Agent 能力矩阵通过 Frontmatter capabilities 字段表达

**选择**：Agent Frontmatter 新增 `capabilities` 字段，与 `permission` 并存。`permission` 控制代码层执行权限，`capabilities` 控制 Prompt 层行为声明。Lint 交叉比对两者。

```yaml
capabilities:
  create_pr: false
  merge_pr: false
  modify_files: true
  run_tests: true
  push_branch: true
  approve_review: false
  complete_goal: false
```

### 4. Bootstrap 采用三层条件注入

**选择**：Flow 命令注入 Stage 上下文，Active Goal 注入 Goal 摘要，普通会话不注入。

**理由**：当前 Bootstrap 19 行菜单注入所有会话首条消息，污染非工作流对话。三层策略按需注入，减少不相关 Token 消耗。

### 5. Prompt 测试本轮仅做静态 Lint

**选择**：实现引用完整性、能力一致性、硬编码检测、Contract 完整性、冲突检测五项静态检查，纳入 CI。行为场景测试（真实模型 API）留作后续增强。

## 后果

### 正向

- Skill 执行结果确定性显著提升——输入、输出、失败路径有明确契约
- Task 依赖数据一致性由 Manifest 单源保障，自动生成消除手工错误
- Agent 能力与权限交叉验证防止工具执行失败
- Bootstrap 不再污染非工作流会话
- 静态 Lint 提供持续的质量保障

### 风险

- 8 个段落的 Stage Contract 增加了 Skill 文件的长度（每个 Skill 约增加 20-30 行），但信息密度也同步提升
- Lint 规则需要随着 Contract 格式演进同步更新
- 模型对 `capabilities` 字段的理解依赖训练数据，不是代码级强制

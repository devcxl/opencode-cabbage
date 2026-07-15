# 提示词 Contract-first 重构

## 概述

对 opencode-cabbage 插件全部提示词资产（3 Prompts、9 Slash Commands、9 Skills、5 + 1 Agents、Context/References）进行 Contract-first 重构。修复已发现的 P0 阻断性问题，建立统一的 Stage Contract、Task Manifest、Agent 能力矩阵、环境探测和 Prompt 静态测试基线。交付方式为多个小 PR（每 PR ≤10 文件）。

## 用户故事

- 作为**插件使用者**，我期望命令和 Skill 的执行结果确定、可预测，不会因路径断裂、权限冲突或自然语言歧义而导致流程中断或数据丢失。
- 作为**插件维护者**，我期望 Prompt 资产的契约可机器验证——修改一个 Skill 后能自动检测引用是否断开、Agent 职责是否冲突、破坏性操作是否有 Gate。
- 作为**新项目接入者**，我期望插件自动探测分支名、包管理器和验证命令，无需手动配置。

## In Scope

### 1. P0 修复

| # | 问题 | 修复方向 |
|---|------|---------|
| 1 | PRD/ADR 模板和 Context 引用断链 | 模板接入 Runtime Skill 的 `_prompts/` 目录；Skill 引用统一为相对路径 |
| 2 | Reviewer 权限（禁 bash/write）与职责（执行 gh / 写报告）冲突 | Reviewer 只读审查，Orchestrator 发布 Review 和合并 |
| 3 | Worker（backend/frontend）禁止创建 PR，但 Orchestrator 又要求 Worker 创建 | Worker 负责代码 + Push；Orchestrator 创建 PR |
| 4 | 任意 Subagent 可以完成全局 Goal | 代码层只允许 `goal-verify` 完成 Goal |
| 5 | Reviewer 在单 PR 审查时调用 `goal({op:"complete"})` 导致多任务流程提前结束 | Reviewer 不再调用 complete；`goal-verify` 在全流程末尾调用 |
| 6 | Worktree 创建命令 git worktree add .worktree/{slug} feat/{slug} 引用了尚未创建的分支 | 使用 git worktree add -b；动态探测基础分支 |
| 7 | 破坏性操作缺少安全 Gate：直接 push main、git add .、git worktree remove --force | 文档通过 Planning PR 合入；commit 基于 Task 输出文件；worktree 清理前做 Preflight |
| 8 | Bootstrap 无条件注入所有会话 | 三层条件注入：Flow 命令、Active Goal、普通会话 |
| 9 | 项目环境硬编码（npm、main、测试命令） | 运行时探测 + Prompt 注入 |
| 10 | FlowRun 模块未接入 Runtime，但文档声称已驱动流程 | 完成 Spike + ADR；文档先纠偏 |

### 2. Contract-first 基础设施

- 9 个 Skill 统一采用 Stage Contract 格式（Trigger、Inputs、Preconditions、Procedure、Outputs、Failure、Idempotency、Prohibited Actions）
- 每个 Feature 目录引入 `manifest.yaml` 作为任务依赖唯一权威源
- Agent Frontmatter 增加 `capabilities` 字段，与 `permission` 交叉验证
- 建立 Prompt 静态 Lint（引用完整性、能力一致性、硬编码检测），纳入 CI
- Bootstrap 改为三层条件注入

### 3. FlowRun Spike

- 验证 Goal 与 FlowRun 状态边界
- 实现 PoC：创建 FlowRun → 计算 Ready Tasks → Gate 检查 → Merge Checkpoint
- 输出 ADR 记录决策（接入 / 重写后接入 / 删除）

## Out of Scope

- 完整 FlowRun 接入上线（本轮仅 Spike + ADR）
- 行为场景测试（使用真实模型 API 的端到端 Prompt 测试）
- 确定性引擎化（将 Git/GitHub/DAG/Gate 全部迁出 Prompt 到代码工具——方案 C）
- Release 流程（npm publish）
- 新建独立 CLI 工具链
- 非 opencode-cabbage 项目的 Prompt 规范制定
- 当前 docs/ 目录下非 Skill/Agent/Command 文档的重构

## 验收标准

### P0 修复验收

- [ ] 所有 Prompt 相对路径引用可解析（零断链）
- [ ] Reviewer 权限与 Prompt 职责无冲突
- [ ] Worker 不再被要求创建 PR
- [ ] 只有 `goal-verify` 可完成全局 Goal
- [ ] Reviewer 单 PR 审查不会提前完成多任务 Goal
- [ ] 新任务首次 Worktree 创建成功（分支和目录都不存在时）
- [ ] 无直接 `git push origin main/master/dev` 等硬编码
- [ ] Worktree 清理前执行 Preflight 检查（PR 已合并、HEAD 已 Push、目录干净）
- [ ] `git add .` 被替换为基于 Task 输出文件的显式暂存列表
- [ ] 非 Flow 会话不注入 Bootstrap 工作流菜单

### Contract-first 基础设施验收

- [ ] 9 个 Skill 均包含 Trigger、Inputs、Preconditions、Procedure、Outputs、Failure、Idempotency、Prohibited Actions 段落
- [ ] 每个 Feature 目录下存在 `manifest.yaml`，Mermaid 图和表格可从 Manifest 自动派生
- [ ] 3 个 Agent Frontmatter 存在 `capabilities` 字段
- [ ] `capabilities` 与 `permission` 交叉验证通过
- [ ] Prompt 静态 Lint 通过且纳入 CI
- [ ] 项目级 Prompt 覆盖机制生效

### 环境适配验收

- [ ] 在 `main` 和 `master` 分支的项目中均可正常运行
- [ ] 在 npm、yarn、pnpm 项目中均可正确探测
- [ ] 在默认分支保护开启的仓库中流程不中断

### FlowRun Spike 验收

- [ ] PoC 测试通过：能创建 FlowRun、能计算 Ready Tasks、Gate 正确阻止、Checkpoint 未通过时禁止 Merge
- [ ] ADR 记录明确决策及理由、成本和迁移方案
- [ ] 文档不再声称 FlowRun 已驱动 Runtime

## 技术约束

- 语言：TypeScript（插件代码）、Markdown + YAML Frontmatter（Prompt 资产）
- 运行环境：Node.js ≥24
- 外部依赖：@opencode-ai/plugin ^1.3.7、gh CLI ≥2.0、Git ≥2.5
- 测试框架：Vitest
- 每个 PR 不超过 10 个文件
- 不引入新的 npm 依赖（Prompt Lint 用内置脚本实现）
- 不修改 @opencode-ai/plugin 和 @opencode-ai/sdk 版本
- 不影响现有 125 个测试的通过

## 优先级

| 项 | 优先级 |
|----|--------|
| P0 角色/权限/Goal 修复（PR1） | P0 |
| 模板/引用修复（PR2） | P0 |
| Worktree 安全修复（PR3） | P0 |
| Git/GitHub 安全修复（PR4） | P0 |
| FlowRun Spike + ADR（PR5） | P0 |
| Stage Contract 格式迁移（PR3-PR4 中包含） | P0 |
| Task Manifest 引入 | P1 |
| Agent capabilities 字段 | P1 |
| 环境探测 Prompt | P1 |
| Bootstrap 条件注入 | P1 |
| Prompt 静态 Lint | P1 |

## 风险

| 风险 | 影响 | 对策 |
|------|------|------|
| Goal 身份校验依赖 ToolContext.agent，API 可能尚未暴露该字段 | 代码层校验受阻 | 先做 Prompt 层修正 + 结构化 assertion，API 支持后再补代码校验 |
| Planning PR 流程可能因分支保护默认拒绝 | 文档提交阻塞 | 如果仓库无分支保护，planning PR 可自动合并；否则保留 manual merge 路径 |
| Prompt 大规模重写可能引入新的语义漂移 | 回归风险 | 每 PR 独立审查，Lint 纳入 CI 自动检测 |
| 环境探测依赖模型执行 bash，可能不准确 | 探测结果偏差 | 只看已知标记（package.json、pom.xml、.git/refs），不确定时暂停并询问 |

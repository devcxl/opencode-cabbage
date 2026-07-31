# PRD: Thin Kernel + Project Context 工作流重构

## 背景

当前 opencode-cabbage 处于危险的中间态：约 2900 行 FlowRun/TDD 运行时代码已实现并通过 468 个单测，但没有任何 prompt/agent 指引调用它们；与此同时 README 与 guides 仍把这些能力描述为已驱动流程。低质量模型在本仓库中只能靠自由文本 prompt 执行，无任何代码兜底。

核心问题：

1. **双轨误导**：Prompt 实际走 `Goal + gh CLI`，FlowRun 状态机被旁路。
2. **Context 未参与**：目标项目根 `CONTEXT.md` 未发现、创建、更新或一致性检查。
3. **slug 无约束**：worktree/branch slug 由模型自由发挥，低质量模型产出 `Task 001`。
4. **状态冗余**：Goal、FlowRun cabinet、`session-state.json`、Sub Issue、task .md、manifest 六处状态源。
5. **TDD 无 enforcement**：`tdd_checkpoint` 未注册，RED/GREEN 证据靠模型自报。
6. **职责重复**：Worktree 生命周期四处重复，工程原则三份拷贝，goal-verify prompt 双份，文档多处漂移。

## 目标

采用 **Thin Kernel + Project Context** 架构重构，作为 major release 清晰切断旧架构：

- GitHub Parent Issues、Sub Issues、PRs、Checks 作为工程状态的**唯一权威事实**，删除持久化 FlowRun。
- 用确定性工具约束 slug、Task、Worktree、Runtime TDD、Review/Merge、Release 等不可由模型自由决定的高风险动作。
- 目标仓库根 `CONTEXT.md` 作为领域语言权威，自动注入 Primary 与所有子 Agent。
- 行为变更强制 Runtime TDD，证据存 Task Record 单一评论，缺证据禁止 PR。

## 非目标（Out of Scope）

- 不建设完整 FlowRun 状态机平台（拒绝选项）。
- 不做纯 Prompt 流程（拒绝选项：无法约束低质量模型）。
- 不保留旧架构双轨兼容；旧 Flow 使用旧插件版本完成，新版本只检测 legacy FlowRun 并提示。
- 不自动迁移旧 Flow 状态。
- 不支持多 Context（`CONTEXT-MAP.md`），只支持仓库根 `CONTEXT.md`。
- 不自动发布生态包（npm/PyPI 等），实际发布必须走项目自己的 GitHub Actions release workflow。

## 需求

### R1 工程权威源

- 一个 **Flow** = 一个 GitHub Parent Issue（Flow Record）。
- 一个 **Task** = 一个 GitHub Sub Issue（Task Record）。
- PR 关联 Sub Issue，CI Checks 关联 PR；三者共同构成进度权威事实。
- 删除 FlowRun cabinet（Issue body JSON）、manifest.yaml、task .md、FlowRun task state。
- 删除 `session-state.json` 的状态复制，只保留 Flow→session 轻量索引。
- Goal 最小化：只保存 `parentIssueNumber / status / continuationCount`；目标与验收条件从 Flow Record/PRD 读取。

### R2 Project Context

- 插件在 Primary 会话与每次子 Agent 派发时自动注入根 `CONTEXT.md` 内容与 digest，文件变更后刷新。
- Requirements/Design 主动发现术语；Tasks/Code/Review 发现新术语或冲突时暂停提问。
- 只有用户确认后才更新 `CONTEXT.md`，且只写领域词汇与关系，不写需求、实现方案或执行状态。
- 删除 `assets/context/CONTEXT.md` 内置注入机制。
- 删除全局 `docs/dev/out-of-scope.md`，Out of Scope 归属各自 PRD。

### R3 Functional Slug

- 模型只提交**英文功能标题**（Flow 与 Task 一致），薄内核据此派生 slug。
- 硬校验：拒绝 `Task 001` / `task-1` / `implement-task` 等泛化或编号标题；格式非法拒绝；未完成 Task 冲突拒绝（要求改标题）。
- branch = `feat/<slug>`（按 type 可为 `fix/ chore/ docs/`），worktree = `.worktree/<slug>`，只能由内核派生，模型不可覆盖。

### R4 Thin Kernel 工具（5 个生命周期工具）

- `setup_control`：探测/校验/生成 CI 与 release workflow 草案。
- `flow_control`：创建/状态/取消/完成 Flow。
- `task_control`：Task 创建/启动/提交/审查/合并/取消，内部管理 GitHub、branch 与 Worktree。
- `tdd_checkpoint`：RED/GREEN/回归证据。
- `release_control`：版本提议/Release PR/tag push。
- 工具内部校验 caller：Primary 全量；developer 仅 `tdd_checkpoint` + 本地 edit/commit；architect 仅 Planning Worktree 文档；reviewer 只读；goal-verify 额外允许 flow complete。
- 高风险 git/gh 写操作（task 创建/更新、worktree 创建、push、PR 创建、merge、Issue 关闭、Worktree 销毁）只走工具；模型可直接只读 git/gh、本地 edit/add/commit。
- 复用现有 `gh auth`，不建设第二套 broker 凭据。

### R5 Worktree 生命周期

- 创建/复用校验/销毁全部由 `task_control` 管理。
- PR 已合并且 worktree 干净 → 自动销毁；脏 worktree → 拒绝；Task 取消或 PR 未合并 → 人工确认且分支已推送；无 `--force`。

### R6 Runtime TDD 硬门禁

- 行为变更 Task 必须 Runtime TDD；纯文档自动 `not-applicable`；其他豁免必须用户批准。
- `worktree-start` 记录干净基线；工具亲自执行 RED（必须因缺失行为失败、实现文件相对基线未变）与 GREEN（同一测试通过、输入未偷换）；final regression 必须通过。
- 证据 append 到 Task Record 的单个受控 comment（criterion、cycle、命令、exit code、failure kind、tree/digest、状态）。
- `task-submit` 检查 TDD evidence 完整，否则拒绝创建 PR。

### R7 并行与恢复

- 默认最多并行 5 个 Tasks；依赖 Task 等前置 PR merge 后才解锁。
- 无依赖 PR 直接 merge，不主动 rebase/merge main；并行 PR 文件重叠 → 串行化并重验证。
- Task 失败自动重试最多 3 次；Review 修复最多 3 轮；其他独立 Tasks 不受影响。
- 连续 3 次 continuation 无可验证进展才暂停；删除 generic `[skip]`。
- 同 Flow 双 session：默认拒绝，active 时 takeover 需用户确认。

### R8 Review 与 Merge

- 同一 reviewer Agent 对每个 PR 并行双轴审查（Specification / Quality），任一轴阻断即修复。
- GitHub 全局强制 PR + required Checks；低风险 PR 不全局要求 approval（保证自动 merge）；高风险 PR 必须存在非作者人类 approval。
- 风险双层判定：模型初判 + 内核按实际 diff 自动升级（migrations/auth/permissions/release workflow/公共 API/密钥配置），只能升级不能自动降级。
- 独立 goal-verify 验证通过后才允许关闭 Flow Record。

### R9 Release

- 技术栈无关；`release_control` 聚合上一 tag 后 main 的全部变更，未分类变更在版本提议前要求用户分类。
- SemVer：breaking→major、feature→minor、fix/maintenance/docs→patch；0.x breaking 也直接升 major；自动提议版本，用户确认。
- 固定顺序：Release branch → 更新版本/Release Notes → Release PR → CI + 人工批准 → merge → 校验 SHA → 打 tag push。
- 监控项目 GitHub Actions release workflow 成功才算完成；瞬时失败可 rerun，代码/配置/workflow 缺陷走 Corrective Flow 和新版本。
- Release Profile（版本读写规则、tag 格式、workflow 路径）在 `/setup` 探测并确认，写入根 `AGENTS.md` 的 Markdown Profile 区块。

### R10 项目配置

- 通用策略（并发 5、重试 3、TDD 模式、SemVer 规则、风险类别）内置插件默认值。
- 项目特定约定（测试命令、文件模式、版本规则、workflow）由 `/setup` 探测 + 用户确认，写入根 `AGENTS.md` 的自然语言 Markdown Profile。
- `development-ready`：git/gh 可用、Profile 已确认、TDD 命令可执行、PR CI workflow 存在、默认分支保护存在。
- `release-ready`：额外要求版本规则与 release workflow。
- 缺失 CI/release workflow → Setup 生成草案 + Setup PR 人工合入。

### R11 流程阶段

- 核心 Stage：`requirements → design → tasks → code → review`；Flow 在 merge + Worktree 清理 + 独立验证后完成。
- `dev-lifecycle` 保持 Primary 模式自动编排；Stage commands（`/setup /requirements /design /tasks /code /review /release`）保留但共享单一 contract。
- Requirements 开始创建 Draft Parent Issue；需求基线必须用户确认一次。
- 单个 Planning PR 合入 CONTEXT.md + PRD + Design + ADR，形成 Planning Baseline。
- Design 完成后 Tasks 才创建 Sub Issues；高风险方案在 Design 与 Tasks 之间暂停确认。
- 测试作为跨阶段门禁：Code 跑 TDD 与本地回归，Review 等 CI；`/test` 仅诊断命令，非独立 Stage。
- Flow 中途新增范围 → 新 Flow；原意澄清 → 用户确认后更新验收；放弃 → 受控 cancel；merge 后回归 → Corrective Flow。

### R12 Agent 与 Skill 收敛

- backend + frontend 合并为技术栈无关 `developer` subagent；保留 architect、reviewer、goal-verify。
- Skills 收敛为 8 个：`flow-setup flow-requirements flow-design flow-tasks flow-code flow-tdd flow-review flow-release`。
- 删除 `flow-handoff`、`flow-test`（独立 skill）；删除内置 Context 注入；删除 `@dev-lifecycle` 重复编排文本。
- 工程原则、goal-verify prompt、Review contract、Stage contracts 各只有一份。

## 验收标准

1. 根 `CONTEXT.md` 与 `AGENTS.md` 已建立，Primary/子 Agent 自动注入。
2. 5 个生命周期工具已注册且有工具级测试。
3. 高风险 git/gh 写操作收敛到工具，adversarial 测试确认拒绝绕过。
4. Runtime TDD 门禁生效：缺 evidence 的 PR 被拒。
5. backend/frontend 合并为 developer，skills 收敛为 8 个。
6. FlowRun cabinet/manifest/task md/handoff 死代码删除或迁移。
7. 既有 468 个测试 + 新增对抗测试全部通过。
8. 版本按 major 提升（0.3.2 → 1.0.0），通过 GitHub Actions release workflow 完成发布。

## 风险

| 风险 | 缓解 |
|------|------|
| 重构删除大量死代码导致回归 | 保留测试作为规格，逐批删除并保持 468 测试通过 |
| 权限规则不生效导致门禁可绕过 | 用 OpenCode 当前 permission 语义落地并 adversarial 测试 |
| 旧 Flow 用户困惑 | major 版本清晰提示 legacy FlowRun，不自动迁移 |
| 自动 merge 风险 | 分支保护 + required checks + 高风险人类 approval |
| 工具执行 GitHub 写操作认证失败 | 复用现有 gh auth，工具内部调用 gh CLI |

## 相关文档

- `CONTEXT.md`（根）：领域术语权威。
- `AGENTS.md`（根）：项目规则 + Project Profile。
- `docs/adr/0002-adopt-thin-workflow-kernel.md`：架构决策。

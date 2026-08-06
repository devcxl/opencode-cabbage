# ADR 0009: 场景分诊编排、Research 子 agent 与子 agent 技能隔离

**状态:** Accepted（2026-08-06）
**日期:** 2026-08-06
**上级:** [ADR 0002](/adr/0002-adopt-thin-workflow-kernel)（薄工作流内核 / 纯 Prompt + goal 架构）

## 背景

opencode-cabbage 的 `@dev-lifecycle` 是一条**单线、面向新功能开发**的流水线（`setup → requirements → design → tasks → code → review → release`），对 Bug 修复、紧急修复（hotfix）、业务调整、重构、技术债、基础设施、文档、回滚等常见场景强制套用重量模型，适用性不足。同时：

- `flow-requirements` 的决策映射定义了 `Research` 型 Ticket，但**无执行者**，调研落空。
- 子 agent（architect/developer/reviewer/goal-verify）可加载**任意** skill，无职责边界，易越权加载无关技能。
- 需求 / 设计阶段如需技术可行性调研，无专门承接。

## 决策

采用「场景分诊编排 + 独立 Research 子 agent + 子 agent 技能隔离」架构：

1. **`dev-lifecycle` 升级为场景分诊编排器**：新增 **Phase 0 场景分诊**，内联权威路由表（新功能 / Bug 修复 / 紧急修复 / 业务调整 / 重构 / 技术债 / 基础设施 / 文档 / 回滚 / 调研），按输入特征分派到「完整功能流」或「轻量路径」；轻量路径复用 `flow-tdd`/`flow-code`/`flow-review`/`flow-release` 与 goal 工具，跳过 requirements/design/tasks 重量模型。
2. **新增 `@researcher` 子 agent + `flow-research` skill**：独立承接 Research 型 Ticket 与调研场景，产出 `docs/dev/research/<topic>.md`；方法论融合 `research`（后台核查、一手来源）、`deep-research`（迭代深化、来源评分、反方搜索、置信度、元评审）、`deep-thinking`（决策自检）。
3. **异常处理接入 `@deep-think` 升级**：Task 失败重试 3 次后、以及连续 continuation 无可验证进展时，先派发更强模型系统审视根因与替代方案，再 Pause 求助。
4. **子 agent 技能隔离**：通过 OpenCode agent `permission.skill`（模式→动作）默认 `deny` 全部 skill，仅放行各自归属技能；`tools` 布尔已废弃，改用 `permission.skill`。
5. **非功能场景 SOP 文档化**：写入 `docs/guides/sops/`（一场景一文档），作为人工参考，**不随插件分发**；运行时权威分派逻辑在 `dev-lifecycle` Phase 0。

## 备选方案

| 方案 | 说明 | 否决理由 |
|------|------|---------|
| 新增独立 primary 路由器 agent | 由 `@flow-router` 判断输入并转发 | 每会话仅一个 primary 槽位，新增产生入口歧义；分诊本质是决策，作为 dev-lifecycle 首个 Phase 更自然 |
| Research 并入 `@architect` | 不加新 agent，architect 加载调研 skill | 用户明确要求独立 Research subagent；调研与设计职责分离更清晰 |
| 用 agent `tools` 布尔限制技能 | `tools: { "<skill>": false }` | schema 标注 `tools` 已废弃，官方改推 `permission` 字段；且 `permission.skill` 支持模式匹配更精确 |
| 一 SOP 一 skill 全量实现 | 为 hotfix/docs/rollback 也建独立 skill | YAGNI：这些场景由编排 + 复用现有 skill 足够，单独建 skill 过度设计 |

## 后果

- **正向**：开发生命周期从「仅功能流」扩展为「多场景 + 轻重两级」，常见非功能场景有明确路径。
- **正向**：Research 型 Ticket 有独立执行者，调研产出结构化、可追溯。
- **正向**：子 agent 职责边界清晰，技能隔离降低越权加载与上下文污染。
- **风险**：`permission.skill` 依赖 OpenCode 运行时的 skill→模式匹配语义，弱模型可能绕过——缓解：prompt 内显式声明技能归属 + prompt-lint 校验资产一致性。
- **风险**：新增 Research 能力后 skill 由 8 → 9，需同步更新收敛测试——缓解：`test/skills.test.ts` 已更新期望清单。
- **风险**：场景分诊依赖模型判断输入类型，可能误判——缓解：无法确定时暂停询问用户，不擅自选择。

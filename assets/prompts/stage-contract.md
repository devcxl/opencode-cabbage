# Stage Contract

Flow 阶段契约的单一来源。Primary（`dev-lifecycle`）与所有 stage 命令（`/setup /requirements /design /tasks /code /review /release`）共享本契约。

## 阶段模型

| Stage | 阶段名（flow_control） | 产出 | 工具 |
|-------|----------------------|------|------|
| setup | —（前置初始化） | Profile 确认、workflow 就绪 | `setup_control` |
| requirements | `requirements` | PRD、Decision Map、Flow Record、CONTEXT.md 术语 | `flow_control{create-flow}` |
| design | `design` | 技术方案 + ADR（Planning Baseline） | `flow_control{planning-start, planning-pr}` |
| tasks | `tasks` | DAG 任务定义、Sub Issues | `task_control{create-task}` |
| code | `code` | 实现 + TDD evidence + PR | `task_control{start-task, submit-task}` |
| review | `review` | 审查报告、合并 | `task_control{submit-review, merge-task}` |
| release | —（手动） | 版本、Release PR、GitHub Actions 发布 | `release_control` |

## 完成权威

- **阶段完成 = Flow Record（Parent Issue）body checklist 中的 `- [x] <stage>`**
- 阶段推进由 `flow_control{op:"stage-start"|"stage-complete"}` 维护：start 打 `cabbage:stage:<name>` label，complete 标记 checklist
- 已完成阶段重复 start/complete → 幂等通过

## 门禁规则

| 场景 | 要求 |
|------|------|
| stage-start X | 前置阶段须已 completed（requirements 无前置） |
| stage-complete X | 前置阶段须已 completed；**requirements 完成需用户确认一次** |
| stage-start tasks（高风险 Flow，label `cabbage:risk:high`） | 需用户确认（`user_confirmed: true`） |
| 依赖 Task 启动 | 前置依赖 Task 已 merged、并行数 < 5 |

## 阶段顺序与基线

```
setup → requirements → design → tasks → code → review → (release 手动)
```

- **Planning Baseline**：CONTEXT.md + PRD + Design + ADR 经单个 Planning PR 合入后，才允许创建 Task Record
- **requirements 基线**：需求阶段结束须用户确认一次
- **goal 最小化**：`goal({op:"create", parent_issue_number:<Flow Record 编号>})`，目标/验收从 Flow Record 读取

## 各阶段关键约束

- **requirements**：渐进式澄清（Decision Map），一次只问一个问题；领域术语写入根 CONTEXT.md
- **design**：architect 在 planning worktree 产出文档；方案遵循工程原则（KISS/YAGNI/DRY/SRP）
- **tasks**：垂直切片、可独立验证、无循环依赖；标题用英文功能标题（内核派生 slug）
- **code**：TDD 协议唯一来源是 `flow-tdd` skill；证据经 `tdd_checkpoint` 提交，缺证据 PR 被拒
- **review**：双轴审查（规范 + 规格）+ TDD criterion coverage；reviewer 只读，写操作经 `task_control`
- **release**：人工流程；按 Profile 版本规则 + 项目 GitHub Actions release workflow（技术栈无关）

## Prohibited Actions

- 不跳过前置门禁直接 stage-start/complete
- 不手工修改 Flow Record 的 stage checklist（由 flow_control 维护）
- 不绕过工具直接执行高风险 git/gh 写操作（push/PR/merge/worktree）

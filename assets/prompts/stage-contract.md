# Stage Contract

Flow 阶段契约的单一来源。Primary（`dev-lifecycle`）与所有 stage 命令（`/setup /requirements /design /tasks /code /review /release`）共享本契约。

## 阶段模型

| Stage | 产出 |
|-------|------|
| setup | Profile 确认（根 AGENTS.md Project Profile）、workflow 就绪 |
| requirements | PRD、Decision Map、Parent Issue（Flow Record）、CONTEXT.md 术语 |
| design | 技术方案 + ADR（设计基线，经 PR 合入） |
| tasks | DAG 任务定义、Sub Issues |
| code | 实现 + PR（TDD 由 flow-tdd 约束，测试质量由 CI 把关） |
| review | 审查报告、合并 |
| release | 版本、Release PR、GitHub Actions 发布（手动） |

## 完成权威

- **阶段完成 = Parent Issue（Flow Record）body checklist 中的 `- [x] <stage>`**
- 阶段推进由编排器在完成阶段产出后更新 checklist（`gh issue edit`）

## 门禁规则

| 场景 | 要求 |
|------|------|
| 开始 stage X | 前置阶段须已 completed（requirements 无前置） |
| 完成 stage X | 前置阶段须已 completed；**requirements 完成需用户确认一次** |
| 依赖 Task 启动 | 前置依赖 Task 已合并 |
| code 阶段开始 | 设计基线已合入 |

## 阶段顺序与基线

```
setup → requirements → design → tasks → code → review → (release 手动)
```

- **设计基线**：CONTEXT.md + PRD + Design + ADR 经 PR 合入后，才允许拆解任务
- **requirements 基线**：需求阶段结束须用户确认一次
- **goal 最小化**：`goal({op:"create", parent_issue_number:<Parent Issue 编号>})`，目标/验收从 Parent Issue 读取

## 各阶段关键约束

- **requirements**：渐进式澄清（Decision Map），一次只问一个问题；领域术语写入根 CONTEXT.md
- **design**：方案遵循工程原则（KISS/YAGNI/DRY/SRP）；产出经 PR 合入
- **tasks**：垂直切片、可独立验证、无循环依赖；标题用英文功能短语（kebab-case）
- **code**：TDD 协议唯一来源是 `flow-tdd` skill；测试质量由仓库 CI 把关
- **review**：双轴审查（规范 + 规格）；reviewer 只读，写操作由 primary 编排器执行
- **release**：人工流程；按 Profile 版本规则 + 项目 GitHub Actions release workflow（技术栈无关）

## Prohibited Actions

- 不跳过前置阶段直接推进
- 不伪造阶段完成（实际产出后再勾选 checklist）
- 不手工修改已完成阶段的 checklist
- reviewer/goal-verify 等子 agent 不直接执行写命令（push/PR/merge 由 primary 编排器执行）

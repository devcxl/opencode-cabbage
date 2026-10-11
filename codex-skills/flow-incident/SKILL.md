---
name: flow-incident
description: Document production incidents and postmortems — incident timeline, impact, containment and recovery, blameless root cause, corrective actions grounded through the built-in Cabbage engine. Use for outages, severity events, live-service failures, or writing a postmortem retrospective.
---

# flow-incident

处置生产事故时，先止损、再取证、后复盘。**不要在事故进行中伪造完整时间线或结论。**

## 流程（经内置引擎）

```text
cabbage({op:"new", type:"incident", change:"payment-timeout-2026-08-29"})
cabbage({op:"next", change:"payment-timeout-2026-08-29"})        # 阶段：incident → postmortem → tasks
# 1. 记录事实：填写 incident.md
cabbage({op:"verify", change:"payment-timeout-2026-08-29", stage:"incident"})
# 2. 分析根因：填写 postmortem.md
cabbage({op:"verify", change:"payment-timeout-2026-08-29", stage:"postmortem"})
# 3. 预防措施落地：完成任务清单
cabbage({op:"verify", change:"payment-timeout-2026-08-29", stage:"tasks"})
cabbage({op:"gate", change:"payment-timeout-2026-08-29", target:"merge"})
# 合并确认后：
cabbage({op:"archive", change:"payment-timeout-2026-08-29"})
```

阶段 ID 以 `next` 输出为准：`incident` → `postmortem` → `tasks`。前两个阶段是事实与分析，第三个阶段是实际修复与预防措施。

**分级降载**：正在处置的紧急故障不要为了走流程而拖延止血。先经 `flow-change` 走最小修复路径
（`type:"change"` + 声明 `deployment=true`），事后另立 incident 记录复盘；不要把两者混在同一记录里。

## incident.md：先记事实

必需标题 `Impact` / `Timeline` / `Mitigation`。

- 时间戳统一用 UTC 或明确标注时区；事故期间先记原始观测，不追求措辞。
- `Impact` 量化受影响用户数、时长、区域、功能、数据与 SLO 影响；无法量化时写估计方法与误差。
- `Timeline` 记录事件、观测与采取的行动及其执行人，包括误判和无效尝试。
- `Mitigation` 区分 **Containment**（如何限制影响，如回滚、摘流量、限流）与 **Recovery**（如何恢复，
  及仍然降级的行为）。
- 恢复后补 `Recovery Verification`：证明恢复的指标、检查项与观察窗口。
- 不要写"疑似"当结论；不确定的内容标注为待确认。

## postmortem.md：对事不对人

必需标题 `Root Cause` / `Contributing Factors` / `Corrective Actions`。

- 区分 **触发点**（直接原因）与 **根因**（使其可能且未被拦截的系统条件）。
- 根因结论要有证据支撑：日志、指标、变更记录、复现步骤，而非推测。
- `Corrective Actions` 每项必须有单一责任人、期限、验证方式与状态；笼统的"加强监控""提高意识"
  不是可验证的措施。
- 保持无责文化：记录系统为何允许人为错误造成影响，不记录个人过失。

## tasks.md：预防措施落地

`postmortem.md` 中的措施要落到实际任务，完成并验证后才通过阶段。
只写计划不执行会阻塞合并门禁，这是刻意的：复盘结论必须兑现。

## 边界

- 事故记录与变更记录都属于决策历史，归档后不重写、不"现代化"措辞。
- 当前系统的运行方式写到长期运行文档；事故报告本身是历史记录。
- 结构校验只检查标题、占位符与链接，不判断根因分析是否正确；复盘质量仍需人工评审。

## Contract

### Trigger
生产事故、严重事件、线上服务故障的处置与复盘；或用户要求撰写事故报告时触发。

### Inputs
- 事故基本事实（时间、影响、止损与恢复过程）
- 证据材料（日志、指标、变更记录、复现步骤）

### Preconditions
- 事故已止血或已恢复（进行中不写完整复盘）
- 项目已初始化（无 `.cabbage/` 时先经 `flow-change` 执行 `op:"init"`）

### Procedure
1. `op:"new" type:"incident"` 创建记录并如实填写 incident.md（Impact/Timeline/Mitigation）
2. 验证 incident 阶段后撰写 postmortem.md（根因、促成因素、纠正措施）
3. 将纠正措施落成 tasks.md 清单并实际执行
4. 逐阶段 `verify` → `gate merge` → 合并确认后 `archive`

### Outputs
- `.cabbage/changes/<id>/`：incident.md、postmortem.md、tasks.md（验证后签名）
- 归档后：`.cabbage/archive/<year>/<id>/`

### Failure
- 时间线/证据不完整 → 标注待确认，不编造；补齐后重新验证
- 措施无法在本次完成 → 转入独立变更（flow-change）跟踪，本记录如实标注状态

### Idempotency
- 重复 `verify` 未变化阶段 → 幂等
- 事故期间多次追加时间线 → 更新产物后重新验证

### Prohibited Actions
- 不在处置进行中伪造完整时间线或根因结论
- 不把紧急修复与事故复盘混在同一记录
- 不将未执行的预防措施勾选为完成

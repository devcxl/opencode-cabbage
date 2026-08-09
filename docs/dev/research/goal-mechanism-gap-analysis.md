# Goal 机制差距分析:cabbage vs OpenChamber

> 日期:2026-08-09
> 背景:承接 `docs/dev/research/openchamber-goal-mechanism.md`(OpenChamber Session Goals 深度调研),本次对照本项目(opencode-cabbage)的 goal 设计做逐维度差距分析。
> 基线:OpenChamber main 2026-08-08 / v1.16.x;cabbage 当前工作区(version 1.1.0)。

## 结论摘要

两个系统的 goal 机制是**同一范式(服务端事件驱动续跑循环 + session metadata 状态 + 独立终止权威)下的两种实现**,但存在 4 个实质性差距和 2 个反超项:

| 级别 | 差距 | 影响 | 建议 |
|---|---|---|---|
| **严重** | 无子会话(child)活动检查 | idle 续接可能压过正在运行的 subagent(OpenChamber 为此修过专门 bug) | 续接前查 `/session/:id/children`,任一 busy 则跳过 |
| **严重** | 无"卡住/blocked"检测与状态 | 卡点空转续接直到 50 次上限,烧 token 无告警 | 加无进展检测(连续 N 轮无工具调用/无 diff → pause),或 continuationPrompt 要求显式报告卡点 |
| 中等 | 无 token 记账与预算 | 长跑成本不可控 | 可选:GoalData 增加 tokenBudget,用消息 tokens 快照记账 |
| 中等 | 续接先发后写(计数) | 崩溃窗口:prompt 已发、计数未写 → 重启 autoResume 双发 | 镜像 OpenChamber 先写后跑,或 autoResume 跳过"刚续接过"的会话 |
| 轻微 | 无静默窗口与尾部 quiescence 检查 | 假 idle(工具间隙)可能过早续接 | 续接前检查尾部消息(最后是 user 或 assistant 未完成 → 跳过) |
| 轻微 | 无目标编辑操作 | 中途改目标只能 cancel 重建 | 增加 edit op(保留 id/计数,参考 OpenChamber 语义) |
| — | **反超:autoResume 启动扫描** | OpenChamber 无此机制(第三方 teardown 点名批评的持久性缺口) | 保持,注意双写一致性与双发风险 |
| — | **反超:goal-verify 证据型验证** | 终止权威带测试/文件证据,优于 OpenChamber 的纯文本审计 | 保持,建议补"周期性自动派发" |

**一句话**:cabbage 的"终止权威"(goal-verify 带证据验证)比 OpenChamber 的小模型审计更可靠,但**循环的"过程保护"弱于 OpenChamber**——缺子会话闸、缺 blocked 检测、缺预算,这三项是续接循环最容易翻车的地方。

---

## 1. 双方机制对照表

| 维度 | OpenChamber Session Goals | cabbage goal 机制 | 差距 |
|---|---|---|---|
| 循环位置 | OpenChamber server(独立进程,SSE hub 订阅) | OpenCode 插件内 event hook(agent 进程内) | 等价(都在 agent 之外) |
| 状态存储 | `metadata.openchamber.goal`(JSON,含 id/记账/streak) | `metadata.goal` = `{parentIssueNumber, status, continuationCount, sessionProfile}` | cabbage 更轻;OpenChamber 更富 |
| 目标来源 | metadata 内联 ≤5000 字符 或 文件 `<data-dir>/goals/<sid>.md`,可中途编辑 | **Flow Record(Parent Issue body)**,外部单一事实源,不可经 goal 编辑 | 设计不同:cabbage 更强外部化,弱可编辑性 |
| 触发 | idle + **15s 静默窗口**;kickoff 3s/250ms;abort 立即暂停 | idle **立即**续接;abort 标记 → 续接时暂停 | **cabbage 无静默窗口** |
| 尾部 quiescence 检查 | 有(尾部 user 消息/未完成 assistant → bail) | 无(只有 abort 二次检查 + inFlight 去重) | **cabbage 缺失** |
| 子会话活动闸 | 有(a56584b 专门修复:children busy → 跳过审计) | 无(只跳过有 parentID 的会话本身) | **cabbage 缺失,严重** |
| 终止权威 | 独立小模型审计(continue/complete/blocked,3 连败 blocked) | **goal-verify 子 agent**(读文件/跑测试/证据分类 SATISFIED) | 哲学不同:cabbage 证据更强但需派发,OpenChamber 全自动但凭文本 |
| blocked 语义 | blocked(3 连败 / turn error / 审计失败 2 连)/ budgetLimited | 无 blocked;仅 pause(abort/50 次上限) | **cabbage 缺卡点检测** |
| turn error 处理 | assistant turn error → blocked | 未处理(仅 MessageAbortedError → paused) | **cabbage 缺普通错误停** |
| token 记账 | 快照记账(input+cache.read+output − baseline)+ budget | 无 | **cabbage 缺预算护栏** |
| 续接上限 | MAX_AUTO_TURNS=20(Resume 重置) | MAX_CONTINUATIONS=50(resume/user 消息重置) | 数值差异,cabbage 更宽松 |
| compaction | 识别 summary:true 分段记账,跳过审计续跑 | 每 20 次续接主动发 `[compact]` prompt | 主动 vs 被动,各有取舍 |
| 重启恢复 | **无启动扫描**(事件驱动,teardown 批评的缺口) | **autoResume 扫描 session-index 并 promptAsync** | **cabbage 反超** |
| 持久化 | 单一事实源(metadata),无索引 | metadata + `.opencode/opencode-cabbage/session-index.json` 双写 | 双写一致性风险 vs 单写恢复缺口 |
| 幂等/并发 | stale-write guard by goal id;先持久化后 prompt(先写后跑) | KeyedMutex 串行;先 prompt 成功才计数(先发后写) | **顺序相反,各有崩溃窗口** |
| 续接参数 | 最后非-summary assistant 消息的 provider/model/agent/variant | sessionProfile 快照(用户最后选择) | 设计意图不同 |
| 目标/审计输入 | 目标+最后回复,≤6000 字符,语言锁定,JSON 容错解析 | goal-verify 从头读 Flow Record + 文件证据 | cabbage 输入更全,成本更高 |
| 完成通知 | settle 通知(desktop/web-push/APNs),抑制 ready 通知 | 无 | 插件环境无 push 通道 |
| UI | strip/靶心按钮/侧栏 glyph/评估模型展示/对话框 | 工具文本返回(无 UI) | 平台差异,低优先 |
| 目标编辑 | 支持(edit objective/budget,保留 id 与记账) | 无(仅 cancel 重建) | **cabbage 缺 edit** |
| 权限 | goal 由 UI/服务端写,audit 强制 restrictToPreferredProvider | goal 工具仅 dev-lifecycle/goal-verify;子 agent 禁 lifecycle;complete 仅 goal-verify | cabbage 更严(agent 授权模型不同) |
| 测试 | runtime.test.js(4)/create.test.js | goal-tool.test.ts(254 行)/server-permissions.test.ts | 均有覆盖 |

---

## 2. 详细差距分析(按影响排序)

### 2.1 严重:无子会话活动检查 —— 续接会压过运行中的 subagent

**证据**:server.ts:301-315,idle 事件处理只做 `parentID` 检查(跳过子 agent 会话本身),然后直接 `queueContinuation`;`queueContinuation`(server.ts:69-136)全程不查 children。而 OpenChamber 的 DOCUMENTATION.md 明确:"A background subagent leaves its parent idle, then injects its result into the parent when done; that parent busy → idle cycle re-arms the loop"(后台 subagent 运行时父会话保持 idle!),并为此提交 a56584b "gate session goal audits on live child activity" 修复了"父 idle 时子会话仍在工作却去审计/续接"的问题。

**影响**:cabbage 在"主会话派了 @developer/@reviewer 子代理、等待结果"的空窗期(父会话 idle),会立即对父会话发续接 prompt —— 与子代理结果注入父会话产生竞争,轻则噪音/重复工作,重则续接把会话带向另一个方向。**这是本项目中实际会发生的高频场景**(Flow 编排大量依赖子代理)。

**建议**:在 `queueContinuation` 的 mutateGoal 回调内(或之前),调用 `client.session.children({ sessionID })` 查询直接子会话状态,任一 busy/retry 则跳过本次续接(等待子代理结果注入父会话后产生的下一次 idle 事件重新触发)。成本:一次 API 调用 + 5 行代码。

### 2.2 严重:无"卡住"检测 —— 卡点空转续接直到 50 次上限

**证据**:GoalData 状态只有 active/paused/complete(goal.ts:12);续接条件只有 3 个硬停止(abort、50 次上限、无 goal)(server.ts:80-97)。OpenChamber 有:3 连败 blocked、turn error → blocked、审计失败 2 连 → blocked、budgetLimited;且审计 prompt 强制 agent"无法推进时必须陈述阻塞条件"。

**影响**:agent 卡在"需要用户决策/凭据缺失/外部失败"时,cabbage 会继续注入续接 prompt,agent 每轮重复同样的话,直到 50 次上限(空转成本)或用户注意到。Codex /goal 社区已反复踩过同类坑(#22362"goal 一直续跑但等审批"、#23177"blocked 时死循环烧 token")。

**建议(两档)**:
- 低配:continuationPrompt 增加"若无法推进,必须在回复开头输出 `[BLOCKED: <原因>]`;插件检测到该标记 → 将 goal 置为 paused 并提示用户"。成本:prompt 一行 + 事件/消息内容检测 ~10 行。
- 高配:无进展检测 —— 每轮续接后对比最新 assistant 消息(无工具调用、无文件变更、文本高度重复)→ 连续 N 次(如 3 次)→ paused。OpenChamber 用独立审计达成同样目的,但 cabbage 场景下"无进展启发式"更便宜且够用。

### 2.3 中等:续接先发后写 —— 崩溃窗口会双发续接

**证据**:server.ts:121-127,先 `promptAsync` 成功后才 `continuationCount++`(注释:"失败不消耗配额")。OpenChamber 相反(先持久化 accounting + turnsUsed,再 promptAsync,注释:"a crash after the write just waits for the next idle tick; the reverse could double-send")。cabbage 的 autoResume(server.ts:138-164)在插件重启时扫描 index,凡 status=active 的 flow 都会 promptAsync —— **若崩溃发生在 prompt 已发、计数未写之间,重启后 autoResume 会再发一次续接**。

**影响**:重复续接概率低(窗口毫秒级),但一旦发生会直接污染会话(agent 收到两条相同续接)。可回滚性:低危害但难察觉。

**建议**:改为先递增计数再 promptAsync(失败回滚计数),与 OpenChamber 对齐;或 autoResume 对"最近 30s 内更新过 continuationCount"的 flow 跳过。成本:3 行。

### 2.4 中等:无 token 记账与预算

**证据**:GoalData 无任何 token 字段;OpenChamber 有快照记账(`input + cache.read + output` − baseline,compaction 分段)+ tokenBudget → budgetLimited。

**影响**:长 goal(50 次续接 × 大模型)成本无护栏。OpenChamber 自己承认"预算只是护栏不是账单",cabbage 连护栏都没有。

**建议**:可选。若做,直接复用 OpenChamber 的快照法(利用 OpenCode 消息 tokens 的 cache.read 语义,不跨消息求和),在 `message.updated`(assistant 完成)事件上记账,GoalData 增加 `tokenBudget/tokensUsed`,达限 → paused + 提示。成本:1-2 天。

### 2.5 轻微:无静默窗口与尾部 quiescence 检查

**证据**:server.ts:301 idle 立即续接。OpenChamber 15s 静默 + tick 内检查"尾部是 user 消息或 assistant 未完成 → bail"(runtime.js:529-530)。cabbage 有 abort 二次检查(server.ts:113-118)与 inFlight 去重,但**没有检查消息尾部**。

**影响**:idle 事件与"用户刚发了消息/agent 流式输出未完全落盘"竞态时,可能过早续接。真实概率低(OpenCode idle 语义较稳),但 OpenChamber 之所以加 15s 窗口正是踩过此坑。

**建议**:在 queueContinuation 前拉一次最近消息,若尾部是 user 或 assistant 无 `time.completed` → 跳过。成本:~10 行。

### 2.6 轻微:无目标编辑操作

**证据**:goal 工具 op 只有 create/get/complete/resume/cancel/pause(goal.ts:152)。OpenChamber 支持编辑 objective/budget(保留 id 与记账,statusReason='resumed' 语义)。

**影响**:用户中途想调整目标/预算只能 cancel 重建,丢失 continuationCount 与绑定。低频场景。

**建议**:加 `edit` op(仅改 parentIssueNumber 与可选 budget,保留计数),若同时做了 2.4 才需要 budget 字段。成本:半小时。

### 2.7 轻微:无 turn error 处理(已由 [BLOCKED:] 报告机制覆盖)

**证据**:server.ts 事件处理只有 MessageAbortedError → abortedSessions;普通 assistant turn error(如 provider 500)不单独触发暂停。

**影响**:连续失败的会话会反复续接直到 50 次。**修复口径(2026-08-09)**:卡点检测统一由 `[BLOCKED:]` 报告机制承担(agent 在续接回复中显式声明无法推进 → 插件置 paused),不单独监听 error 事件暂停——error 与"需要用户输入"是不同语义,前者可能自愈,后者必须停。若实测发现 error 反复空转,再补 error 事件 pause。

---

## 3. 本项目反超项(保持,勿回退)

### 3.1 autoResume 启动扫描 —— 解决 OpenChamber 最大短板

OpenChamber 被 OpenAgents teardown(2026-07-12)点名批评:"纯事件驱动、无启动扫描/回填,定时器与 in-flight 全内存,重启后已 idle 的 active goal 永远不会重新武装,除非有新事件"。cabbage 通过 `session-index.json`(parentIssue → sessionID 磁盘索引)+ 启动扫描 autoResume 直接解决了这个问题。**这是架构级领先,差距为负**。

代价是双写一致性:metadata.goal 与 index 各自独立更新,存在不一致窗口(如 goal cancel 时 removeFlowSession 失败被 catch 吞掉,goal.ts:240-244 → index 残留 active → 重启 autoResume 恢复一个已取消的 goal)。建议:把 index 清理失败改为告警日志(当前 silent catch),或在 autoResume 时以 readGoal 实际状态为准(已有此逻辑:server.ts:144-147 会检查 goal 是否 active,不 active 则置 paused —— 已正确兜底)。

### 3.2 goal-verify 证据型验证 —— 终止权威质量更高

OpenChamber 的审计器只看"目标 + 最后回复文本"(无历史、无类型化证据),误判风险靠 3 连败兜底;teardown 批评"model prose must not be sole acceptance authority"。cabbage 的 goal-verify 是只读子代理,读完整文件、跑测试/构建/lint、逐项 SATISFIED/NOT SATISFIED/UNCERTAIN 分类后才 complete —— **证据强度显著更高**。

代价:完成判定不是每轮自动做的(需要 dev-lifecycle 派发或 agent 自觉),存在"目标实际已完成但无人验证 → 继续续接"的窗口。建议(中等价值):在续接循环里每 N 次(如 5 次)自动派一次 goal-verify 检查可完成性,与 2.2 的无进展检测配合,形成"过程防空转 + 终点防漏判"。

> **实现注(2026-08-09)**:验证 SDK 后确认插件无"创建子 agent 会话"的 API(fork+promptAsync 可建子会话,但结果不会自动注入父会话,需自建轮询/解析/判定循环,且与「仅 goal-verify 可 complete」授权模型冲突)。故 P2 采用对称轻量方案:**[DONE:] 完成报告协议**——continuationPrompt 要求 agent 在验证(测试/构建)通过时输出 `[DONE: 摘要]`,插件检测到即置 paused,由 dev-lifecycle/用户派 goal-verify 做最终独立验证(complete 授权不变)。完成侧空转窗口由「agent 主动报告 + 暂停提示」覆盖,代价是依赖 agent 自觉(与 blocked 机制同一信任模型)。若实测发现 agent 频繁漏报,再评估重型自动验证循环。

---

## 4. 可执行改进清单(按优先级)

> 更新(2026-08-09):P0/P1 六项已实现并测试通过(TDD 9 cycles,211 tests 全绿),见 commit 86edf08。P3(edit op)与 P2 轻量替代([DONE:] 完成报告协议)已实现,见 commit 81fe89d + 审查修复 2620fda。

| # | 改进 | 对齐对象 | 成本 | 风险 | 状态 |
|---|---|---|---|---|---|
| P0 | queueContinuation 前查 children,任一 busy 跳过 | OpenChamber a56584b | ~5 行 | 低(纯跳过) | ✅ 已实现(server.ts hasWorkingChildren) |
| P0 | continuationPrompt 加"无法推进必须输出 [BLOCKED: 原因]"指令 + 检测后 pause | OpenChamber blocked 语义 | ~15 行 | 低 | ✅ 已实现(isBlockedReport + resume 豁免) |
| P1 | 续接顺序改为先计数后 prompt(或 autoResume 去重) | OpenChamber 先写后跑 | ~3 行 | 低 | ✅ 已实现(两阶段 + 失败回滚) |
| P1 | 尾部 quiescence 检查(最后消息 user/未完成 → 跳过) | OpenChamber tick | ~10 行 | 低 | ✅ 已实现 |
| P1 | turn error(非 abort)事件 → pause | OpenChamber blocked | ~5 行 | 低 | ✅ 已实现([BLOCKED:] 报告覆盖卡点检测) |
| P2 | 完成侧闭环:[DONE:] 完成报告协议(agent 验证通过 → pause 等待 goal-verify) | 无对应(反超方向) | ~20 行 | 低 | ✅ 已实现(轻量替代"自动派发",见 §3.2 注) |
| P2 | tokenBudget/tokensUsed 快照记账(可选) | OpenChamber 记账 | 1-2 天 | 中 | ✅ 已实现(create baseline + tick 记账 + 预算 pause + reasoning 计入) |
| P3 | goal edit op | OpenChamber | 半小时 | 低 | ✅ 已实现(改预算/传 0 移除/换 Flow 重置记账+rebind;complete 只读) |
| P4 | autoResume 重启双发防护(30s 窗口跳过) | 自研 | ~3 行 | 低 | ✅ 已实现 |

**不建议照搬**:小模型每轮审计(成本高、凭文本、与 goal-verify 证据验证重复)、15s 静默定时器(OpenCode idle 语义足够稳,加尾部检查即可)、通知体系(插件无 push 通道)、stale-write by goal id(单 goal 场景 + KeyedMutex 已够)。

---

## 5. 不确定性(元评审)

- **children API 可用性未验证**:OpenCode SDK v2 是否有 `session.children` 接口、返回结构如何,需在实现 P0 时用 SDK 类型确认(OpenChamber 用的是 HTTP `/session/:id/children`,SDK 大概率有对应方法)。
- **"后台 subagent 使父会话 idle"在 cabbage 的 OpenCode 版本上是否同样成立**未实测——若 OpenCode 已把子代理期间父会话置为 busy,则 P0 无必要;建议实现前用一次真实子代理运行 + 事件日志验证。
- **无进展检测阈值**为经验值,需实测调参,避免误杀"慢但有效"的长任务。
- 本分析基于源码静态阅读,未运行任何端到端场景验证差距的实际触发频率。

---

## 参考来源

- OpenChamber 机制调研:`docs/dev/research/openchamber-goal-mechanism.md`(2026-08-09)
- 本项目源码:`src/plugin/goal.ts`、`src/plugin/server.ts`(queueContinuation/autoResume/事件处理)、`src/kernel/session-index.ts`
- 本项目文档:`docs/guides/architecture.md`("Goal 状态机""事件驱动""弹性设计"节)、`assets/agents/team/goal-verify.md`
- OpenChamber 反方证据:OpenAgents teardown(2026-07-12)、commit a56584b、DOCUMENTATION.md

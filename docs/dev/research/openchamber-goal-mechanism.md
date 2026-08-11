# OpenChamber Session Goals 机制深度调研

> 调研日期:2026-08-09
> 范围:openchamber/openchamber 的 Session Goals 功能(服务端自治目标循环)的架构、实现、演进与风险
> 方法:一手源码(clone main 分支,`packages/web/server/lib/session-goal/` 全模块)+ 官方文档 + GitHub issue/PR + 第三方 teardown,共 2 轮迭代

## 研究结论摘要

OpenChamber 的 goal 机制(官方名 **Session Goals**,v1.16.0 于 2026-07-13 引入)是一个**完全运行在 OpenChamber web server 上、叠加在 OpenCode 会话之上的"审计-续跑"控制循环**。核心是 5 个设计决策:

1. **零侵入 OpenCode**:不 patch OpenCode 本体,只通过其公开 HTTP API 读写(`PATCH /session/:id` 的 metadata、`GET /session/:id/message`、`/session/status`、`/session/:id/children`、`POST /session/:id/prompt_async`),并由 OpenChamber 自己的全局 SSE hub 转发 OpenCode 事件驱动循环。
2. **状态即 metadata**:goal 状态全部存于 `session.metadata.openchamber.goal`(JSON payload),天然随 `session.updated` 事件同步到所有客户端、且随 OpenCode 会话持久化;每次写入前重读 session 并按 goal `id` 做 stale-write 防护。
3. **独立小模型审计是唯一终止权威**:每轮空闲后由小模型(auditor)对「目标 + 最后一条 assistant 回复」输出 `continue/complete/blocked` JSON;工作 agent 没有任何渠道自己终结 goal。blocked 需连续 3 次、审计失败容忍 1 次连续未审计续跑。
4. **硬停止优先于审计**:turn error → blocked、token budget → budgetLimited、自动续跑上限 20 次 → blocked、用户 abort → paused(不阻塞)。用户显式 stop/暂停永远赢过循环。
5. **记账用"快照"而非累加**:因 OpenCode 每轮的 `cache.read` 已包含前序全部付费 token,最新完成轮次的 `input + cache.read + output` 即整轮成本;以 goal 创建前的最后一轮为 baseline,compaction 分段(tokensCommitted)。

**核心风险**(反方证据):循环是纯事件驱动的,无启动扫描/回填、无持久化续跑租约(lease/outbox/reaper),服务器重启后"已 idle 的 active goal"可能不再自动续跑;审计判据只有 agent 自己的文本报告,无类型化证据;审计器曾对 `{env:VAR}` provider 配置不展开导致 401(已修复)。OpenAgents teardown 的结论:**"a good next-turn autonomy loop, not exact interrupted-turn recovery and not yet a durable workflow engine"**。

---

## 背景与问题定义

- **目标**:搞清楚 OpenChamber 的 goal 机制如何实现,包括状态模型、事件驱动循环、审计器、token 记账、创建/暂停/恢复路径、UI 集成、已知缺陷。
- **范围**:源码级实现(以 2026-08-08 的 main 分支为准)+ 演进历史 + 反方观点。
- **限制**:不评估 OpenChamber 产品其他功能;不比较所有竞品 goal 实现(仅作为反方类比提及)。
- **前置知识/假设**:读者熟悉 OpenCode(session/message/part/SSE 事件模型);OpenChamber 基于 `@opencode-ai/sdk/v2` 调用 OpenCode API。

## 研究方法

- **一手来源**:shallow clone `openchamber/openchamber` main 分支,完整读取 `packages/web/server/lib/session-goal/` 全部 7 个文件(runtime.js 832 行、create.js、objectives.js、routes.js、测试、DOCUMENTATION.md)+ 注册入口 `index.js` + `small-model/` 解析链 + `notifications/runtime.js` 抑制逻辑 + UI 侧 `sessionGoalActions.ts` / `session-ui-store.ts` / arm store。
- **官方文档**:`packages/docs/content/docs/session-goals.mdx`(用户文档)、`session-goal/DOCUMENTATION.md`(模块文档)。
- **演进证据**:CHANGELOG.md、相关 commit 信息(56cf5e2 / 7533c7a / a56584b / 7d596e4 / 6e93f58)。
- **反方证据**:OpenAgents teardown(2026-07-12)、GitHub issue #2269 + PR #2275、Claude Code / Codex / opencode 生态同类 goal 问题。
- **局限性**:shallow clone 无法拿到全部历史 commit;未能实际运行;审计质量无量化数据。

### 来源评分卡

| 来源 | 权威性 | 一手性 | 时效性 | 独立性 | 可验证性 | 综合 |
|---|---|---|---|---|---|---|
| session-goal/runtime.js(源码) | 5 | 5 | 5 | 5 | 5 | 25 |
| session-goal/DOCUMENTATION.md | 5 | 5 | 5 | 4 | 5 | 24 |
| session-goals.mdx 用户文档 | 4 | 5 | 5 | 4 | 4 | 22 |
| commit 56cf5e2(PR #2148) | 5 | 5 | 4 | 5 | 5 | 24 |
| CHANGELOG.md | 4 | 5 | 5 | 4 | 4 | 22 |
| issue #2269 + PR #2275 | 4 | 5 | 4 | 5 | 5 | 23 |
| OpenAgents teardown(2026-07-12) | 3 | 4 | 4 | 4 | 3 | 18 |
| 生态 issue(Claude Code #58900、Codex #22362 等) | 3 | 5 | 4 | 5 | 3 | 20 |

---

## 关键发现

### 1. 整体架构:server 侧"审计-续跑"循环,零侵入 OpenCode

**发现内容**:goal 机制不是 OpenCode 的功能,而是 OpenChamber server 在 OpenCode 会话之上叠的一个自治循环。循环注册在 `packages/web/server/index.js:736`(`createSessionGoalRuntime`),通过全局 SSE hub(`event-stream/global-hub.js` 的 `subscribeEvent`)接收 OpenCode 事件流,所有读写走 OpenCode HTTP API(`openCodeFetch` 封装,带 auth header 与 10s 超时)。

**关键事实**(源码 runtime.js:247-444):
- 循环订阅三类事件:`session.status`(idle/busy/retry)、`session.updated`(goal 变化)、`message.updated`(abort 检测,`error.name === 'MessageAbortedError'`)。
- 事件路径 `processPayload`(runtime.js:775):idle → 武装 15s 定时器;busy/retry → 清除定时器;新 goal(`turnsUsed === 0`)→ 3s kickoff;Resume(`statusReason === 'resumed'`)→ 250ms kickoff;abort → 立即暂停(防续跑压过用户 stop)。
- **无轮询、无启动扫描、无回填**(runtime.js:14-15 注释):"Only sessions that emit events while the server runs ever tick."

**依据**:runtime.js;index.js:815-823;DOCUMENTATION.md "Flow" 节。

**置信度:高**

### 2. 状态模型:`metadata.openchamber.goal` + 文件后端目标

**发现内容**:goal 状态是一个 JSON payload,存在 OpenCode session 的 metadata 下:

```
id, objective, objectiveFile, status(active|paused|blocked|budgetLimited|complete),
tokenBudget, tokensUsed, tokensBaseline, tokensCommitted, turnsUsed,
blockedStreak, auditFailStreak, note(≤280), statusReason(≤200),
evaluationProviderID, evaluationModelID, lastAccountedMessageID, createdAt, updatedAt
```

- 目标**文本**存文件 `<data-dir>/goals/<sessionId>.md`(`OPENCHAMBER_DATA_DIR` 或 `~/.config/openchamber/goals`),metadata 只带 `objectiveFile: true` 标志,永远不带路径(session id 经 `^[A-Za-z0-9_-]{4,128}$` 校验后才碰文件系统,防 metadata 注入成为文件读取向量)。
- 理由:metadata 随每次 `session.updated` 广播,大目标(≤5000 字符)不能放里面。
- 每次 tick 重读文件(目标可中途实时编辑),文件丢失回退内联 objective——"goal 绝不会因为文件没了而死"。

**依据**:DOCUMENTATION.md "Goal payload" 与 "File-backed objectives";objectives.js;create.js。

**置信度:高**

### 3. tick:静默窗口后的五道闸门

**发现内容**(runtime.js:446-739,tick 函数):
1. **会话闸**:跳过子 agent 会话(有 parentID 的)。
2. **实时活动复查**:idle 静默 15s 后重新拉 `/session/status`,父会话若 busy → 直接放弃等下一次 idle 事件;再拉 `/session/:id/children`,任一直接子会话 busy/retry → 放弃(后台 subagent 会让父会话保持 idle,完成后注入结果并产生新的 busy→idle 循环,因此无需轮询)。状态/子会话拉取失败视为 "unknown" 而非 "empty",跳过审计并重试下一个静默窗口。
3. **静默(quiescence)复查**:尾部是 user 消息或 assistant 未完成 → 放弃。
4. **记账**:见发现 4。
5. **终态检查**(最便宜优先):abort 尾部 → paused(除非 statusReason 是 'resumed' 的显式恢复);assistant turn error → blocked;`tokensUsed >= tokenBudget` → budgetLimited;`turnsUsed >= 20(MAX_AUTO_TURNS)` → blocked。
6. **审计**(见发现 5)。
7. **续跑**:先持久化记账与 `turnsUsed+1`(写失败则放弃——先写后跑,崩溃只会等下一个 idle tick,不会重复扣账),再重拉消息尾部确认没被用户插队,最后 `POST /session/:id/prompt_async` 携带续跑 prompt,provider/model/agent/variant 全部取自**最新的非 summary assistant 消息**(防止继承 compaction 的 agent='compaction'/summarize 模型)。

**依据**:runtime.js tick;runtime.test.js(4 个测试覆盖父 busy、子 busy、状态拉取失败重试、正常审计)。

**置信度:高**

### 4. token 记账:快照 + baseline + compaction 分段

**发现内容**(runtime.js:537-598):
- OpenCode 每消息上报 tokens,而**每轮的 `cache.read` 已携带此前所有轮次已付费的 input/output**,所以"整轮成本 = 最新完成 assistant 轮的 `input + cache.read + output`",是一个快照而非跨消息求和。
- 目标相对化:第一个 tick 记录 `tokensBaseline` = goal 创建时间前最新完成轮次的同一快照;`tokensUsed = tokensCommitted + max(0, 当前段快照 - baseline)`,单调不减(防 context shrink 让预算倒退)。
- compaction(summary: true 的 assistant 消息)破坏快照链 → 分段:summary 轮把当前段价值并入 `tokensCommitted` 并重置 baseline 为 0(summary 轮自身读取了全量上下文,其快照即为压缩成本;但 summary 消息上报的 tokens 被 OpenCode 归零,因此用"此前已展示的 tokensUsed 作为连续性下限",防止计数器冻结在压缩前数值)。
- **已承认的缺口**(DOCUMENTATION.md Limitations):只统计单次 tick 的 40 条消息窗口内已完成的 assistant 消息;超长 busy 间隔会低估(token budget 是护栏不是账单)。

**依据**:runtime.js;DOCUMENTATION.md;commit 7533c7a(compaction 记账修复,真实长跑观察)。

**置信度:高**

### 5. 审计器:小模型是唯一终止权威,带三层防御

**发现内容**(runtime.js:105-148, 362-422):
- 审计输入:**仅** objective + 最后一条 assistant 轮的文本(截断 6000 字符)+ 审计 system prompt;**没有**对话历史、没有续跑 prompt。
- 审计 system prompt 规则:complete 仅当"最新回复包含每个需求的**可验证证据**";blocked 仅当"无用户输入则无法推进"(缺凭据/缺决策/硬外部失败);否则 continue;note ≤20 词且**必须与 objective 的语言一致**。
- JSON 解析容错(`extractJsonObject`):支持 code fence、散文包裹、从头扫描 `{}`。
- **语言防幻觉**:note 若出现 objective 与回复中都没有的文字体系(Cyrillic/CJK/Devanagari/Arabic),丢弃 note 保留 verdict。
- 审计通过 `generateSmallModelText({ restrictToPreferredProvider: true, preferredProviderID/ModelID: 取最后 assistant 消息 })` 执行:**强制留在会话自己的 provider**(会话外的内容不泄露给其他 provider),除非用户显式设置(settings override / opencode config / 请求指定)。
- 小模型解析链(small-model/resolve.js):OpenChamber settings 覆盖 → opencode config `small_model` → Copilot utility models(`gpt-5.4-nano` 等)→ 家族优先级扫描(`gemini-flash` > `gpt-nano` > `claude-haiku`)。
- **终止与容错**:complete → settle;blocked 需连续 3 次(`BLOCKED_STREAK_LIMIT`);审计失败容忍 1 次连续未审计续跑,第 2 次(`AUDIT_FAIL_LIMIT=2`)→ settle blocked "progress audit unavailable"(可恢复,resume 重置 streak);审计缺失时循环仍会因 budget 与 turn cap 终止——"死掉的小模型不能把循环盲开到 turn cap"。
- **compaction 例外**:最后一条是 summary → 跳过审计无条件续跑("撞进上下文窗口本身就是未完成证明")。

**依据**:runtime.js runAudit/tick;small-model/index.js:120-135(restrictToPreferredProvider 语义);DOCUMENTATION.md。

**置信度:高**

### 6. 创建与暂停/恢复路径

**发现内容**:
- **UI 主路径**:composer 靶心按钮武装 `useSessionGoalArmStore`(本地 armed 标志)→ `sendMessage`(session-ui-store.ts:1230)消费 armed → 消息附带合成 `system-reminder` part(告知 agent goal 模式激活、每轮结束要输出 done/verified/remaining 报告;UI 侧与 server 侧 create.js 的 `buildGoalIntroText` 同构)→ 发送成功后 `setSessionGoal` 写 objective 文件 + patch metadata。slash command 场景:objective 取展开后的 command template(命令详情加载失败则用原始调用,不阻塞命令执行)。
- **其他入口**:fork-from-answer 对话框(Run as goal)、plan implement 对话框(objective override = plan 内容,因为 "Implement this plan: X" 本身无可审计性)、scheduled tasks(`execution.goalEnabled` + 可选 budget,服务端 create.js 直接写)、CLI(`openchamber session create/send/fork --goal` 走服务端编排:目标适配 → 写文件 → patch metadata → 追加 reminder → **之后才** dispatch prompt)。
- **超长目标适配**:>5000 字符 → 小模型蒸馏为"完成标准"(保留文件路径/命令/标识符原样、≤4000 字符、同语言);蒸馏失败 → 头尾各半截断 + 中间标记(工作 agent 收到的是全文,只有审计器被截断)。
- **暂停/恢复语义**:UI pause → `abortCurrentOperation`(停当前轮)+ status=paused;abort 事件路径同样暂停;恢复 → status=active + `statusReason='resumed'` + **turnsUsed 归零**(Resume 给全新续跑配额,否则 turn-cap 卡死的 goal 无法复活);resume 覆盖 aborted 尾部时跳过审计直接续跑。编辑目标保留 id 与记账;清除 goal → 删除文件 + 若曾 active 则 abort 当前轮。
- **UI 呈现**:strip(最新 note/状态/token/Evaluating 旋转指示/pause-resume)、靶心按钮三态(蓝=运行、绿=完成、红=blocked/budget)、侧栏 glyph;VS Code 只渲染状态不提供入口(循环只在 web server 跑)。
- **通知**:goal active 期间抑制所有通道的每轮 "ready" 通知(notifications/runtime.js `hasActiveSessionGoal` → 查 session metadata);settle 时发一条最终通知(desktop + UI broadcast + web-push 全文 / APNs 通用标题+会话名),遵守 notifyOnCompletion;error/question/permission 通知不受影响。

**依据**:sessionGoalActions.ts(全套 UI 操作);session-ui-store.ts:1199-1273;create.js;DOCUMENTATION.md "UI consumers" / "Scheduled goals" / "CLI-created goals";index.js:736-776(通知注入)。

**置信度:高**

### 7. 演进时间线(2026-07-12 至今)

| 日期 | 事件 | 要点 |
|---|---|---|
| 2026-07-12 | PR #2148(commit 56cf5e2) | 引入 session goals:服务端循环、SSE 驱动、metadata 状态、审计、预算、3 态靶心按钮、通知抑制 |
| 2026-07-13 | v1.16.0 发布 | 首发 |
| ~07-14 | commit 7533c7a | **file-backed objectives + compaction 记账修复**(真实长跑暴露:summary 消息 token 归零冻结计数器;summary 后继承 compaction agent/model 的错误) |
| ~07-15 | commit a56584b | 审计前实时子会话活动闸(避免审计/续跑压过活跃 subagent) |
| ~07-15 | commit 7d596e4 | UI 展示审计所用 evaluation provider/model + 诊断日志 |
| ~07-15 | commit 6e93f58 | `/craft-goal` starter 与命令 |
| 2026-07-16 | issue #2269 | **审计器不展开 `{env:VAR}` → 401 → goal blocked**;维护者确认 high priority |
| 2026-07-16 | PR #2275 | 修复 config-only provider 与 `{env:...}` 展开;1.16.3(07-22)changelog 确认 "provider API keys referenced through environment variables or files now work for summaries, goal audits" |
| 1.16.3 后 | CHANGELOG | slash command 起的 goal(含 scheduled)使用命令展开后的指令 |

**依据**:commit 信息、CHANGELOG.md:78-146、issue #2269。

**置信度:高**

### 8. 反方观点与已知失败模式

**8.1 持久性缺口(最重要反方,OpenAgents teardown,2026-07-12)**
- 循环"纯事件驱动:无轮询、无回填、无 session 扫描"意味着:服务器重启时**已经 idle 的 active goal 永远不会被重新武装**,直到某个新事件发生(如用户发消息)。teardown 原话:"Persisted goal metadata is not the same thing as a durable continuation lease."
- 崩溃窗口:turn 计数已持久化、`prompt_async` 未发出时崩溃 → 该次续跑永久丢失(设计偏向"不重复"而非"不丢失")。
- 无 durable continuation row / lease / claim generation / attempt state / outbox / startup reconciliation / reaper。
- 审计判据无类型化证据(repo 状态、测试、部署回执)——只有 agent 自己的文本报告。
- 结论引用:"The feature is a good **next-turn autonomy loop**, not exact interrupted-turn recovery and not yet a durable workflow engine."
- 注:teardown 写于 v1.16.0 发布当天,称"tagged tree contains no Session Goal tests";当前 main 已有 runtime.test.js(4 用例)与 create.test.js,测试缺口已部分补上。

**8.2 env 展开 bug(issue #2269,2026-07-16,已修复)**
- 自定义 provider 的 `options` 里写 `{env:PROVIDER_API_KEY}` 时,主聊天(OpenCode 引擎)能展开,但服务端审计器 `callSmallModel` 在环境变量不可用(auth.json 兜底路径)时会发送字面量 `{env:...}` → 401 → 连续 2 次审计失败 → goal 以 "progress audit unavailable" blocked。
- secondary finding:provider 只定义在 opencode.jsonc 而未在 auth.json 时,`resolveSmallModel` 在 `restrictToPreferredProvider` 下先 404 静默失败——goal 直接被 block 而没有任何 API 调用痕迹。
- 修复:PR #2275(2026-07-16),1.16.3(2026-07-22)发布。

**8.3 生态类比(参考,非 OpenChamber 直接问题)**
- opencode 本体 issue #27167 社区强烈要求原生 /goal,PR #27163 曾实现(存在 "auto-pause on no progress" 误判 bug:纯文本总结轮被当作无进展 → goal 自动暂停;修复为看最近 5 条消息)。说明"agent 自判进度"路线有已知陷阱,OpenChamber 选择"独立小模型审计"路线规避了它。
- Claude Code /loop//goal(#58900):goal 锁定原始措辞、`/loop exit` 不解除 stop hook、deleted ≠ completed 导致死循环烧 token——用户中途改主意后无法脱身。OpenChamber 的对策:目标可编辑、pause/stop 永远优先、blocked 3 连败才停。
- Codex /goal(#22362,#23177):与 AGENTS.md 审批策略隐式冲突,goal 一直续跑、agent 一直等审批 → 空转烧 token。OpenChamber 的审计 prompt 有 "if you genuinely cannot proceed without the user, state the exact blocking condition" 指令 + blocked 连击机制,但**未显式定义 goal 与用户审批策略的优先级**——同类冲突风险仍然存在。
- Codex Desktop #24287:/goal 多窗口状态分裂(goal 栏与 trace 流状态不一致)——OpenChamber 因状态在 metadata 且走统一 SSE 广播,结构性免疫此类分裂,但未做跨窗口实测验证。

**置信度:中-高(8.1 基于第三方 teardown 对源码的分析,与源码注释"no polling, no backfill, no session scans"一致)**

---

## 对比分析

### 与相关 goal 实现对比

| 维度 | OpenChamber Session Goals | opencode PR #27163(未合并) | Claude Code /loop·/goal | Codex /goal |
|---|---|---|---|---|
| 循环位置 | OpenChamber server(独立于 agent) | opencode 核心(session/prompt.ts) | client stop-hook | client 内建 |
| 终止权威 | **独立小模型审计**(objective+最后回复) | agent 行为自判(工具/补丁/子任务才算进展) | 条件表达式(任务清单) | agent 自判 |
| blocked 判定 | 3 连败审计 | auto-pause on no progress(有过误判 bug) | 条件不满足即继续 | agent 报告 blocked |
| 状态持久化 | session metadata(+文件目标) | 服务端持久化 | 会话内 | 会话内 |
| 重启恢复 | 事件驱动惰性恢复(无扫描) | 服务端重启后扫描 | — | 有已知 UI 状态分裂问题 |
| 硬停止 | token budget + 20 轮上限 + turn error | budget/step caps | — | — |
| 用户否决权 | stop/abort/pause 永远优先,双向联动 | pause on abort | /loop exit(有 bug) | stop |
| 已知主要缺陷 | 重启不扫描、审计无类型化证据、env 展开(已修) | 无进展误判、TUI 迁移 | 无法中途改目标、exit 不解除 hook | 审批策略冲突、UI 分裂 |

### 三条实现路线对比(若要在类似系统里复刻)

| 路线 | 描述 | 成本 | 风险 |
|---|---|---|---|
| 保守:纯 UI 辅助(只给用户"继续"按钮/宏) | 无服务端循环,人工 nudging | 低(数天) | 无人值守场景失效 |
| **中间:事件驱动审计循环(OpenChamber 路线)** | 服务端订阅 idle 事件 + 独立小模型判定 + prompt_async 续跑 + metadata 状态 | 中(1 个模块 ~800 行 + UI) | 重启恢复缺口、审计误判、需 provider 约束 |
| 激进:持久化工作流引擎 | 加 durable lease/outbox/reaper/启动扫描 + 类型化证据(测试、git、部署回执) | 高(数周,跨多个子系统) | 复杂度爆炸,单 session 场景过度设计 |

---

## 风险与不确定性(含元评审)

1. **最坏情况**:基于当前结论在类似系统复刻时,若照抄"纯事件驱动、无启动扫描",服务器夜间重启后 goal 静默停摆,用户以为 agent 还在干活——**无显式告警**(settle 通知只在 settle 时发,停摆不是 settle)。可回滚性:循环本身无破坏性写入,最坏损失是续跑停止 + 少量 token;OpenChamber 现状可接受,复刻时建议至少加"重启后扫描一次 active goal 并重新武装"的兜底。
2. **剩余未知**:
   - 审计误判率(complete 误判/漏判)无量化数据——这是本机制最大的质量不确定性,只能靠 3 连败与硬停止兜底。
   - 服务器重启后"惰性恢复"实际触发频率未知(用户多久会碰一次已 idle 的 goal 会话)。
   - 多客户端并发编辑 goal(patch 合并)的竞态只在 `writeGoal` 的 merge 读-改-写里做了序列化,未做乐观锁版本号验证。
3. **最弱证据**:审计质量与失败模式(仅官方自述 + 2 个 issue);OpenAgents teardown 是第三方分析(综合 18 分,仅辅助)。
4. **可能错误的假设**:
   - 假设 `prompt_async` 与 metadata PATCH 的语义在 OpenCode SDK 演进中保持稳定(OpenChamber 依赖 OpenCode 的行为契约:idle/busy/retry 事件、tokens.cache.read、summary 标记、MessageAbortedError、children 列表)。
   - 假设 `cache.read` 快照记账在 provider 不报 cache token 时仍大致正确(代码里 `Math.max(0, ...)` 容错,但混用 provider 时会低估)。
5. **遗漏角度**:iOS/Android 移动端 goal 呈现细节、多 OpenChamber 实例并发指向同一 OpenCode server 时的双循环竞态(未在源码中见到实例锁)。
6. **边际收益**:再深挖的性价比最高方向是 issue 区统计 goal 相关 bug 的复现率,以及跑一次端到端长会话验证重启恢复行为;当前结论已足够支撑架构理解与复刻决策。

---

## 建议

1. **若只理解机制**:按 DOCUMENTATION.md + runtime.js 阅读顺序(runtime.js:775 事件路径 → 446 tick → 362 runAudit → 72 buildContinuationPrompt),五个设计决策(metadata 状态、事件驱动、独立审计、硬停止、快照记账)是记忆锚点。
2. **若在类似系统复刻**(本项目可能的场景):
   - 采纳:metadata 状态 + 事件驱动 idle 循环 + 独立审计 + 用户否决优先 + 先写后跑的记账顺序 + stale-write guard by goal id。
   - 补强:启动时扫描 active goal 重新武装(一行兜底,消除最大持久性缺口);审计失败改为"降级为人工通知"而非静默续跑;目标文本文件路径做 id 校验(防注入);审计 JSON 解析容错与语言锁定(直接抄 `extractJsonObject`/`hasScriptMismatch`)。
   - 避免:agent 自判进度(auto-pause on no progress 已被 opencode PR #27163 证明有误判坑);不设任何硬停止的纯循环。
3. **产品层面**:goal 与用户审批/AGENTS 策略的优先级应显式文档化(Codex #22362 教训);重启恢复缺口应写进用户文档(当前文档只说"server must stay running",未提 idle goal 可能不自动恢复)。

---

## 参考来源

| 标题 | URL | 发布者 | 时间 |
|---|---|---|---|
| runtime.js(createSessionGoalRuntime 全实现,832 行) | github.com/openchamber/openchamber/blob/main/packages/web/server/lib/session-goal/runtime.js | openchamber | 2026-08-08(main) |
| session-goal/DOCUMENTATION.md | 同上,lib/session-goal/DOCUMENTATION.md | openchamber | 2026-08-08(main) |
| feat: session goals(PR #2148,commit 56cf5e2) | github.com/openchamber/openchamber/commit/56cf5e29 | openchamber | 2026-07-12 |
| Session Goals 用户文档 | docs.openchamber.dev/session-goals/ | OpenChamber | 2026-08 |
| Changelog(v1.16.0-1.16.3) | openchamber.dev/changelog、CHANGELOG.md | OpenChamber | 2026-07-13 ~ 08 |
| [Bug] Session goal auditor fails to expand `{env:VAR}`(issue #2269) | github.com/openchamber/openchamber/issues/2269 | joelstucki-taulia | 2026-07-16 |
| fix: resolve config-only providers and {env:...}(PR #2275) | github.com/openchamber/openchamber/pull/2275 | IbrahimKhan12 | 2026-07-16 |
| OpenChamber Whole-Product Teardown(§9 Session Goals) | github.com/OpenAgentsInc/openagents/blob/main/docs/teardowns/2026-07-12-openchamber-product-teardown.md | OpenAgentsInc | 2026-07-12 |
| feat: file-backed goal objectives + compaction fixes(7533c7a) | github.com/openchamber/openchamber/commit/7533c7a | openchamber | ~2026-07 |
| fix: gate session goal audits on live child activity(a56584b) | github.com/openchamber/openchamber/commit/a56584b | openchamber | ~2026-07 |
| opencode #27167 / PR #27163(native session goals) | github.com/anomalyco/opencode/issues/27167 | 社区 | 2026-05~ |
| Claude Code #58900(/loop exit 与 /goal 死循环) | github.com/anthropics/claude-code/issues/58900 | 社区 | 2026 |
| Codex #22362 / #23177(/goal 与审批策略、blocked 空转) | github.com/openai/codex/issues/22362 | 社区 | 2026 |

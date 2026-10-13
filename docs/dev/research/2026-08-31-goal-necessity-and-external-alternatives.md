# 决策记录：goal 内核的去留与外接方案评估

- 日期：2026-08-31
- 关联：`2026-08-31-opencode-v2-compat-spike.md`（§6.3 解耦准备）、`2026-08-31-strategic-direction.md`（方向 A/B）
- 问题：cabbage 自带的 goal（工具 + 续接引擎 + 护栏）是否有存在的必要？能否改为搭配第三方/官方 goal 插件？
- 状态：分析完成，给出分阶段结论（V1 保留 / V2 外接），待作者决策

---

## 一、结论摘要

1. **goal 的"职责"必须存在，但"实现"不必由 cabbage 自己做。** goal 在 cabbage 中不是附属功能，而是全流程自动执行的引擎——没有它，flow-* skills 的多阶段编排会在单轮结束，cabbage 退化为纯 prompt 模板集。但引擎的实现机制（idle 事件、prompt 注入、状态持久化）高度依赖平台内部，且正是 V2 迁移中断裂的三条命脉。
2. **第三方 goal 插件已成熟且部分超越 cabbage 内核。** prevalentWare/opencode-goal-plugin（311 stars、周下载 2881、活跃维护）覆盖了 cabbage goal 的全部护栏能力且更强（token 预算、auto-turn 上限、时长上限、no-progress 检测、watchdog 重试、prompt 失败熔断、Plan-mode 安全、子会话 defer），并已完成 OpenCode 2 preview 适配（0.1.30+）。
3. **cabbage goal 的不可替代部分只有两块**：Flow 绑定（parentIssueNumber 结构化字段 + session-index 重启恢复 + 续接 prompt 引用 Flow Record）和 complete 授权门控（仅 goal-verify 子 agent 可 complete）。这两块都可以在外接方案中降级实现（约定化 / skill 化），但会从"工具层强制"弱化为"prompt 层自律"。
4. **双续接循环冲突使"共存"不可行，"替换"才可行。** 两个插件同时监听 idle 并注入续接 prompt 会双发。prevalentWare 已有先例（compaction 时禁用 OpenCode 内置 synthetic auto-continue 以保证 goal 续接权威），证明共存需要一方完全让位。
5. **分阶段结论**：V1（现在）保留自建 goal——换插件无净收益且引入协议适配成本；V2（迁移时）切换为外接 prevalentWare（或届时落地的官方 goal）——cabbage 的续接引擎在 V2 必须重写，而外接方案已经有人做完且更成熟，cabbage 聚焦编排资产 + Flow 方法论 + 验证门控。

---

## 二、goal 在 cabbage 中的职责拆解

| # | 职责 | 具体机制 | cabbage 独有？ | 外接后去向 |
|---|---|---|---|---|
| 1 | 循环驱动 | idle 事件 → queueContinuation → promptAsync 续接 | 否 | 外接插件的 auto_continue |
| 2 | 护栏 | token 预算（快照法）、MAX_CONTINUATIONS、in-flight 防重入、abort 检测、子会话活动闸、尾部静默检查 | 否（prevalentWare 更全） | 外接插件的 budget/limits/watchdog |
| 3 | Flow 绑定 | goal.parentIssueNumber 结构化字段、session-index 本地索引（重启恢复）、continuationPrompt 引用 Flow Record | **是** | 降级为约定：objective 文本必须含 Flow 引用；重启恢复靠外接插件自身的持久化 |
| 4 | complete 授权门控 | 工具层强制：仅 goal-verify 子 agent 可 complete；其他 agent 调用返回 Error | **是** | 降级为 skill 协议：flow-tdd/bootstrap 教模型"complete 前必须派 goal-verify"——从强制退化为自律 |
| 5 | 信号协议 | [BLOCKED:] / [DONE:] 文本标记 → 暂停；continuationPrompt 教会模型输出 | 部分（与续接 prompt 耦合） | 用外接插件自身的 complete-evidence / unmet 协议替代 |
| 6 | 会话配置快照 | sessionProfile（agent/model）防续接回落 | 否 | 外接插件的行为（prevalentWare 不切换 agent） |

## 三、关键事实（2026-08-31 验证）

### 3.1 第三方 goal 插件能力对比

| 能力 | cabbage goal | prevalentWare/opencode-goal-plugin | devinoldenburg/opencode-goal-mode |
|---|---|---|---|
| 续接循环 | ✅ 五道闸 | ✅ + watchdog 重试、prompt 失败熔断 | ✅ 独立 evaluator 模型 YES/NO 判断 |
| token 预算 | ✅ 快照法 | ✅ default_token_budget + budgetLimited 状态 | ❌（maxTurns 替代） |
| no-progress 检测 | ❌ | ✅ max_no_progress_turns | ✅ noProgressLimit（evaluator 重复 NO） |
| auto-turn / 时长上限 | MAX_CONTINUATIONS=50 | ✅ max_auto_turns + max_goal_duration_seconds | ✅ maxTurns |
| 子会话活动闸 | ✅ hasWorkingChildren | ✅ defer_while_tasks_active（含 orchestrator reconciliation） | ❌ |
| 完成门控 | ✅ goal-verify 授权（工具强制） | ✅ complete 需 verified evidence（模型自查） | ✅ 独立 evaluator 判断（更强独立性强于自查、弱于强制授权） |
| Flow/GitHub 绑定 | ✅ 结构化 parentIssueNumber + session-index | ❌ 自由文本 objective | ❌ 自由文本 condition |
| Plan-mode 安全 | ❌（无此概念） | ✅ restricted_agents + 不逃逸 Plan 会话 | ❌ |
| compaction 存活 | ✅（注入依赖 V1 hook） | ✅ + 禁用内置 synthetic auto-continue | 未明确 |
| TUI 状态面 | ❌ | ✅ 侧边栏（状态/耗时/token/checkpoint） | ❌（刻意极简） |
| OpenCode 2 适配 | ❌（三命脉断裂） | ✅ 0.1.30+ 支持 V2 preview | 未确认（V1 形态） |
| 维护活跃度 | 单人（作者） | 活跃（周下载 2881） | 活跃但小众（周下载 248，7 stars） |
| 许可 | MIT | MIT | MIT |

### 3.2 官方 native goal 现状

- PR #27163、#28610、#32239、#32743、#32924 多个竞争实现**全部关闭或 draft，无一合入**；maintainer 路线未决（core vs plugin、session DB vs workspace 文件）。
- 新的实现还在冒出（#46328 plugin PR、opencode-loopd 等），issue #27167 仍然 open。
- **含义**：官方 goal 落地时间不可预测；在可预见的时间窗内，"更好的 goal 插件"事实上就是 prevalentWare 这类社区实现。

### 3.3 双循环冲突证据

- prevalentWare README：compaction 期间"disables OpenCode's generic synthetic auto-continue while an active goal exists so the goal-specific continuation prompt remains authoritative"——单一权威续接者是该插件的设计前提。
- cabbage 若保留 queueContinuation 且用户另装 goal 插件：两个 idle 监听都触发 → 双发续接、计数/预算互不知晓、abort 处理互相干扰。**必须二选一。**

## 四、"搭配"方案的可行性评估

### 4.1 方案形态：cabbage 卸载 goal，外接 prevalentWare

cabbage 移除：goal 工具注册、queueContinuation、autoResume、token 记账、[BLOCKED/DONE] 协议。
cabbage 保留：skills/commands/agents 注入、Project Context 注入、权限矩阵、goal-verify agent + 验证 skill。
适配层：flow-* skills 与 bootstrap 改写——教 dev-lifecycle "开始 Flow 时调用 create_goal，objective 必须含 `Flow #N` 与验收标准引用；[DONE] 前必须先派 goal-verify 独立验证，通过后才能 update_goal complete 并附证据"。

### 4.2 收益

1. **V2 迁移成本大幅下降**：续接引擎（cabbage 在 V2 必须重写、且依赖 V2 未修复的事件/注入 bug）整体外包给已完成 V2 适配的插件。cabbage 的 V2 适配面缩窄为：context 注入、config 注入、权限矩阵。
2. **护栏能力净增强**：no-progress 检测、时长上限、watchdog、prompt 失败熔断、Plan-mode 安全——cabbage 自建没有且短期不会有。
3. **维护负担下降**：续接引擎是 cabbage 代码中对抗性最强、测试最重的部分（253 个测试中约 100+ 个服务于续接/goal 工具），外包后大幅缩减维护面。
4. **用户侧组合灵活**：goal 引擎可独立升级；cabbage 用户与非 cabbage 用户共享同一个 goal 插件的改进。

### 4.3 代价与风险

1. **complete 门控弱化（实质损失）**：从"工具层拒绝未授权 complete"退化为"prompt 教模型自觉先跑 goal-verify"。对抗性场景（模型偷懒跳过验证）下，强制失效。缓解：goal-verify 产出物（验证报告）写回 Flow Record，release 闸在流程层检查——但这是事后审计，不是事前拦截。
2. **Flow 绑定弱化**：parentIssueNumber 从结构化字段变为 objective 文本约定；session-index 的"重启恢复 + 索引一致性自愈"逻辑失效（依赖外接插件自身的持久化；其 goal 与 cabbage 的 Flow 无结构化关联，重启后 cabbage 无法主动核对绑定）。缓解：Flow Record 侧反向记录 sessionID（issue 评论中），重建关联。
3. **第三方依赖风险**：prevalentWare 是活跃的个人/小团队维护（当前 1 个 open issue，响应良好），但存在弃维护可能。官方 goal 若落地，可能再次改变格局（迁移到官方 API 是另一次适配）。
4. **安装与文档复杂度**：用户需装两个包并理解分工；cabbage 需检测 goal 插件是否存在并给出明确报错/引导。
5. **信号协议迁移**：[BLOCKED:]/[DONE:] 检测逻辑（约 40 行 + 测试）废弃，改用外接插件的 unmet/complete 证据协议；flow-tdd 等 skill 中的协议教学要重写。

### 4.4 结论：可行且是 V2 的优选路径，但不是现在的动作

- **V1 不动**：自建 goal 在 V1 上工作良好、经对抗测试验证、与 Flow 模型深度耦合；换成 prevalentWare 在 V1 上能力持平或略弱（丢结构化 Flow 绑定与工具强制门控），还要付适配成本。净收益为负。
- **V2 外接**：迁移决策点（V2 兼容 spike 的触发条件达成时）默认路径改为"卸载自建续接引擎 + 外接 prevalentWare（或官方 goal，若届时落地）"。此时自建引擎反正是要重写的，重写成本 > 外接适配成本，且外接护栏更强。
- **现在要做的准备**（与 GoalStore 抽象同批次的低成本解耦）：
  1. 将续接引擎的调用面收敛（queueContinuation/autoResume/goal 工具已经集中在这两个文件，天然构成未来可整体移除的模块边界——无需进一步抽象，记录边界即可）；
  2. flow-* skills 中对 goal 工具的引用清单化（哪些 skill 教了 [DONE:]/goal-verify 协议），为外接方案的 skill 改写做准备；
  3. 在 README 增加与第三方 goal 插件的互斥声明（当前用户若同时安装会双循环，这是现实存在的用户风险）。

## 五、反方观点与不确定项

1. **"外接即失去产品完整性"**：cabbage 的卖点之一是"开箱即用的全流程"（装一个包全搞定）。外接 goal 后变成都要装两个包、配置兼容。若目标用户是"想要全自动开发流程的个人开发者"，单包体验有价值。反制：prevalentWare 本身安装极简（npm 一行），且其周下载量说明用户不排斥独立 goal 插件。
2. **"官方 goal 随时可能落地，外接插件白适配"**：官方 PR 全部关闭说明短期（3-6 个月）无落地迹象；且官方落地后 prevalentWare 已展示 V2 适配能力，跟进成本在其一方。
3. **"goal-verify 门控弱化不可接受"**：如果作者认为"工具层强制验证"是项目的核心价值（对抗模型偷懒），则外接方案丢弃了最有差异化的一块。此时替代路径是方向 B（最小证据门控层）而非外接。**这个价值排序只有作者能定。**
4. **本分析的时效**：prevalentWare 能力面与官方 PR 状态均为 2026-08-31 快照；V2 迁移决策前需复核。

## 六、参考来源

1. prevalentWare/opencode-goal-plugin（GitHub README + npm，311 stars，v0.1.39，周下载 2881，2026-08-20 更新；V2 preview 支持说明）
2. devinoldenburg/opencode-goal-mode（GitHub + npm，v0.9.7，evaluator 架构，2026-07-08）
3. anomalyco/opencode PR #27163 / #28610 / #32239 / #32743 / #32924 / #46328（native goal 竞争实现，全部 closed/draft，2026-05~08）
4. anomalyco/opencode issue #27167（native goal 需求追踪，仍 open）
5. 本项目源码审计：src/plugin/goal.ts、src/plugin/server.ts（goal 职责拆解依据）

# Spike 报告：opencode-cabbage 的 OpenCode 2.0 兼容性评估

- 日期：2026-08-31
- 范围：OpenCode 2.0（beta）插件 API 兼容性评估——兼容清单、风险分级、迁移结论
- 方法：项目 API 使用面审计（`src/` 全部 TS 源码）+ V2 官方文档（v2.opencode.ai）+ V2 源码/issue/PR 交叉验证
- 结论先行：**现在不迁。** 三个 P0 阻断（事件零投递、session metadata 未暴露、注入路径失效）+ API 未冻结。但可立即做架构解耦准备，迁移时机由两个外部触发条件决定。

---

## 一、结论摘要

1. **V1 插件在 V2 完全不工作，且没有兼容垫片。** 官方迁移指南明确："V1 plugins will not work in V2"；实测 V1 形状的插件导出被 V2 loader 以 `SchemaError(Missing key at ["default"]["setup"])` 拒绝（issue #39345、#44788）。
2. **cabbage 的三条生命线在 V2 beta 上全部断裂：**
   - **自动续接**依赖 `session.status(idle)` 事件 → V2 事件词汇已变（`session.inbox.enqueued` / `session.step.started` / `session.execution.*`…），且 beta-18050 上 `ctx.event.subscribe` 对插件零投递（#44788）；
   - **续接 prompt 发送**依赖 `promptAsync({synthetic:true})` → V2 的 `ctx.session.synthetic` 在 beta-18050 上创建消息但**不进模型 prompt**（#44788），`ctx.session.prompt` 的 `resume` 语义可用但需重验；
   - **goal 状态持久化**依赖 `session.metadata.goal` → V2 session 表有 metadata 列，但 **V2 API 读写路径均未暴露它**（issue #40384，2026-08-03 确认，仍未修复）。
3. **可复用资产占大头**：`kernel/` 五个模块（context/profile/session-index/permission/mutex）零依赖变化；`assets/` 的 Prompt 资产大部分兼容（skills 的 SKILL.md 格式、agents 的 Markdown 格式 V2 均支持）；唯一需要重写的是 `src/plugin/` 的 API 胶水层（约 3 个文件的核心逻辑）。
4. **V2 带来了两个对 cabbage 利好的官方能力**：session-scoped keyed context contributions（#34941 已实现，可官方化"Project Context 注入"）和 `ctx.storage` 插件 KV（可替代 session.metadata 存 goal 状态）。
5. **迁移是必选项不是选项**（V1 线终将被淘汰），但时机未到：V2 官方声明 API "still being finalized during beta"，三个 P0 bug 未修，官方 native goal（#27167/#32743）形态未定。

---

## 二、背景与目标

- **目标**：评估 opencode-cabbage v1.3.0 迁移到 OpenCode 2.0 插件 API 的兼容性、工作量与风险，产出可执行的迁移决策。
- **关键约束**：cabbage 的核心价值依赖三件事——(a) 监听会话事件做自动续接；(b) 通过 SDK 向会话注入 synthetic prompt；(c) 在 session metadata 中持久化 goal 状态。这三件事是"薄内核"的全部命脉。
- **版本基线**：`@opencode-ai/plugin ^1.17.0`、`@opencode-ai/sdk ^1.17.14`（V1 线）。V2 对应包为 `@opencode-ai/plugin`（`next`/`beta` tag，当前 `0.0.0-beta-18721`，exports 含 `./v2/promise`、`./v2/effect`）与 `@opencode-ai/client`（`next`/`beta` tag，V2 客户端）。

## 三、方法

1. **API 面审计**：通读 `src/index.ts`、`src/plugin.ts`、`src/plugin/{server,goal}.ts`，逐项列出对 `@opencode-ai/plugin` 与 `@opencode-ai/sdk/v2` 的调用面（共 18 项，见 §四）。
2. **V2 文档研究**：v2.opencode.ai 的 migrate-v1 / plugins / build/plugins / build/plugins/effect / permissions / agents / skills / api 页面。
3. **源码/issue 交叉验证**：anomalyco/opencode 的 #39345（V1 插件 SchemaError）、#44788（beta-18050 事件零投递 + context/synthetic 注入失效，含 canary-token 实验证据）、#40384（V2 未暴露 session metadata）、#34380/#34941（keyed session context 已实现）、#27167/#32743（官方 native goal 进展）、PR #23068（V1 metadata 支持历史）。
4. **局限**：未在本地实际运行 opencode2 验证（本 spike 为静态评估；代码级验证留待 API 冻结后进行）。V2 为 beta，本文所有 V2 结论均带"当前 beta 时点"限定。

---

## 四、兼容清单（V1 → V2 逐项映射）

### 4.1 插件入口与生命周期

| # | V1 使用（cabbage 现状） | V2 对应 | 状态 | 迁移动作 |
|---|---|---|---|---|
| E1 | `export default { id, server: async (ctx) => hooks }` | `Plugin.define({ id, setup(ctx) })` 或 `effect(ctx)` | ❌ 破坏 | 重写入口；`setup` 可返回清理函数（对应 V1 无此机制，反而更优） |
| E2 | `"oc-plugin": ["server"]`（package.json） | 未在 V2 文档/源码发现 `oc-plugin` 字段；V2 用 `"plugins": [...]` 配置 + `Plugin.define` 导出 | ⚠️ 待验证 | 需在 opencode2 下实测；大概率废弃 |
| E3 | `ctx.worktree` / `ctx.directory` | `ctx.location.directory`（+ `workspaceID`、`project` 元数据） | ⚠️ 改名 | 迁移一行；`ctx.location` 是"插件实例位置"而非会话位置，语义需核对 |
| E4 | `ctx.serverUrl`（用于自建 SDK client） | 无对应（V2 ctx 本身就是 server client） | ✅ 简化 | 删除自建 client，直接用 `ctx.session`/`ctx.event` 等域 |
| E5 | `ctx.client` + 私有 `_client.getConfig()` 取 headers/fetch | 不需要 | ✅ 简化 | V2 ctx 的 session/prompt 等方法自带服务器连接 |

### 4.2 事件与自动续接（cabbage 命脉）

| # | V1 使用 | V2 对应 | 状态 | 说明 |
|---|---|---|---|---|
| V1 | `event` hook 订阅 `session.status`（idle 触发续接） | `ctx.event.subscribe()` / `events.on()` | ❌ 断裂 | V2 公开事件词汇已变：`session.inbox.enqueued`、`session.text.delta`、`session.step.started`、`session.tool.called`、`session.reasoning.*`、`session.execution.*`；**未见 `session.status`/`session.idle` 的 V2 等价物**；且 beta-18050 上 subscribe 注册成功但零投递（#44788） |
| V2 | `event` hook 订阅 `session.error`（abort 检测） | V2 事件流（`session.execution.*`?） | ⚠️ 待确认 | abort 等价事件需在 V2 词汇中寻找 |
| V3 | `event` hook 订阅 `message.updated`（user 消息重置计数 + agent/model 快照） | `session.inbox.enqueued`（用户输入入队）或 `ctx.session.hook("prompt")` | ⚠️ 待确认 | prompt hook 是"用户输入拦截"，语义更贴近；但 hook 在 beta-18050 上修改不进模型 |
| V4 | `event` hook 订阅 `session.updated`（complete 时同步索引） | V2 事件流对应物待确认 | ⚠️ 待确认 | 依赖 V2 事件词汇稳定 |

### 4.3 续接 prompt 发送

| # | V1 使用 | V2 对应 | 状态 | 说明 |
|---|---|---|---|---|
| P1 | `client.session.promptAsync({ sessionID, parts, synthetic: true, agent, model })` | `ctx.session.synthetic` / `ctx.session.prompt`；`POST /api/session/{id}/prompt` 有 `resume` 参数（"schedule agent-loop execution unless resume is false"） | ⚠️ 半断裂 | `synthetic` 在 beta-18050 上消息可见但不进模型 prompt（#44788）；`prompt` 端点 `resume` 语义恰好对应自动续接需要（调度 agent loop），但需在修复后实测 |
| P2 | 每 20 次续接主动 compact（`promptAsync` 发 compact 指令） | V2 的 compaction 机制/接口待确认 | ⚠️ 待确认 | V2 有 compaction 系统 agent（hidden），插件触发路径不明 |

### 4.4 goal 状态持久化（核心阻断）

| # | V1 使用 | V2 对应 | 状态 | 说明 |
|---|---|---|---|---|
| G1 | goal 存 `session.metadata.goal`（读 `session.get`，写 `session.update`） | **V2 未暴露 session metadata**：表列存在，但 `Session.Info` 无 metadata 字段、`session.create` payload 无 metadata、无 update 端点（V1 的 `Session.setMetadata`/PATCH 在 V2 被移除，#40384） | ❌ 断裂 | **必须换存储**。候选：① `ctx.storage`（插件 KV，`ctx.storage.set/get`，官方文档确认存在）；② 本地文件（cabbage 已有 session-index 先例，可扩展）；③ keyed session context（#34941，持久 + compaction 存活，但它是 prompt 投影通道而非通用 JSON 存储，且会进模型上下文） |
| G2 | goal 与 Flow 的绑定索引（session-index 本地文件） | 无依赖变化 | ✅ 复用 | `kernel/session-index.ts` 直接可用 |

### 4.5 工具注册

| # | V1 使用 | V2 对应 | 状态 | 说明 |
|---|---|---|---|---|
| T1 | `tool()` helper + `tool.schema.enum/number`（zod） | `ctx.tool.transform(draft => draft.add({ name, description, jsonSchema, execute }))` | ❌ 重写 | jsonSchema 格式；`execute` 上下文字段变化 |
| T2 | `ToolContext`：`sessionID`（any 强转）/`agent`/`directory` | V2 工具上下文字段待确认（V1 ToolContext 本就有 sessionID/agent/directory 官方字段，cabbage 用 any 强转属于 V1 类型缺陷） | ⚠️ 待验证 | V2 版 ToolContext 需核对 |
| T3 | `config.tools.goal = false` 的权限门控（仅 dev-lifecycle/goal-verify 可见 goal 工具） | V2 permissions 规则数组（`action: "goal"`? 自定义工具 action 名规则） | ⚠️ 重写 | V2 权限 action 为字符串，自定义工具可用其名字做 action，理论上可行，需实测 |

### 4.6 config hook（命令/技能/agent 注入）

| # | V1 使用 | V2 对应 | 状态 | 说明 |
|---|---|---|---|---|
| C1 | `config.skills.paths.push(skillsDir)`（复制到临时目录） | `ctx.skill.transform(draft => draft.add({ id, name, description, location, content }))` | ❌ 重写但更优 | V2 可直接注入 skill 内容，无需复制文件到临时目录；V2 还自动发现 `.opencode/skills`、`.claude/skills`、`.agents/skills` |
| C2 | `config.command[name] = { template, description, agent, model, subtask }` | `ctx.command.transform(draft => draft.add({ name, description, execute }))` | ❌ 重写 | V2 命令执行器是函数（`execute: async ({ sessionID, prompt, delivery })`），不再是指令模板——**7 个 slash command 的行为要移植到 execute 函数**（目前是 prompt 模板 + agent 指定，移植有语义损失风险） |
| C3 | `config.agent[key] = { description, mode, color, prompt, permission, shell.env }` | `ctx.agent.transform(draft => draft.add/update(...))` 或配置 `agents` 字段 | ❌ 重写 | 字段映射：`prompt`→`system`；`permission` 对象语法→`permissions` 规则数组（`bash`→`shell`、`task`→`subagent`、`write`/`patch`→`edit`）；`shell.env` 与 `tools` 是 V1 遗留字段，V2 明确禁用（"Do not use legacy top-level agent fields"） |
| C4 | `<profile-test-command>` 占位符渲染（permission 规则动态化） | 逻辑不变，输出格式迁移为规则数组 | ⚠️ 重写 | kernel/profile.ts 复用，渲染层格式改 |

### 4.7 首条消息注入（Project Context + bootstrap）

| # | V1 使用 | V2 对应 | 状态 | 说明 |
|---|---|---|---|---|
| I1 | `experimental.chat.messages.transform`（首条 user 消息 unshift 注入块） | 候选① `ctx.session.hook("context")`——**beta-18050 上修改不达模型（#44788，canary 实验证实）**；候选② `ctx.session.hook("prompt")`——拦截用户输入、edits 成为 canonical persisted user input，语义更可靠；候选③ keyed session context（#34941 已实现）——官方设计的持久化、compaction 存活注入通道 | ⚠️ 需选择 | 候选③ 是官方为"embedder 注入会话级上下文"设计的正解，最贴合 cabbage 的 Project Context 注入需求；但需等待 #44788 类 bug 修复后验证 |

### 4.8 SDK 客户端

| # | V1 使用 | V2 对应 | 状态 | 说明 |
|---|---|---|---|---|
| S1 | `createOpencodeClient`（@opencode-ai/sdk/v2，子路径） | `@opencode-ai/client`（V2 客户端包） | ❌ 换包 | V2 客户端为 beta（`0.0.0-beta-*`），方法名/输入/输出可能变化 |
| S2 | `client.session.get / update / messages / children / status` | V2：`session.get`、`GET /session/{id}/message` 存在；`update`（metadata 语义）、`children`、`status` 待逐项核对 | ⚠️ 部分 | `status` 查询是续接五道闸之一（子会话活动闸），若无等价 API 需重设计 |
| S3 | `throwOnError: true` 显式配置 | V2 客户端错误语义待确认 | ⚠️ 待验证 | 影响 readGoal/writeGoal 的错误传播路径 |

### 4.9 免迁移部分

| 模块 | 内容 | 状态 |
|---|---|---|
| `kernel/` | context.ts（CONTEXT.md 发现/摘要）、profile.ts（AGENTS.md 解析）、session-index.ts（本地索引）、permission.ts（V1 匹配语义——**注意：此模块服务于 V1 权限格式，V2 迁移后可能退化**）、mutex.ts | ✅ 直接复用（permission.ts 除外，见右栏） |
| `assets/skills/` | 9 个 flow-* SKILL.md | ✅ 复用（V2 支持 SKILL.md + frontmatter name/description；`metadata.opencode/autoinvoke` 字段可用于控制自动触发） |
| `assets/agents/` | 6 个 agent Markdown | ⚠️ 基本复用（frontmatter 的 `permission` 块需迁移为 `permissions` 数组；`prompt`/body 逻辑不变） |
| `assets/prompts/` | bootstrap、stage-contract | ✅ 复用 |
| `codex-skills/`、`hooks/`、`.codex-plugin/` | Codex 兼容层 | ✅ 完全无关（独立生态） |
| 文档体系 | ADR/PRD/SOP/术语表 | ✅ 复用 |

---

## 五、风险分级

### P0 阻断性风险（不解决则无法迁移）

| 风险 | 证据 | 影响 |
|---|---|---|
| R1：V2 插件事件订阅不可用/词汇未定 | #44788（beta-18050：subscribe 注册成功但零投递；公开 SSE 词汇与 SDK 类型不一致） | 自动续接、abort 检测、消息快照全部依赖事件——**续接机制整体失效** |
| R2：V2 session metadata 未暴露 | #40384（2026-08-03：表列存在，读写路径均未实现） | goal 状态无处持久化——**必须重选存储后端** |
| R3：synthetic/context 注入路径失效 | #44788（canary-token 实验：三条注入路径均不进模型 prompt） | 续接 prompt 发不进去——**自动续接的第二根支柱断裂** |
| R4：V2 API 未冻结 | 官方 migrate-v1："The V2 plugin API is still being finalized during beta" | 现在动手的全部工作量可能在正式版前作废 |

### P1 高工作量风险

| 风险 | 说明 |
|---|---|
| R5：入口/工具/三 transform 重写 | 约 `src/plugin/` 3 个文件核心逻辑重写；7 个 slash command 从"指令模板"移植为"execute 函数"，语义有损失风险（V1 的 command template + agent 指定机制在 V2 的对应形态未完全明确） |
| R6：权限体系格式迁移 | 权限矩阵（子 agent 技能隔离、dev-lifecycle 全权、goal-verify deny publish）从 V1 对象语法迁移到 V2 规则数组；`permission.skill` deny 语义在 V2 有官方对应（`action: "skill"` + `effect: "deny"` 会从模型发现中移除），但仍需逐项验证子 agent 权限继承语义（V2：子 agent 用自己的权限，不继承父权限子集——与 cabbage 的隔离模型恰好一致，利好） |
| R7：SDK 换包 + 调用面逐个核对 | `@opencode-ai/client` 为 beta；`session.children/status` 等查询面待确认等价物 |

### P2 语义与生态风险

| 风险 | 说明 |
|---|---|
| R8：官方 native goal 与 cabbage goal 的生态位重叠 | #27167/#32743 若落地，cabbage 的 goal 状态机价值被抽走；**迁移时点应同时评估是否改为"消费官方 goal API 的上层编排"** |
| R9：V2 的 worktree/并行语义 | V2 有 background subagents + 官方在做的 worktree 隔离方向；cabbage 的 worktree 编排可能被官方任务工具吸收 |
| R10：`oc-plugin` 字段与 npm 分发机制变化 | V2 插件分发（`plugins` 配置、package 安装 `opencode2 plugin add`）与 V1 npm 加载机制不同，发布流程需调整 |
| R11：双版本维护成本 | V1 存量用户 + V2 新用户并行期间，assets/ 的每次变更要保证两线可用（prompt-lint 测试需扩展） |

---

## 六、迁移结论与建议

### 6.1 结论：现在不迁，但现在准备

**理由**：R1/R2/R3 三个 P0 风险意味着迁移完成也无法工作（事件收不到、状态没处存、prompt 发不进）；R4 意味着 API 可能再变。**迁移的动作时机 = 外部事件，不取决于本项目的进度。**

### 6.2 两个触发条件（满足一个开始动手）

1. **硬触发**：#44788 与 #40384 修复（事件投递 + 注入路径可用 + metadata 或替代存储可用），且 V2 事件词汇在 SDK 类型中稳定（beta 转 RC）。
2. **软触发**：官方 native goal（#32743）合入或明确搁置——决定 cabbage 的 goal 层是"自建状态机迁移"还是"改为消费官方 goal 的上层编排"。

### 6.3 现在可以做的解耦准备（不改行为、降低未来迁移成本）

1. **抽象 goal 存储**：把 `session.metadata.goal` 读写收敛到一个 `GoalStore` 接口（实现：V1 = session metadata；V2 候选 = `ctx.storage` 或本地文件）。当前 session-index 已走本地文件，接口化后 V2 切换是一天工作量。
2. **收敛事件处理层**：server.ts 的 event 回调中四个事件类型（session.error/status/message.updated/session.updated）的 payload 解析集中到独立适配函数，未来 V2 事件词汇映射只改一个文件。
3. **command 资产协议化**：为 7 个 slash command 的 markdown 资产定义与 V2 `execute` 函数兼容的结构（目前 `template + agent` 的组合在 V2 无直接对应，提前设计"命令 = 意图描述 + 委派规则"的中间表示，两线各自渲染）。
4. **prompt-lint 扩展**：为双线兼容建立资产一致性检查（skills/agents frontmatter 的 V1/V2 双格式漂移检测）。
5. **关注清单**：订阅 #44788、#40384、#32743 三个 issue 的进展，作为迁移启动的信号源。

### 6.4 迁移时的执行策略（预估）

| 阶段 | 内容 | 估时（个人节奏） |
|---|---|---|
| 1 | P0 验证：在 opencode2 下做 canary 实验复现/确认 R1-R3 已修复 | 0.5 周 |
| 2 | 入口重写（Plugin.define + setup）+ GoalStore 切换 + SDK 换包 | 1 周 |
| 3 | 事件层重接（续接五道闸在 V2 事件词汇下重实现）+ prompt 发送路径 | 1 周 |
| 4 | 三 transform（skill/command/agent）+ 权限矩阵迁移 + 首条注入改 keyed context | 1-1.5 周 |
| 5 | 双线回归：V1 线全量测试 + V2 线 e2e（dogfooding）+ prompt-lint 扩展 | 0.5-1 周 |
| 合计 | | 4-5 周 |

**版本策略**：V1 线维持 1.x（opencode 1.x stable 用户）；V2 适配以 2.0.0 或 `next` tag 发布（参考 nowledge-mem 的 dual-target 决策，knowledge-co/community#441）。npm 发布前 `test:pack` 需新增 V2 产物检查。

### 6.5 最坏情况

- **现在迁移**：全部工作基于 beta API + 三个未修复 bug，功能不可用且可能重做——沉没 4-5 周。
- **等待但不准备**：官方 V2 GA 时 V1 插件突然失效（官方已明确"V1 plugins will not work in V2"），用户断供窗口期无 V2 版本——被动挨打。
- **等待 + 按 §6.3 准备**（推荐）：GA 时迁移工作量降到 2-3 周，且 GoalStore/事件层抽象使迁移可渐进合并，随时可回滚。

---

## 七、反方观点与不确定项

1. **"V2 遥远，不必理会"的反方**：OpenCode 2.0 仍是 beta，Desktop 还捆绑 V1 server（2026-07-10 拆解），GA 时间未知。**回应**：官方已把"V1 插件不兼容"写进迁移指南（既定事实而非选项），且社区插件（nowledge）已开始跟踪移植，等待的沉没成本是"突然断供"。准备是零风险的（§6.3 不改变行为）。
2. **"官方 native goal 落地则 cabbage 内核无意义"的反方**：若 #32743 合入，cabbage 的 goal 状态机（预算护栏、五道闸、Flow 绑定）或被官方覆盖。**回应**：官方 goal 是"会话级"（per-session），cabbage 是"Flow 级"（GitHub 权威源 + 多 agent 协作 + worktree 并行 + 子 agent 授权），重叠但不覆盖；且 §6.2 的软触发已把该变量纳入决策。真实风险是官方继续扩展 goal 边界，需持续评估。
3. **"V2 的 keyed session context 可以顺便替代 goal 存储"的不确定项**：#34941 的 keyed context 是 prompt 投影通道（内容会进模型上下文），用其存 goal 状态会造成上下文污染；`ctx.storage` 的持久化语义（位置、生命周期、跨重启）尚未在文档中明确。两者都需实测后才能选型。
4. **本文档的时间衰减**：V2 为 beta，本报告结论基于 2026-08-31 时点的 #44788/#40384 状态与事件词汇快照，**6-8 周后需复核**（P0 状态、API 冻结进度、官方 goal 进展）。

---

## 八、参考来源

1. OpenCode V2 迁移指南：https://opencode.ai/v2/docs/migrate-v1/（插件三破坏项、V1 插件不兼容声明）
2. OpenCode V2 插件指南：https://opencode.ai/v2/docs/build/plugins（Plugin.define/setup、transform/hook/subscribe/storage 全貌）
3. OpenCode V2 Effect 插件 API：https://opencode.ai/v2/docs/build/plugins/effect/（Context 域清单）
4. OpenCode V2 Permissions：https://opencode.ai/v2/docs/permissions/（规则数组、action 映射 bash→shell 等）
5. OpenCode V2 Agents/Skills：https://opencode.ai/v2/docs/agents/、https://opencode.ai/v2/docs/skills/（system 字段、遗留字段禁用清单、skill 发现）
6. issue #39345：V1 插件在 V2 SchemaError（anomalyco/opencode）
7. issue #44788：beta-18050 事件零投递 + context/synthetic 注入失效（canary 实验，anomalyco/opencode）
8. issue #40384：V2 未暴露 session metadata（2026-08-03，anomalyco/opencode）
9. issue #34380 + #34941/#34945：session-scoped keyed context contributions 已实现（anomalyco/opencode）
10. issue #27167 / PR #32743：官方 native session goals 进展（anomalyco/opencode）
11. PR #23068：V1 session metadata 支持历史（sst/opencode）
12. nowledge-co/community #441：社区插件的 V2 移植清单（dual-target 策略参照）
13. npm registry：@opencode-ai/plugin（1.18.25 / next / beta-18721，exports 含 ./v2/promise、./v2/effect）、@opencode-ai/client（beta）（2026-08-31 实测）
14. 本项目源码审计：src/index.ts、src/plugin.ts、src/plugin/server.ts、src/plugin/goal.ts（v1.3.0）

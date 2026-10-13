# ADR 0010: OpenCode V2-only 迁移与兼容策略（2.0.0）

**状态:** Accepted（2026-10-14，随 2.0.0 生效）
**日期:** 2026-10-14
**上级:** [ADR 0002](/adr/0002-adopt-thin-workflow-kernel)（薄工作流内核）、[ADR 0009](/adr/2026-08-06-scenario-dispatch-and-research)（场景分诊与子 agent 隔离）

## 背景

- V1 插件实现无法在 OpenCode V2 运行（官方迁移指南明确、无兼容垫片）。
- 2026-08-31 spike 因三个 P0（事件零投递、注入失效、session metadata 未暴露）与 API 未冻结，结论为「暂不迁移」。
- 2026-09-25 复核：在 v2.0.16 GA 上三个 P0 全部实测解除，API 已冻结（报告见 `docs/dev/research/2026-09-25-opencode-v2-plugin-api.md`）。
- 迁移随后落地（PR #139 v2 port、PR #140 内置 Cabbage 引擎），本 ADR 固化决策、机制映射与兼容策略。

## 决策

### 1. 2.0.0 起 V2-only，1.x 线冻结

- 2.0.0 仅依赖 `@opencode/plugin` 2.x；1.x 线冻结，最后一个版本为 1.3.0（含 Codex 兼容层，已发布并在 release notes 标注冻结）。
- **替代方案**：单包双入口（官方支持同一 default export 同时提供 V1 `server()` 与 V2 `setup()`）。
  **拒绝理由**：两套 API 胶水层互不共享，测试、资产 frontmatter 与回归成本翻倍，且 V1 线已到生命周期末期；该方案可在需要时回退采用。

### 2. V1 → V2 机制映射（已实现）

| 能力 | V1 实现 | V2 实现（2.0.0） |
|---|---|---|
| 入口 | `{ id, server(ctx) }` | `Plugin.define({ id, setup(ctx) })`，setup 返回 cleanup |
| skills | 复制到临时目录 + `skills.paths` 注入 | 版本化目录（`~/.config/opencode/cabbage/skills@<version>/`）+ `ctx.skill.transform` 原生注册 |
| commands | `config.command[...]` 模板注入 | `ctx.command.transform` execute 投递模板文本 + `ctx.session.switchAgent` |
| agents | `config.agent[...]` 运行时注入 | `ctx.agent.transform`：缺失则新增（upsert）、已有则保留用户字段，并装配 permissions 规则 |
| 工具门控 | `config.tools` + per-agent `tools` 映射 | agent permissions allow 名单 + 显式 deny（后匹配优先）+ 工具内授权自检 |
| goal 存储 | `session.metadata.goal` | 不变（`ctx.session.get/update`） |
| 消息与记账 | SDK `session.messages` | `ctx.session.context` 投影 + 会话累计 tokens 快照 |
| 首条注入 | `experimental.chat.messages.transform` | `ctx.session.hook("context")` 编辑 `event.system` |
| 自动续接 | idle 事件 + `promptAsync(synthetic)` | 轮次结束事件（`session.execution.*`）+ `ctx.session.synthetic` |
| 子会话活动闸 | `session.children` + `session.status` 查询 | 事件溯源 `SessionActivityTracker`（重启窗口局限已在代码注释记录） |
| 上下文压缩 | 每 20 次续接发 `[compact]` prompt | 每 20 次 `ctx.session.compact`（官方 API） |
| HTTP 客户端 | 自建 `@opencode-ai/sdk/v2` client + 私有 headers | 不再自建，直接使用 ctx 域方法 |

### 3. 兼容与依赖策略

- 依赖声明 `@opencode/plugin: ^2.0.26`，README 注明 tested on v2.0.26。
- 宿主小版本升级：先在本机 dogfood 核心链路（加载、goal、续接、门控、命令/skills/agents、引擎）并更新测试版本声明，再宣称兼容。
- 2.0.0 的 npm 发布时机独立评估；合并 main 不自动触发发布。

### 4. 已知风险与护栏

| 风险 | 护栏 |
|---|---|
| `editor.update` 对缺失 id 的 upsert 语义未见于 V2 文档 | setup 后注册校验：缺失即告警；单测以 `agentUpsert:false` 模拟宿主语义变化 |
| V2 事件词汇可能随版本漂移 | 事件分发集中在 `dispatchEvent` 单点适配 |
| 中断 reason 词汇：TUI Esc 为 `shutdown`（API interrupt 为 `user`） | 两者统一按用户中断暂停（含单测）；服务端关闭走 `execution.failed`，不误伤 autoResume（2026-10-14 实测） |
| 自动续接依赖已建立的客户端会话（一次性 `opencode run` 入队后不消费） | 文档化限制（D2，见验证报告）；面向 TUI 等常驻会话 |
| 项目级 `plugins: ["<绝对目录>"]` 静默不加载 | 文档化限制（D3）：本地开发用 `.opencode/plugins/`，用户安装用 npm 包名 |
| `session.synthetic` 内容达模型 | 已实测通过：续接驱动模型读取 Flow Record、探针消息获回复（见 `docs/dev/research/2026-10-14-v2-e2e-verification.md`） |
| 子会话活动跟踪为内存态，重启窗口内可能漏判 | 代码注释记录局限；子代理结果注入父会话会重新触发事件流 |

### 5. 替代方案与拒绝理由（补充）

- **agents 改为文件安装**（全局 `~/.config/opencode/agents/` 或项目 `.opencode/agents/`）：全局安装会占用 `developer` 等通用 id 并与用户同名 agent 合并；项目安装污染仓库且每个 worktree 重复写入。内存 transform 无这些问题。
- **goal 迁移到 `ctx.storage`**：文档未定义 scan 一致性与生命周期，且 goal 是会话绑定状态（会话删除/导出应带状态语义），session metadata 语义更贴合。
- **依赖 beta 包 `@opencode-ai/plugin@0.0.0-beta-*`**：GA 后包名为 `@opencode/plugin`，beta 线不应作为生产依赖。

## 影响

- V1 用户：停留在 1.3.0（冻结版，含迁移指引）。
- V2 用户：2.0.0（代码已合入 main；npm 发布待定）。

## 参考

1. OpenCode V2 迁移指南与插件文档：<https://opencode.ai/v2/docs/build/plugins/migrate-v1/>
2. V2 插件 API 复核报告：`docs/dev/research/2026-09-25-opencode-v2-plugin-api.md`
3. PR #139（v2 port）、PR #140（内置 Cabbage 引擎）

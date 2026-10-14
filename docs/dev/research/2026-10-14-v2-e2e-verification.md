# 验证报告：opencode-cabbage 2.0.0 在 OpenCode v2.0.26 的端到端实测

- 日期：2026-10-14
- 范围：2.0.0（`feat/embed-cabbage` 分支）在真实 OpenCode v2.0.26 上的核心链路验收
- 方法：隔离 scratch 项目（`/tmp/opencode/cabbage-e2e`）+ 真实模型会话（TUI / `opencode run` / HTTP API）；插件通过 `.opencode/plugins/cabbage.ts` 加载本地构建产物
- 结论：**10 项验收中 9 项一次通过，1 项（TUI Esc 中断）发现真实缺陷并已修复回归通过**；另记录两条主机行为限制

---

## 一、验收结果

| # | 验收项 | 结果 | 证据 |
|---|---|---|---|
| 1 | 插件加载 | ✅ | `/api/plugin` 返回 `opencode-cabbage: active`；`.opencode/plugins/` 发现式加载可用 |
| 2 | goal 工具门控 | ✅ | `dev-lifecycle` 可调用；`general` agent 模型侧确认无 goal 工具（`NO_GOAL_TOOL`，deny 从发现中移除） |
| 3 | 7 个 slash command | ✅ | `/api/command`：code/design/release/requirements/review/setup/tasks |
| 4 | 12 个 flow skill | ✅ | 模型枚举：flow-change/code/design/docs/incident/release/requirements/research/review/setup/tasks/tdd |
| 5 | context 注入（bootstrap） | ✅ | goal active 时模型回复 `MARKER_SEEN`（系统上下文含 `EXTREMELY_IMPORTANT`） |
| 6 | 零输入自动续接 | ✅ | TUI 会话中轮次结束 → synthetic 续接 → 模型自行继续（两次，无用户输入） |
| 7 | synthetic 内容达模型 | ✅ | 探针 synthetic 得到 `MODEL_OK`；续接 prompt 驱动模型读取 Flow Record #999999 |
| 8 | `[BLOCKED:]` → goal 暂停 | ✅ | `status=paused, statusReason=blocked report`；token 记账持久化（334K） |
| 9 | 用户中断 → goal 暂停 | ✅（修复后） | API `session.interrupt` → `reason=user` 原本即通过；**TUI Esc 暴露缺陷，已修复并回归**（见 §二） |
| 10 | cabbage 引擎 light path | ✅ | 真实会话 `cabbage({op:"init"})` 生成 `.cabbage/`（config.yaml/changes/archive/tooling/workflows） |

附带观察：`restoreSessionProfile` 生效（TUI 显示 "Switched model to …" / "Switched agent to Dev-Lifecycle"）；goal 状态完整持久化在 session metadata（含 sessionProfile/tokensUsed/continuationCount）。

---

## 二、缺陷 D1：TUI Esc 不暂停 goal（已修复）

**现象**：用户按 Esc 中断后，goal 仍为 active；下一条消息结束轮次时会重新触发续接（正是 abort 暂停机制要防的场景）。

**根因（探针实证）**：`session.execution.interrupted` 的 `reason` 取值集合为 `user | shutdown | superseded | inactivity`：
- API `POST /api/session/{id}/interrupt` → `reason=user`（原代码只认这个）；
- TUI Esc → **`reason=shutdown`**（原代码直接 return，不暂停）。

**服务端关闭不会误伤 autoResume（实测）**：SIGTERM 杀掉私有 server 时，插件观察到的是 `session.step.failed` + `session.execution.failed`，**不会**产生 `interrupted(shutdown)`。因此把 `shutdown` 视为用户中断是安全的（插件对 `execution.failed` 本来就不暂停，留给 autoResume 恢复）。

**修复**：`dispatchEvent` 对 `reason ∈ {user, shutdown}` 统一走“立即持久化 pause + markAborted”；单测 `it.each(["user","shutdown"])` 覆盖两条路径，并用 `superseded` 锁定“非用户原因不暂停”。

**回归**：修复构建后，在私有 server + TUI 复现原场景（goal active → 续接运行中按 Esc）→ `status=paused, statusReason=aborted by user`。

---

## 三、主机行为限制（文档化，不修改代码）

### D2：自动续接依赖已建立的客户端会话

一次性 `opencode run` 会话：轮次结束的瞬间 CLI 即退出，插件入队的 synthetic 续接在无客户端驱动时不被消费（实测消息停留在 inbox，`resume:true` 亦不例外）；重新附着客户端（TUI / `opencode run --session`）后队列立即被消费。**结论：自动续接面向 TUI 等常驻会话；`opencode run` 一次性会话不保证续接**（脚本化场景需自行保持会话客户端）。

### D3：本地插件加载形式

- 可用：`.opencode/plugins/*.ts`（发现式，本地构建产物经 re-export shim 加载，本次验证方式）；npm 包名（文档主推安装方式，需全局安装后生效）。
- 不可用：项目 `opencode.json` 的 `plugins: ["<绝对目录>"]` 静默不加载（`/api/plugin` 无条目、无报错），项目内 `node_modules` symlink + 包名亦不解析。
- 建议 README 安装说明继续使用 npm 包名形式（`opencode plugin add`），本地开发用 `.opencode/plugins/`。

---

## 四、复现与证据

- scratch 项目：`/tmp/opencode/cabbage-e2e/`（`opencode.json`、`.opencode/plugins/{cabbage,event-probe}.ts`）
- 事件流证据：`/tmp/opencode/cabbage-e2e/evidence/events.log`（探针插件记录中断 reason 等）
- 会话导出：`/tmp/opencode/cabbage-e2e/evidence/session-export*.json`（goal 状态、消息时间线）
- 修复回归会话：私有 server `:4793` + `ses_ec8827e8affeykUURdJUpu6Wpr`（goal #888888）

## 五、结论

2.0.0 的 V2 迁移在 v2.0.26 上核心链路可用；D1 修复后 10/10 验收项通过。D2/D3 为主机边界行为，已在 ADR 0010 与本报告记录。

## 附：v2.0.28 基线复验（2026-10-14 同日）

基线从 v2.0.26 升级到 v2.0.28（CLI 与 `@opencode/plugin` 依赖）后，按 ADR 0010 §3 的宿主小版本升级流程复验核心链路（隔离数据目录 + 真实模型会话，隔离项目与上文相同）：

| 链路 | 结果 | 证据 |
|---|---|---|
| 插件加载（`.opencode/plugins/` shim） | ✅ | `/api/plugin`：`opencode-cabbage: active`（`api-28-plugin.json`） |
| agents / commands / skills 注册 | ✅ | cabbage agents、7 个命令、12 个 flow-* skills（`api-28-agent.json`、`api-28-command.json`、`api-28-skill.json`） |
| goal 创建与持久化 | ✅ | S1 metadata：`parentIssueNumber: 888888`、token 记账 99301（`S1-session-28.json`） |
| 首条上下文注入 | ✅ | 模型回复 `MARKER_SEEN`（`EXTREMELY_IMPORTANT` 在系统上下文） |
| 零输入自动续接 | ✅ | 两例：客户端（`run --session`）附着即消费队列、模型自行调查 #888888；TUI 附着后自行启动续接 |
| 用户中断 → 暂停 | ✅ | TUI Esc → 探针捕获 `session.execution.interrupted` `reason=shutdown`（`events.log`）→ goal `paused / aborted by user` |
| 门控负向（general） | ✅ | 模型回复 `NO_GOAL_TOOL` |
| cabbage 引擎 | ✅ | `cabbage op init` → `.cabbage/` 重建（config.yaml、workflows/change.yaml 等） |

- 2.0.28 中断 reason 联合类型未变（`user | shutdown | superseded | inactivity`，`@opencode/schema` 复核）；D2/D3 行为与 v2.0.26 一致。
- 复验证据：`/tmp/opencode/cabbage-e2e/evidence/`（`serve-28.log`、`api-28-*.json`、`S1-messages-28.json`、`events.log`）。

## 附二：2.0.0 npm 安装路径验证（发布后，2026-10-14 同日）

2.0.0 发布到 npm 后，补齐上文 D3 缺口：**npm 包名安装形式**的端到端验证（隔离环境：独立 `XDG_CONFIG_HOME` / `XDG_DATA_HOME` / `XDG_CACHE_HOME`，CLI v2.0.28）：

1. `opencode plugin add @devcxl/opencode-cabbage` → 写入全局配置 `plugins: ["@devcxl/opencode-cabbage"]`
2. 启动私有 server → 宿主从 npm 解析 `@latest`（实测拉取到 **2.0.0**）并加载：`/api/plugin` 显示 `opencode-cabbage: active`，cabbage 的 7 个命令（code / design / release / requirements / review / setup / tasks）全部注册（证据 `api-pluginadd-*.json`）

**发布传播窗口观察**：首次解析（发布后约 4 分钟内）曾拉到旧版本 1.3.0 并加载失败——v1 形态默认导出（`{ id, server }`）不满足 v2 schema（要求 `setup`/`effect`），宿主报 `Plugin must export a default definition with an id and an effect or setup function`；清理插件缓存重取即恢复（npm install-metadata 滞后于 dist-tags 的窗口）。升级/刷新场景可用 `opencode plugin update` 强制重取。

至此 D3 关闭：`.opencode/plugins/` 与 npm 包名（`opencode plugin add`）两种加载形式均实测可用。

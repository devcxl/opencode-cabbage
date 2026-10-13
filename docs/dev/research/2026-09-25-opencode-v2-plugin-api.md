# 复核报告：OpenCode V2 插件 API 现状与 opencode-cabbage 迁移可行性（2026-09-25）

- 日期：2026-09-25
- 范围：复核 `2026-08-31-opencode-v2-compat-spike.md` 的假设集（三个 P0 阻断 + API 是否冻结），基于 **本机实测 opencode v2.0.16（GA）** 的官方包类型定义、V2 官方文档、issue/PR tracker，以及一次受控运行时探针。
- 方法：① 读取本机真实加载的 V2 包 `~/.config/opencode/node_modules/@opencode/{plugin,client,schema}@2.0.16` 的 `package.json`/`dist/*.d.ts`；② 读取 `opencode.ai/v2/llms.txt` 及其列出的权威页面（**仅 V2**，未使用 `/docs/` V1）；③ GitHub API 查询 #44788/#40384/#27167/#32743 状态；④ 在 `/tmp` 一次性探针项目上运行 `opencode v2.0.16` 实测事件投递、metadata 读写、context 注入。
- 结论先行：**三个 P0 在 v2.0.16 上均已实测解除；API 已 GA 冻结；从 API 条件看可启动迁移。** 这只是迁移可行性评估，不表示本插件已完成迁移或支持 OpenCode v2：当前实现仍使用 `@opencode-ai/plugin` 1.x 插件 API，尚未完成适配，因此本插件目前暂不支持 OpenCode v2。唯一未完成实测的是 `session.synthetic` 的内容是否进入模型 prompt（本次因 provider 凭据失败未验证），但该路径有 `session.prompt({resume})` 作为等价替代。
- API 标识符保持英文原文，其余叙述为中文以对齐既有 spike 文档风格。

> **状态更新（2026-10-14）**：本报告的迁移建议已落地。2.0.0 完成 V2-only 迁移（PR #139/#140）；三个 P0 在 v2.0.16 / v2.0.26 实测解除；`session.synthetic` 内容达模型已由端到端验证确认。决策与机制映射见 [ADR 0010](../adr/2026-10-14-opencode-v2-only-migration.md)，端到端验收见 `2026-10-14-v2-e2e-verification.md`。本文保留为迁移前评估快照。

---

## 一、结论摘要

1. **入口 API 已从 beta 的 `@opencode-ai/plugin@0.0.0-beta-*` 更名为 `@opencode/plugin@2.0.16`（GA，`latest` tag）。** 这是本报告最重要的版本事实：旧 spike 依据的 npm 包名/`./v2/*` 子路径是 beta 预览形态，**不是** GA 形态。
2. **P0 全部解除（v2.0.16 运行时实测）**：
   - R1 事件订阅：#44788 仍 open（最后实测点 beta-19271，2026-09-11），但本机 v2.0.16 上 `ctx.event.subscribe()` **正常投递**，包括 `session.created`/`session.metadata.updated`/`session.status`/`session.idle`/`session.execution.*`/`session.step.*`/`session.text.*` 等业务事件。
   - R2 注入路径：`ctx.session.hook("context")` 中 `event.system.push({type:"text",text:"CANARY-9F3A"})`，模型**原样复述了 canary**，证明 context 注入已到达模型 prompt。
   - R3 session metadata：`session.create/update/get` 的 metadata **可写可读**（实测写入 `{"goal":{"phase":"updated","n":42}}` 并读回），并触发 `session.metadata.updated` 事件。`goal` 状态可继续存在 session metadata。
3. **V2 config 面键名已变**：`skills`（字符串数组，非 `skills.paths`）、`commands`（复数，非 `command`）、`agents`（复数，非 `agent`）、`plugins`（非 `plugin`）。**但命令的 `template/agent/model/subagent` 语义在 V2 config 中保留**，7 个 slash command 可低成本迁移。
4. **官方 native goal 未落地**：#32743 PR **closed 未 merge**，`#27167` 仍 open，v2.0.16 客户端类型中**无 `session.goal` API**，V2 文档全文无 goal 特性。cabbage 的 goal 工具生态位**未被官方挤占**。
5. **可复用资产不变**：`kernel/`、`assets/` 的迁移结论与旧 spike 一致；重写面集中在 `src/plugin/` 的 API 胶水层，但因 metadata 复活与 config 命令语义保留，工作量比旧 spike 预估的更小。

---

## 二、版本与实测基线（2026-09-25）

| 项 | 观测值 | 来源 |
|---|---|---|
| CLI 版本 | `opencode v2.0.16` | `opencode --version`（shell） |
| 运行 channel | `latest` | 运行时 `ctx.app.channel`（探针 events.log） |
| `@opencode/plugin` dist-tags | `latest=2.0.16`、`beta=0.0.0-beta-19507`、`dev=0.0.0-dev-20120`、`reserved=0.0.0-reserved` | `npm view @opencode/plugin dist-tags` |
| `@opencode/client` dist-tags | `latest=2.0.16`、`beta=0.0.0-beta-19507`、`dev=0.0.0-dev-20122` | `npm view @opencode/client dist-tags` |
| `@opencode/schema` dist-tags | `latest=2.0.16`、`beta=0.0.0-beta-19507` | `npm view @opencode/schema dist-tags` |
| `@opencode-ai/plugin` dist-tags（V1 线） | `latest=1.18.32`、`beta=0.0.0-beta-19271`、`dev=0.0.0-dev-202609221946` | `npm view @opencode-ai/plugin dist-tags` |
| `@opencode-ai/sdk` dist-tags（V1 线） | `latest=1.18.32`、`beta=0.0.0-beta-19271` | `npm view @opencode-ai/sdk dist-tags` |
| 本机实际加载的 V2 包 | `@opencode/plugin@2.0.16`（`~/.config/opencode/node_modules/@opencode/plugin`） | 文件 `package.json` |
| 全局配置依赖 | `"@opencode/plugin": "2.0.16"`、`@opentui/core@0.5.12` | `~/.config/opencode/package.json` |
| 全局配置 `plugins` 条目 | `[]`（server 插件）；TUI 插件在 `cli.json.plugins` | `~/.config/opencode/opencode.json`、`cli.json` |
| 本仓库现状 | `@opencode-ai/plugin ^1.17.0`、`@opencode-ai/sdk ^1.17.14`、`repo node_modules` 实装 `@opencode-ai/plugin@1.18.10`（含 `./v2/*` 预览导出） | `/home/devcxl/Projects/OpenCodePlugins/opencode-cabbage/package.json`、`node_modules/@opencode-ai/plugin/package.json` |

> 注意：任务描述里的 `@opencode-ai/client` 与 `@opencode-ai/plugin` 是 V1 scope。**V2 的官方包是 `@opencode/*`（无 `-ai`）**，`@opencode-ai/client` 在 npm 上 latest 为 `0.0.0`（无 V2 线），不应使用。

---

## 三、Q1 入口 / API 形状（当前 V2）

### 3.1 Promise 入口（默认，GA）

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "example",
  async setup(ctx) {
    // ... 注册 hooks/transforms/tools/commands/事件订阅
    return () => { /* cleanup */ }
  },
})
```

- **CONFIRMED（类型）**：`~/.config/opencode/node_modules/@opencode/plugin/dist/promise/plugin.d.ts`
  - `interface Plugin { readonly id: string; readonly setup: (context: Context) => Promise<Cleanup|void>|Cleanup|void }`
  - `declare function define(plugin: Plugin): Plugin`
  - `type Cleanup = () => Promise<void> | void`
  - `interface Context`：`app, location, options, agent, aisdk, command, event, experimental.terminal, integration, mcp, model, generate, permission, plugin.list, provider, reference, rpc, session, shell, skill, storage, tool, vcs, websearch, worktree`。
- **CONFIRMED（实现）**：`dist/promise/plugin.js` 中 `define` 是恒等函数 `return plugin`。**运行时实测**：直接 `export default { id, setup }` 的普通对象也能被加载（探针成功），即 loader 只要求 `id` + `setup` 形状，不要求 `define` 标记。
- **CONFIRMED（文档）**：https://opencode.ai/v2/docs/build/plugins/ —— `.opencode/plugins/example/index.ts` 用 `Plugin.define({ id, async setup(ctx){...} })`；`setup` 可返回 cleanup 函数。

### 3.2 Effect 入口

```ts
import { Plugin } from "@opencode/plugin/effect"
import { Effect } from "effect"
export default Plugin.define({ id: "example", effect: (ctx) => Effect.gen(function*(){ ... }) })
```

- **CONFIRMED（类型/文档）**：`dist/effect/plugin.d.ts`：`interface Plugin<R=Scope.Scope> { id; effect: (context) => Effect.Effect<void,never,R> }`；文档 https://opencode.ai/v2/docs/build/plugins/effect/。

### 3.3 loader 要求 / package.json / `oc-plugin`

- **CONFIRMED（文档）**：发布包通过配置 `plugins` 数组加载（`"name"`、`"name@version"`、`{package, options}` 对象形式）；本地插件从 `.opencode/plugins/` 与 `.opencode/plugin/`（V2 用 `plugins/`）自动发现（https://opencode.ai/v2/docs/plugins/、migrate-v1）。
- **CONFIRMED（类型，间接）**：`@opencode/plugin` 的 `exports` map 为 `.`→`dist/promise`、`./effect`、`./host`、`./tui`、`./*`（`dist/*.js`）。加载器按默认导出形状识别 server 插件；`@opencode/schema/plugin` 的 `Features { server?, tui?, rpc? }` 描述插件能力。
- **INFERRED（未证实）**：**找不到 `oc-plugin` 字段仍被 V2 读取的证据**。V2 文档从未提及 `oc-plugin`；新配置机制为 `plugins` + 默认导出。V2 binary 的 `strings` 中未出现 `oc-plugin`（bun 编译压缩，属弱证据）。
  → 迁移动作：cabbage 的 `"oc-plugin": ["server"]` 在 V2 包中**大概率无用**，可保留以兼容 V1 线，但不应作为 V2 加载依据；V2 依赖配置 `plugins` 或 `.opencode/plugins/`。
- **CONFIRMED（运行时踩坑）**：本地 `.opencode/plugins/*.ts` 若 `import "@opencode/plugin"`，**该包必须在插件可解析的 node_modules 中**，否则报 `ResolveMessage: Cannot find package '@opencode/plugin'` 且插件被静默跳过（server log `failed to load plugin`）。V2 文档示例假定了包已安装。

---

## 四、Q2 包 / 版本 / 依赖关系

| 问题 | 结论 | 证据 |
|---|---|---|
| V2 插件应依赖哪个包 | **`@opencode/plugin`，与目标 OpenCode 版本兼容，当前 `2.0.16`** | docs plugins：「Published plugins should depend on a version of @opencode/plugin compatible with the OpenCode release they target」；本地实装 2.0.16 |
| 依赖哪个 dist-tag/版本范围 | 生产用精确/兼容版本（如 `^2.0.16`）；预览用 `beta`/`dev`。GA 后不应再依赖 `0.0.0-beta-*` | `npm view` alt；package.json |
| 是否必须 `@opencode/client` | 否（对纯 server 插件）。它是 `@opencode/plugin` 的依赖（`2.0.16`），用于 ctx 的类型来源；仅当你**独立构建客户端 / 定义 RPC 合约**时才直接依赖 | `@opencode/plugin/package.json` dependencies 含 `@opencode/client@2.0.16`；docs build/client |
| `@opencode-ai/plugin ^1.x` 是否过时 | **是（对 V2 而言）**。它是 V1 线（latest `1.18.32`），其 `./v2/*` 子路径是 beta 预览导出 | `@opencode-ai/plugin@1.18.10` 的 exports 含 `./v2/promise`、`./v2/effect` |
| `@opencode-ai/sdk/v2` 是否过时 | **是**。V2 客户端为 `@opencode/client`（`2.0.16`） | docs build/client：「`@opencode/client` is the TypeScript client for the OpenCode HTTP API」 |

---

## 五、Q3 三个 P0 复核

### 5.1 (a) 事件订阅是否投递 —— ✅ 已解除（运行时 CONFIRMED）

**探针**（`/tmp/opencode/probe/.opencode/plugins/probe.ts`，v2.0.16 `latest` channel）：`setup` 内 `for await (const e of ctx.event.subscribe({signal}))` 写日志，然后经 HTTP 创建/更新 session。

实测收到的 `event.type`（节选，全部来自 events.log）：

```
skill.updated, model.updated, provider.updated, websearch.updated, integration.updated,
command.updated, agent.updated, reference.updated, plugin.updated,
session.created, session.agent.selected, session.inbox.enqueued, session.execution.started,
session.instructions.updated, session.inbox.delivered, session.step.started, session.step.failed,
session.execution.failed, session.metadata.updated, session.text.started, session.text.delta,
session.text.ended, session.step.streamed, session.step.ended, session.execution.succeeded
```

**V1 → V2 事件词汇映射**（source：`~/.config/opencode/node_modules/@opencode/schema/dist/session-*.d.ts`、`@opencode/client/.../generated/types.d.ts`，事件 `V2Event` 联合见 types.d.ts:3301）：

| V1 事件 | V2 等价 | 说明 |
|---|---|---|
| `session.status`（idle） | **`session.status`**（`data:{sessionID, status}`，`SessionStatus = {type:"idle"}\|{type:"retry",attempt,message,next}\|{type:"busy"}`）与 **`session.idle`**（`data:{sessionID}`） | types.d.ts:571（SessionStatus）、2396（SessionStatusUpdated，type 字面量 `"session.status"`）、1736（SessionIdle，type `"session.idle"`） |
| `session.error`（abort） | **`session.error`**、`session.execution.failed`、`session.execution.interrupted`、`session.retry.scheduled` | 事件类型枚举（schema 全量检索）；`SessionError.Error = {type,message,status?}` |
| `message.updated` | **`message.updated`**、`message.part.updated`、`message.part.delta`、`session.message.content.updated` | 事件类型枚举 |
| `session.updated` | **`session.updated`**、`session.metadata.updated`、`session.renamed`、`session.created`、`session.deleted` | 事件类型枚举 |
| 用户输入入队 | **`session.inbox.enqueued`**（`data:{sessionID,inboxID,item}`） | types.d.ts:3167 |

> **结论**：旧 spike「V2 未见 `session.status`/`session.idle` 等价物」的判断在 2.0.16 **不成立**；`session.status` 与 `session.idle` 均存在且实测投递。
> **#44788 状态**：仍为 **OPEN**（updated 2026-09-11），最新 comment（`OpenJawCode`）在 **beta-19271** 上仍复现 context 注入失败。**这与本机 2.0.16 实测相矛盾**——beta 通道（`0.0.0-beta-*`）与 GA `2.0.16` 是不同发布线，修复可能只进了 GA。迁移应以 2.0.16 实测为准。

### 5.2 (c) session metadata 是否暴露 —— ✅ 已解除（类型 + 运行时 CONFIRMED）

- **类型 CONFIRMED**：
  - `SessionInfo.metadata?: SessionMetadata`（`{~[k]:JsonValue}`）—— `@opencode/client/.../generated/types.d.ts:2779`；schema 侧 `session.d.ts:164`。
  - `SessionUpdateInput { sessionID; title?; metadata?; permissions? }` —— types.d.ts:5316。
  - `SessionCreateInput` 含 `metadata?` —— types.d.ts:3689。
  - 事件 `SessionMetadataUpdated`（type `"session.metadata.updated"`, `data:{sessionID, metadata}`）—— types.d.ts:1884。
- **运行时 CONFIRMED**：`session.create` 带 `metadata` → `session.get` 读回 `{"goal":{"phase":"probe"}}`；`session.update` 写 `{"goal":{"phase":"updated","n":42}}` → 读回一致；events.log 收到 `session.metadata.updated`。
- **#40384 状态**：仍 OPEN（feature request，updated 2026-09-13），但 2026-09-13 comment 已引用 PR **#48059**（creation-time metadata）与 **#47486**（live updates）。**在 2.0.16 上，读写路径均已可用**，issue 描述已过时。
- **goal 存储结论**：`session.metadata.goal` **可以作为 V2 的 GoalStore 实现**（无需换 `ctx.storage`）；旧 spike 的「必须换存储」结论作废。`ctx.storage` 仍可作为备选。

### 5.3 (b) synthetic / context 注入 —— context 已到达模型（运行时 CONFIRMED）；synthetic 内容未验证

- **context 注入 CONFIRMED（运行时）**：探针注册
  ```ts
  await ctx.session.hook("context", (event) => {
    event.system.push({ type: "text", text: "CANARY-9F3A" })
  })
  ```
  `opencode run --agent developer -m half-cabbage/glm-5.3-flash "若系统上下文出现 CANARY-9F3A 则原样回复"` → 模型输出 **`CANARY-9F3A`**。events.log 记录 `CONTEXT HOOK fired systemLen=4->5`。→ **`session.hook("context")` 的 `system` 变更确实进入模型 prompt**。
- **`ctx.session.*` 方法（类型 CONFIRMED，`dist/promise/session.d.ts`）**：
  - `SessionDomain = Pick<SessionApi,"create"|"get"|"switchAgent"|"switchModel"|"prompt"|"generate"|"command"|"synthetic"|"interrupt"|"update"|"move"|"wait"|"context"> & { hook: ModelHooks<SessionHooks> }`
  - `SessionHooks`：`prompt | context | compaction | generate | title | "model.request" | "http.request" | "http.response" | "experimental.ws.handshake" | "experimental.ws.send" | "experimental.ws.receive" | retry`
  - `SessionPrompt { sessionID; messageID; prompt: PromptInput.Prompt; metadata?; delivery }`
  - `SessionContext extends SessionRequest { agent; tools }`，`SessionRequest { sessionID; model: Model.Ref; system: SystemPart[]; messages: Message[]; options }`
- **prompt / synthetic 输入（类型 CONFIRMED，types.d.ts）**：
  - `SessionPromptInput { sessionID; text; files?; agents?; skills?; metadata?; delivery?: "steer"|"queue"; resume?: boolean }` → 返回 `SessionInboxUser`（types.d.ts:5369、3101）。
  - `SessionSyntheticInput { sessionID; text; description?; metadata?; delivery?; resume? }` → 返回 `SessionInboxSynthetic`（types.d.ts:5863、857）。
- **synthetic 运行时**：`session.synthetic({sessionID,text})` 被接受并创建 inbox synthetic 消息，且**触发了 agent loop**（events.log 出现 `session.execution.started`），随后因**默认模型凭据失败**（`AI.Error.Authentication: Invalid credential`，与 V2 无关）而 `session.execution.failed`。→ **synthetic 会调度执行（CONFIRMED）**；**synthetic 文本是否进入模型 prompt 本次未验证（UNVERIFIED）**。
  - 缓解：`session.prompt({..., resume:true})` 亦可调度 agent loop；context hook 已验证可用于向模型注入内容。自动续接至少有两条可用路径。

### 5.4 `ctx.storage` 语义

- **CONFIRMED（类型 + 文档）**：`StorageDomain { get(key): Promise<Json|undefined>; set(key,value:Json): Promise<void>; remove(key):Promise<void>; scan(options:{prefix,after?,limit?}): Promise<{entries,next?}> }`（`dist/promise/storage.d.ts`；docs build/plugins Storage 节）。运行时 `ctx.storage.set` 成功。
- **持久性/作用域**：文档称「durable JSON values **scoped to the plugin**」，且「Plugin storage is scoped by this ID」（migrate-v1）；即随插件 id 分区、跨重载/重启持久。
- **文档沉默**：物理存储位置、保留策略、容量上限、`scan` 是否跨重启一致——**V2 文档未说明**（INFERRED 为 server DB 内持久，未证实）。

---

## 六、Q4 Transforms 与 V2 config 面

### 6.1 Transform 签名（类型 CONFIRMED，`dist/promise/*.d.ts`）

统一形状：`Transform<Editor> = (callback:(editor:Editor)=>void) => Promise<Registration>`，`Registration { dispose(): Promise<void> }`。

| 域 | 方法 | Editor 能力 |
|---|---|---|
| tool | `ctx.tool.transform` | `list/get/namespace/add/update/remove`；`add(Info)`，`Info.input` 为 **JSON Schema** |
| skill | `ctx.skill.transform` | `list/get/add/update/remove`；`add(Skill.Info{id,name,description?,autoinvoke?,path,content})` |
| command | `ctx.command.transform` | `add({name, description?, execute})` |
| agent | `ctx.agent.transform` | `list/get/default/update/remove` |
| provider/model/reference/integration/mcp/websearch/vcs/worktree | 同名 transform | 见 docs build/plugins |

- **CONFIRMED（migrate-v1）**：V1 `chat.params/chat.headers/experimental.chat.system.transform/experimental.chat.messages.transform/compaction` → `ctx.session.hook("context"|"model.request"|"compaction"|...)`；V1 `tool.execute.before/after` → `ctx.tool.hook("execute.before"/"execute.after")`；V1 `permission.ask` → `ctx.permission.hook("evaluate")`；V1 `shell.env` → `ctx.shell.hook("create.before")`。
- **CONFIRMED（migrate-v1）**：V2 无单一可变全局 config 对象，config 类扩展按域注册 transform。
- **V1 `command.execute.before` 无一一对应全局 hook**：用 `ctx.command.transform`（若插件拥有该命令）或 `session.hook("prompt")`。

### 6.2 V2 config 面键名（类型 CONFIRMED）

`~/.config/opencode/node_modules/@opencode/schema/dist/config.d.ts` 顶层字段（节选）：

| V2 键 | 类型 | 旧 V1 键 | 判定 |
|---|---|---|---|
| `skills` | `string[]`（目录/URL，可多条） | `skills.paths[]` | **键名/形状均变**；V2 是数组不是对象 |
| `commands` | `Record<string, ConfigCommand.Info>` | `command`（单数 map） | **单数→复数** |
| `agents` | `Record<string, ConfigAgent.Info>` | `agent`（单数 map） | **单数→复数** |
| `plugins` | `(string \| {package, options})[]` | `plugin` | **单数→复数，tuple→object** |
| `permissions` | `Rule[]` | `permission` 对象 | **对象→规则数组** |
| `instructions`, `mcp`, `compaction`, `providers`, `experimental` … | — | 同名为主 | 复用 |

- **CONFIRMED（docs commands）**：`commands` 条目字段 `template`(JSON 必填)、`description`、`agent`、`model`、`subagent`、`subtask`(deprecated alias)。Markdown 命令 frontmatter 接受同样字段，body 即 template。
- **CONFIRMED（docs agents）**：agent 字段 `model`、`system`（V1 `prompt`→V2 `system`）、`description`、`mode`(primary/subagent/all)、`hidden`、`color`、`steps`、`disabled`、`permissions`。V1 遗留 `tool`/`permission`/`prompt` 不再使用。
- **CONFIRMED（docs skills）**：`skills` 数组支持相对/`~`/绝对路径与 HTTP catalog，多配置文件**合并而非替换**。
- **can transform 仍存在**：V2 **不强制**用 transform；`commands`/`agents`/`skills` 配置键可覆盖 cabbage 的 `config` hook 大部分需求。

### 6.3 V2 命令形态

- **配置式（保留 template/agent/model 语义）**：`commands.review = { template, agent, model, subagent }`。
- **程序式（transform）**：`ctx.command.transform(editor => editor.add({ name, description?, execute: async ({sessionID, prompt, delivery}) => { await ctx.session.prompt({...prompt, sessionID, text: ...}) } }))`（`dist/promise/command.d.ts`；docs build/plugins Commands）。
- 程序式 `execute` 里常以 `ctx.session.prompt` 回投，保留请求的 `delivery`。

---

## 七、Q5 权限与工具门控

- **CONFIRMED（类型）**：`@opencode/schema/permission.d.ts`：`Rule { action: string; resource: string; effect: "allow"|"deny"|"ask" }`；`Ruleset = Rule[]`。
- **CONFIRMED（类型）**：`@opencode/schema/tool.d.ts`：`Tool.Options = { namespace?; permission?: string } & ({codemode?:true;pinned?} | {codemode:boolean;pinned?:never})`；`Tool.Info { name; input; description; execute; output?; options? }`。→ **自定义工具可用 `options.permission` 指定其权限 action 名**。
- **CONFIRMED（docs permissions）**：action 为字符串，**插件可自行定义 action**；内置 action 表含 `read/edit/glob/grep/shell/subagent/skill/question/webfetch/websearch/external_directory/execute/<server>_<tool>`。规则合并「last match wins」，agent 规则**追加**在全局之后；子 agent **用自己的权限**，不继承父集合。
- **cabbage 的 V1 门控 `config.tools.goal=false` + per-agent `tools` map → V2 建议**：
  1. 注册 goal 工具时 `editor.add({ name:"goal", ..., options:{ permission:"goal" } })`；
  2. 全局 `permissions` 加 `{action:"goal", resource:"*", effect:"deny"}`；
  3. 在允许的 agent（如 `dev-lifecycle`/`goal-verify`）下加 `{action:"goal", resource:"*", effect:"allow"}`。
  - 因默认 base policy 为 `{action:"*",resource:"*",effect:"allow"}`，**必须显式 deny 才能限制**。
- **文档沉默**：未指定 `options.permission` 时，插件工具的默认 action 名——**未文档化**（INFERRED 为工具名；MCP 工具为 `<server>_<tool>`）。

---

## 八、Q6 Session API 对照（V1 → V2，类型 CONFIRMED）

来源：`@opencode/client/dist/promise/client.d.ts`、`generated/types.d.ts`。

| 能力 | V2 方法（Promise client / `ctx.session`） | 关键载荷 |
|---|---|---|
| 创建 | `session.create` | `{id?,title?,agent?,model?,location?,metadata?,permissions?}` → `SessionInfo` |
| 获取 | `session.get` | `{sessionID}` → `SessionInfo` |
| 更新 | `session.update` | `{sessionID,title?,metadata?,permissions?}` → `void` |
| 删除 | `session.remove` | `{sessionID}` |
| 列出/子会话 | `session.list` | `{limit?,order?:"asc"\|"desc",search?,parentID?,directory?,project?,subpath?,cursor?}` → `SessionsResponse{data:SessionInfo[],cursor}` |
| 活动状态 | `session.active()` | → `{[sessionID]: SessionActive}`，`SessionActive={type:"running"}`（types.d.ts:253、5264） |
| 状态事件 | 事件 `session.status` | `data:{sessionID,status:SessionStatus}`，`SessionStatus=idle\|retry\|busy`（types.d.ts:571/2396） |
| 空闲事件 | 事件 `session.idle` | `data:{sessionID}`（types.d.ts:1736） |
| 消息（带 limit） | 顶层 `client.message.list` | `{sessionID,limit?,order?,cursor?,type?}` → `SessionMessagesResponse{data:SessionMessageInfo[],cursor}`（types.d.ts:7015/3284） |
| 消息（单条） | `session.message.get` | `{sessionID,messageID}` |
| 上下文投影 | `session.context` | `{sessionID}` → `SessionMessageInfo[]` |
| 切换 agent/model | `session.switchAgent` / `session.switchModel` | `{sessionID,agent}` / `{sessionID,model:{providerID,id,variant?}}` |
| 发 prompt | `session.prompt` | `{sessionID,text,files?,agents?,skills?,metadata?,delivery?:"steer"\|"queue",resume?}` → `SessionInboxUser` |
| 合成消息 | `session.synthetic` | `{sessionID,text,description?,metadata?,delivery?,resume?}` → `SessionInboxSynthetic` |
| 命令 | `session.command` | `{sessionID,command,arguments?}` |
| 中断 | `session.interrupt` | `{sessionID,resume?}` → `{interrupted:boolean}` |
| 等待 | `session.wait` | `{sessionID}` |
| diff | `session.diff` | `{sessionID,from?,to?,context?}` → `FileDiffInfo[]` |
| inbox | `session.inbox.list/cancel/update` | — |

- **注意**：V2 **没有** `session.status(id)` 查询方法；实时状态用 `session.active()` 或订阅 `session.status`/`session.idle` 事件。旧 cabbage「子会话活动闸」需改为 `session.list({parentID})` + `session.active()`/事件组合。

---

## 九、Q7 开发 / 测试 / 发布

- **本地加载（CONFIRMED docs + 运行时）**：
  - 自动发现：`.opencode/plugins/*.ts|js` 与 `.opencode/plugins/<pkg>/`（V2 用 `plugins/`，`plugin/` 兼容）；全局同布局于 `~/.config/opencode/plugins/`。
  - 显式配置：`opencode.json(c).plugins = ["name","name@1.2.0","@scope/name","./plugins/local","../shared/plugin","/abs/path","file:///...", {package,options}]`；相对路径相对**声明它的配置文件**。
  - **前提**：本地 `.ts` 若 import `@opencode/plugin`，需在项目中安装该包（本次探针因缺失而加载失败；V2 官方示例假定已安装）。
- **CLI（CONFIRMED `opencode plugin --help`）**：`opencode plugin list/add/check/update/remove`；`add` 支持 npm 名/版本/tag/range 与 npm 兼容 Git 规格、`::path:` 子目录；**不接受 tarball 与 npm alias**。`list --builtin` 查看内置插件。
- **发布（CONFIRMED docs）**：npm 包默认导出 `Plugin.define`；package.json 依赖 `@opencode/plugin` 兼容版本即可。文档未要求 `oc-plugin` 字段（INFERRED 已废弃）。
- **验证清单（migrate-v1 原文要求）**：① 确认 ID 与来源出现在 plugin list；② 逐个触发每个 hook/transform/tool/command/事件订阅；③ 通过 reload/remove 验证 cleanup；④ 用干净项目测试 options 与持久状态；⑤ 发布包要测**安装后的包**而非仅 workspace link。
- **双版本共存（CONFIRMED migrate-v1）**：同一默认导出可同时展开 `Plugin.define({id,setup})`（V2）与 `async server(){return {...}}`（V1）；V1 object entrypoint 需 OpenCode **1.18.29+**。

---

## 十、Q8 官方 native goals

| 证据 | 状态 |
|---|---|
| issue #27167 `[FEATURE]: Add native session goals with /goal` | **OPEN**（created 2026-05-12，updated 2026-09-19，79 comments） |
| PR #32743 `feat(session): native per-session goals...` | **CLOSED，未 merge**（`merged:false`，base `dev`，closed 2026-07-17） |
| v2.0.16 客户端类型 | **无 `session.goal` / goal 相关方法**（client.d.ts 全量方法列表无 goal） |
| V2 文档 | skills/agents/commands/config/tools/permissions/build 全文检索 **无 goal 特性** |
| 社区实现 | #27167 comment 提到 PR #28610「以插件实现 create_goal/update_goal/get_goal + /goal，状态存 `.opencode/goals.json`」 |

**结论（CONFIRMED 缺失）**：v2.0.16 **无官方 native goal**；cabbage 的 goal 工具/状态机生态位未被官方覆盖。旧 spike 的软触发条件（native goal 落地）**未触发**，但 issue 仍活跃，需持续观察。

---

## 十一、Q9 迁移指南要点（https://opencode.ai/v2/docs/build/plugins/migrate-v1/ 逐条）

1. **V1 插件实现无法在 V2 运行**；移文件或改配置名不够。`plugin`→`plugins`；tuple→对象 `{package,options}`。
2. **入口重写**：换 import 为 `@opencode/plugin`；导出函数→`Plugin.define`；初始化移入 `setup`；每个插件需 **stable `id`**（storage 按 id 分区、诊断用）。
3. **上下文迁移**：`directory`→`ctx.location.directory`；`project`→`ctx.location.project`；`client`→域方法 `ctx.session/ctx.permission/ctx.agent...`；`plugin options 参数`→`ctx.options`；返回 `dispose()`→`setup` 返回 cleanup；`event`→`ctx.event.subscribe()`；`config/model/tool changes`→对应域 `transform(...)`；`$ Bun shell`→自行管理进程 API。
4. **hook 迁移**：每 hook 注册到所属域；回调收到单个可变 event（非 input/output 两参）。
5. **请求 hook**：`context`（模型可见上下文，紧邻模型请求）、`prompt`（durable admission 前）、`model.request`（headers/raw）、`http.request/response`（原生 HTTP）；provider 级第三参 `{providerID}`。
6. **工具迁移**：JSON Schema（不再 zod）、`ctx.tool.transform` 同步编辑、`execute` 返回结构化 `{content}`。
7. **事件与清理**：异步 `for await` 于 `ctx.event.subscribe({signal})`，cleanup 中 `abort()`。
8. **options 与持久状态**：`ctx.options`；状态用 `ctx.storage`（durable、按插件 id 分区），不要自造全局文件。
9. **双版本共存**形状与 V1 1.18.29+ 要求（见 §九）。
10. **无法一一对应的 V1 experimental hook**（`experimental.compaction.autocontinue`、`experimental.provider.small_model`、`experimental.text.complete`、`command.execute.before`）需按 V2 session/provider/model/event API 重新评估，不保留内部生命周期假设。

---

## 十二、cabbage 专项：V1 用法 → V2 当前 API 映射

| # | cabbage V1 用法 | V2 当前 API | 证据/置信度 | 迁移动作 |
|---|---|---|---|---|
| E1 | `export default { id, server: async (ctx)=>hooks }` | `export default Plugin.define({ id, setup(ctx){...} })` | CONFIRMED 类型/文档 | 重写入口；cleanup 用返回函数 |
| E2 | `"oc-plugin": ["server"]` | V2 用配置 `plugins` / `.opencode/plugins/` | INFERRED（无 `oc-plugin` 证据） | 保留兼容 V1；V2 不依赖此字段 |
| C1 | `config.skills.paths.push(dir)`（复制临时目录） | 配置 `"skills": ["<dir>"]`（可数组/URL）或 `ctx.skill.transform(editor.add({id,name,path,content}))` | CONFIRMED 类型/文档 | 首选配置 `skills` 数组（免复制）或 transform 注入内容 |
| C2 | `config.command[name]={template,description,agent,model,subtask}` | 配置 `"commands": { name: {template,description,agent,model,subagent} }`（`subtask` 为 deprecated alias）；或 `ctx.command.transform` + `execute` | CONFIRMED 类型/文档 | **语义基本保留**：改单复数键名 + `subtask`→`subagent`；无需全部重写为函数 |
| C3 | `config.agent[key]={description,mode,prompt,permission,shell.env}` | 配置 `"agents": { key: {description,mode,system,permissions,...} }` 或 `ctx.agent.transform` | CONFIRMED 类型/文档 | `prompt`→`system`；`permission`→`permissions` 规则数组；去掉 `tools`/`shell.env` 遗留字段 |
| T1 | `tool()` helper + zod | `ctx.tool.transform(editor.add({name,description,input:<JSON Schema>,execute}))` | CONFIRMED 类型/文档 | zodschema→JSON Schema；execute 返回 `{content}` |
| T3 | `config.tools.goal=false` + per-agent `tools` | 工具 `options.permission:"goal"` + 全局/agent `permissions` 规则 | CONFIRMED 类型（options.permission）+ 文档 | 全局 deny goal + 目标 agent allow |
| I1 | `experimental.chat.messages.transform`（首条 user 注入） | `ctx.session.hook("context")` 编辑 `event.messages`/`event.system` | CONFIRMED 类型/文档 + **运行时 canary 成功** | 改 hook；可用 `system.push` 注入 Project Context |
| V1 | `event` hook 订阅 `session.status(idle)` | `ctx.event.subscribe()` + 匹配 `session.status`(`status.type==="idle"`) / `session.idle` | CONFIRMED 运行时投递 | 改事件词汇；`session.status.data.status.type` |
| V2 | `event` 订阅 `session.error`（abort） | `session.error`/`session.execution.failed`/`session.execution.interrupted`/`session.retry.scheduled` | CONFIRMED 类型枚举 | 选对应事件 |
| V3 | `event` 订阅 `message.updated`（重置计数） | `message.updated`/`session.inbox.enqueued`，或 `session.hook("prompt")` | CONFIRMED 类型 | 用 prompt hook 拦截 admission 更贴近 |
| V4 | `event` 订阅 `session.updated`（同步索引） | `session.updated`/`session.metadata.updated`/`session.created` | CONFIRMED 类型 | 直接映射 |
| P1 | `promptAsync({sessionID,parts,synthetic:true,agent,model})` | `ctx.session.synthetic({sessionID,text,...})`（触发 agent loop，运行时已证）+ `switchAgent/switchModel`；或 `ctx.session.prompt({...,resume:true})` | 调度 CONFIRMED；内容达模型 UNVERIFIED | 二选一；建议 `prompt({resume})` 作主路径，`synthetic` 备用 |
| S1 | `createOpencodeClient(@opencode-ai/sdk/v2)` | **不需要**：`ctx` 本身即 server client；独立客户端用 `@opencode/client@2.0.16`（`OpenCode.make({baseUrl,headers})`） | CONFIRMED 类型/文档 | 删除自建 client，直接用域方法 |
| S2 | `client.session.get/update/messages/children/status` | `ctx.session.get/update`、`client.message.list`、`ctx.session.list({parentID})`、`session.active()`/`session.status` 事件 | CONFIRMED 类型 | 逐项改名；`children`→`list({parentID})`；`status`→`active()`/事件 |
| G1 | goal 存 `session.metadata.goal` | `session.get/update` 的 `metadata`（**已实测可用**）或 `ctx.storage` | CONFIRMED 类型 + 运行时 | **可继续用 session metadata**，`GoalStore` 实现切换到 V2 读写即可 |
| E3 | `ctx.worktree`/`ctx.directory` | `ctx.location.directory`（插件实例位置，非每会话位置）；会话位置用 `SessionInfo.location` | CONFIRMED 类型/文档 | 注意语义：插件位置 ≠ 会话位置 |
| E4/E5 | `ctx.serverUrl`/`ctx.client` 私有 header | 无对应，直接域方法 | CONFIRMED 类型/文档 | 删除 |

---

## 十三、置信度与不确定项 / 文档沉默处

**已运行时实测（最强证据，v2.0.16）**
- 事件订阅投递（含业务事件）— CONFIRMED。
- session metadata create/update/get 可读写 + `session.metadata.updated` 事件 — CONFIRMED。
- `session.hook("context")` 的 `system.push` 到达模型 — CONFIRMED（canary `CANARY-9F3A` 被复述）。
- 普通对象 `{id,setup}` 入口可加载、`ctx.storage.set` 可用 — CONFIRMED。
- 本地插件 import `@opencode/plugin` 需包可解析 — CONFIRMED。

**未验证 / 不确定**
- `session.synthetic` 文本是否进入模型 prompt — **UNVERIFIED**（本次因默认模型凭据失败；`session.prompt({resume})` 与 context hook 可作替代）。#44788 最新 comment（beta-19271）仍报 synthetic 失效；但 GA 2.0.16 的 context 路径已修复，synthetic 是否同步修复未知。
- 插件工具在未设 `options.permission` 时的默认 action 名 — 文档沉默，INFERRED=工具名。
- `ctx.storage` 物理位置/容量/scan 跨重启一致性 — 文档沉默。
- `oc-plugin` 字段是否被 V2 读取 — INFERRED 废弃（无正面证据）。
- **beta 通道与 GA 的差异**：#44788 在 `0.0.0-beta-19271` 复现，而 `2.0.16` GA 实测已修；不得用 beta 结论推断 GA，反之亦然。

**方法学局限**
- 未在**真实 cabbage 代码**上跑 V2 端到端（未改源码约束）；运行时证据来自一次性探针。
- 未验证 `session.prompt({resume})` 的完整自动续接闭环（需模型凭据）。
- 事件词汇取自 `@opencode/schema@2.0.16` 全量检索，可能与未来小版本漂移。

---

## 十四、参考来源

**本机安装包（权威，运行时实际加载）**
1. `~/.config/opencode/node_modules/@opencode/plugin/package.json`（v2.0.16，exports map）
2. `~/.config/opencode/node_modules/@opencode/plugin/dist/promise/{plugin,index,session,tool,command,agent,skill,storage,event,permission,registration,aisdk}.d.ts`
3. `~/.config/opencode/node_modules/@opencode/plugin/dist/effect/plugin.d.ts`
4. `~/.config/opencode/node_modules/@opencode/schema/dist/{config,config/agent,config/command,config/plugin,tool,session,session-inbox,session-error,prompt-input,permission,agent,skill,command,plugin}.d.ts`
5. `~/.config/opencode/node_modules/@opencode/plugin/node_modules/@opencode/client/dist/promise/{client,api}.d.ts`、`.../generated/types.d.ts`（行号 253/571/1736/1884/2396/2779/3301/3566/3689/5269/5369/5863/7015/8472）
6. `~/.config/opencode/opencode.json`、`~/.config/opencode/cli.json`、`~/.config/opencode/package.json`
7. 本仓库：`package.json`、`node_modules/@opencode-ai/plugin/package.json`（1.18.10）

**V2 官方文档（唯一权威）**
8. 索引：https://opencode.ai/v2/llms.txt
9. 插件总览：https://opencode.ai/v2/docs/build/plugins/
10. V1 迁移：https://opencode.ai/v2/docs/build/plugins/migrate-v1/
11. Effect 插件：https://opencode.ai/v2/docs/build/plugins/effect/
12. 插件配置：https://opencode.ai/v2/docs/plugins/
13. 权限：https://opencode.ai/v2/docs/permissions/
14. 命令：https://opencode.ai/v2/docs/commands/
15. 技能：https://opencode.ai/v2/docs/skills/
16. 智能体：https://opencode.ai/v2/docs/agents/
17. 客户端：https://opencode.ai/v2/docs/build/client/
18. 配置：https://opencode.ai/v2/docs/config/

**Issue / PR tracker（anomalyco/opencode，2026-09-25 查询）**
19. #44788：`plugins: event.subscribe delivers no events; context-hook and synthetic injections never reach the model prompt` — **OPEN**（updated 2026-09-11；最新 comment beta-19271）
20. #40384：`Expose session metadata in the V2 API` — **OPEN**（feature；comment 引 PR #48059/#47486；2.0.16 已实测可用）
21. #27167：`[FEATURE]: Add native session goals with /goal` — **OPEN**
22. PR #32743：`feat(session): native per-session goals...` — **CLOSED 未 merge**（2026-07-17）
23. #28610（#27167 comment 提及）：社区插件式 goal 实现（`.opencode/goals.json`）

**版本命令实测（2026-09-25）**
24. `opencode --version` → `opencode v2.0.16`；`opencode --help`/`opencode plugin --help`/`opencode serve --help`/`opencode api --help`
25. `npm view @opencode/plugin dist-tags`、`npm view @opencode/client dist-tags`、`npm view @opencode/schema dist-tags`、`npm view @opencode-ai/plugin dist-tags`、`npm view @opencode-ai/sdk dist-tags`

**运行时探针（一次性，/tmp/opencode/probe，v2.0.16）**
26. 插件入口 `Plugin.define`/普通对象、`ctx.event.subscribe` 投递、`ctx.storage.set`、`ctx.session.hook("context")` canary、`session.create/update/get` metadata、`session.synthetic` 调度执行。

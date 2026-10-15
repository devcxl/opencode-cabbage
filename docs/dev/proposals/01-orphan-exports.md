# 提案 01：删除无生产消费者的遗留导出与 goalComplete 写-only 字段

**状态:** 待评审
**日期:** 2026-10-14
**扫描域:** src/、test/（消费者核对含 assets/、scripts/、vendor/、hooks/）

## 问题

`ab47197`（移除生命周期工具内核，回归纯 Prompt + goal 架构）删除了工具与调用链，但以下符号与字段仍留在源码中，只有测试消费者（或完全没有读者）：

### 1. `parsePrUrlNumber`（`src/util/gh.ts:5`）

- 生产消费者：无。`rg "parsePrUrlNumber" src scripts assets vendor hooks` 仅命中定义。
- 唯一消费者：`test/util/gh.test.ts:2-16`。
- 引入于 `b76dc3f`（为生命周期工具的 `gh pr create` 解析 PR URL），消费者随工具在 `ab47197` 一并删除。
- 插件内已无 `gh` 子进程调用（`rg "execFile.*gh" src` 为 0 命中）；PR 由编排器在 shell 中执行。

### 2. `upsertProjectProfile`（`src/kernel/profile.ts:86-98`）

- 生产消费者：无。Profile 回写已回归 Prompt：`assets/skills/flow-setup/SKILL.md:27,74` 指示 agent 用自身编辑工具维护根 `AGENTS.md` 的 Project Profile 区块。
- 唯一消费者：`test/kernel/profile.test.ts:162-181`（合成字符串用例）。
- 读取侧 `readProjectProfile` 有生产消费者（`src/plugin/server.ts:197`），不动。

### 3. `isAllowedInAutoMode`（`src/kernel/permission.ts:44-46`）

- 定义即 `matchPermission(rules, command) === "allow"` 的一行别名。
- 生产消费者：无。唯一消费者 `test/adversarial/06-permission-bypass.test.ts:23-27`。
- `matchPermission` 本身保留：它是 adversarial 测试自建的判定 oracle（:29-73 用它对真实资产权限矩阵断言），删除会让安全矩阵失去评估函数。

### 4. `goalComplete` 字段（写-only）

- 写入：`src/plugin/goal.ts:271`（goal complete 时写 `{ goalComplete: true, status: "completed" }`）。
- 字段定义与补丁键：`src/kernel/session-index.ts:21,88`。
- 读取者：无（`rg "goalComplete" src` 仅 3 处，皆为定义与写入）。
- 来源：`7998481` 为已删除的 `complete-flow` 工具添加的跨会话标记；读取侧随工具在 `ab47197` 删除（旧实现见 `ab47197^:src/plugin/flow-control.ts:253-265`）。
- 唯一断言：`test/plugin/goal-tool.test.ts:238-240`（断言自身写入结果，循环论证）。
- 注：session-index 其余镜像字段的处理见提案 02；本项可独立先落地。

### 5. goal allowlist 双份（漂移风险）

- `GOAL_ALLOWED_AGENTS = new Set(["dev-lifecycle", "goal-verify"])`（`src/plugin/goal.ts:197`，已导出）。
- `src/plugin/server.ts:266-269` 权限规则层再次硬编码同一字面量 `new Set(["dev-lifecycle", "goal-verify"])`。
- 注释自称"与权限规则层一致"，但两处授权事实靠人工同步，属于同一事实的双表示。

## 提案

1. 删除 `src/util/gh.ts` 与 `test/util/gh.test.ts`（该文件唯一函数即 `parsePrUrlNumber`）。
2. 删除 `upsertProjectProfile`（`src/kernel/profile.ts:86-98`）及测试块（`test/kernel/profile.test.ts:162-181`、顶部 import）。
3. 删除 `isAllowedInAutoMode`；`test/adversarial/06-permission-bypass.test.ts:23-27` 删除（其断言等价于 :16-21 的最后匹配语义 + 默认 ask；auto 模式是宿主行为，内核不再表达）。若想保留"auto 仅 allow"的表述，可改写为对 `matchPermission` 的注释性用例，但不要为别名保留实现。
4. 删除 `goalComplete`：`goal.ts:271` 的补丁收缩为 `{ status: "completed" }`（`status` 的完整退场见提案 02），删除 `session-index.ts:21` 字段与 `:88` 补丁键，删除 `test/plugin/goal-tool.test.ts:238-240` 的断言。
5. `src/plugin/server.ts` 改为 `import { GOAL_ALLOWED_AGENTS } from "./goal.js"`，权限规则层使用 `{ action: "goal", allowed: GOAL_ALLOWED_AGENTS }`。`cabbage` 名单（仅 dev-lifecycle）保持现状，不为此新建常量。

## 为什么不保留？

- `parsePrUrlNumber` / `upsertProjectProfile`：唯一"未来用处"是重建插件内 gh 自动化或 setup 工具，但二者都在 `ab47197` 被有意移出内核；若回归，应基于当时 CLI/写入语义重新设计，而不是让孤儿函数长期占据复习面。
- `isAllowedInAutoMode`：一行别名；测试直接调用 `matchPermission` 的语义完全等价。
- `goalComplete`：即使在旧设计中它也只是"跨会话完成标记"的冗余副本；若未来需要跨会话识别，应读 goal 元数据（autoResume 已经在用的单一权威），而不是新建第二文件镜像。
- allowlist 双份：授权事实的单点化是安全边界的一致性要求；`goal.ts` 已导出常量，server 侧复用无额外成本。

## 验收标准

- `rg -n "parsePrUrlNumber|upsertProjectProfile|isAllowedInAutoMode|goalComplete" src/ test/` → 0 命中。
- adversarial 测试仍覆盖真实资产权限矩阵（`:29-73` 不变）。
- `npm run typecheck && npm test` 通过。
- 历史引用（`docs/dev/specs/thin-kernel-workflow.md:86,507,516`）属自标"已废弃"文档，不改。

## 风险

- 低。全部符号不经由 package `exports` 对外（对外仅 `dist/index.js` 的插件入口与 `./server` 别名），无兼容义务。
- `server.ts` 复用常量后，若未来新增 goal 授权 agent，只需改一处，行为不变。

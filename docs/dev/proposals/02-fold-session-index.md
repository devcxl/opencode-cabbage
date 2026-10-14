# 提案 02：session-index 折叠为最小绑定，goal 作为唯一状态权威

**状态:** 待评审（含一项产品行为变化，需确认）
**日期:** 2026-10-14
**关联:** 提案 01（`goalComplete` 移除）

## 问题

`session-index.json` 当前镜像 6 个字段：`sessionID / status / continuationCount / goalComplete / lastContinuedAt / updatedAt`。逐字段核对生产读者（`rg` 于 src/、assets/、codex-skills/、vendor/、hooks/）：

| 字段 | 生产读者 | 结论 |
|---|---|---|
| `sessionID` | `continuation.ts:243,257`（autoResume 读 goal） | 保留 |
| `lastContinuedAt` | `continuation.ts:238`（30s 重启双发防护） | 保留 |
| `status` | `continuation.ts:232`（预检 `!== "active"` 直接 skip） | 与 `:251` 的 goal 检查重复 |
| `continuationCount` | 无 | 写-only |
| `updatedAt` | 无（`continuation.ts:235` 注释明说不用于判断） | 写-only |
| `goalComplete` | 无（提案 01） | 写-only |

- 镜像/心跳写在 src/ 共 10 处：`continuation.ts:92,97,103,142,165,172,187,217,252`、`server.ts:151`（其中 `:172` 含需要保留的 `lastContinuedAt`；另有 `goal.ts:271` 属提案 01）。
- 唯一预检（`continuation.ts:232`）先于权威检查（`:251` 读 `goal.status`）拦截，两处事实不一致时以索引为准，构成漂移缺陷：`goal.resume`（`goal.ts:335-346`）不刷新索引 status，重启后 autoResume 会被残留 `paused` 直接拦掉（goal 明明 active），直到下一次轮次结束事件才可能恢复续接。
- 其余可观测问题：
  - `server.ts:355-356` 预读 `readIndex` 后丢弃结果；`readIndex` 设计上不抛错（`session-index.ts:39-49`），注释也承认无法失败。
  - `session-index.ts:4` 头注释宣称"双 session 检测（R7）"，与 `:61-63`"覆盖式，无双 session 强制"及测试相矛盾。

## 提案

1. 索引模型收缩为 `FlowSessionEntry = { sessionID: string; lastContinuedAt?: number }`；删除 `FlowSessionStatus`、`VALID_STATUSES` 及 `status/continuationCount/goalComplete/updatedAt` 字段。
2. `updateFlowSession` 收缩为只更新 `lastContinuedAt`（可改名 `touchFlowSession(projectDir, parentIssueNumber, at)`）。删除 9 处镜像写（`continuation.ts:92,97,103,142,165,187,217,252`；`server.ts:151`），保留 `continuation.ts:172` 的 `lastContinuedAt` 写入。`bindSession` / `removeFlowSession` 保留（职责不变）。
3. autoResume 流程简化为：`lastContinuedAt` 跳过（`:238`）→ 陈旧 entry 清理（`:246`）→ goal 权威检查（`:251`，非 active 或缺失即跳过，不再回写索引）。
4. 删除 `server.ts:355-356` 的无用预读及其注释。
5. 修正 `session-index.ts:4` 头注释为覆盖式语义。
6. 测试改造：`test/kernel/session-index.test.ts` 的字段断言（`:69-88,143-160,175-191` 等）改为绑定/幂等/并发串行/原子写/`lastContinuedAt` 语义；`test/plugin/server-continuation.test.ts:349-411`、`test/plugin/goal-tool.test.ts:225+` 的索引种子改为最小形状；新增用例：goal active 且索引无 `lastContinuedAt`（resume 后重启场景）→ autoResume 续接（钉住行为变化）。

## 我们放弃什么

- **行为变化**：resume 后、下一次续接发送前重启，旧逻辑因索引 `paused` 跳过续接；新逻辑正常 autoResume。这与文档承诺一致（`docs/guides/architecture.md:244-251`"重启恢复上次未完成的 session"），旧跳过是镜像漂移而非保护。此变化即本提案的评审请求。
- 每个残留 entry 在每次重启多做一次 session 读取（可忽略）；entry 永续保留（与现状一致，paused 标记同样长期保留）。
- `session-index.json` 对外可读字段减少。核对：无任何资产/引擎/文档读取该文件（`rg "session-index" assets/ codex-skills/ vendor/ hooks/ scripts/` 仅 src；docs 只以"轻量索引（goal 绑定 + 重启恢复）"描述其语义，见 `architecture.md:70`）。
- 旧版索引文件无需迁移：读取侧不校验形状，多余字段自然忽略；消费侧只读 `sessionID` 与 `lastContinuedAt`。

## 验收标准

- `rg -n "continuationCount|updatedAt" src/kernel/session-index.ts src/plugin/continuation.ts` → 0（goal 自身的 `continuationCount` 除外）。
- 新行为用例通过（resume → 模拟重启 → autoResume 续接）。
- `npm run typecheck && npm test` 全套通过。
- 手工验证：create → pause → resume → 重启路径（可在测试环境模拟）。

## 风险

- 产品行为变化需确认（本提案即请求）；回滚路径 = `git revert`（无数据迁移、无外部契约）。
- 并发安全性不变：全部读写仍走 `KeyedMutex`；写入面反而从 10 处收缩到 1 处。

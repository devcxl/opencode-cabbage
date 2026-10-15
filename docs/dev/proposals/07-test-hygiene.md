# 提案 07：测试套件去重与失效断言修复

**状态:** 待评审
**日期:** 2026-10-14
**扫描域:** test/（3527 行，19 个文件，266 个用例）

## 问题（逐项证据）

1. **`test/plugin/shell.test.ts:3-19`**：为 0 参数函数 `createAgentShellEnv()`（`src/plugin/shell.ts:12`）构造完整 `AgentEntry` mock 并传入（`:23,31,39,45`），实参被静默忽略（测试不在 `tsc` 覆盖范围内，arity 不匹配不可见）。删除 mock 不损失任何独立失败。
2. **`test/commands.test.ts:95-101`**：`expect(r1).toEqual(r2)` 不能证明缓存（确定性输出恒等）；`:103-115` 的"skillsDir 变化失效"用例换目录后模板仍为 `"hello"`（不含 `.opencode/skills/`），缓存键变化不可观测。修复：用例 1 改为 `toBe`（钉住引用恒等）；用例 2 用含 `.opencode/skills/flow-x` 的模板并断言替换结果，或在提案 03 落地后删除（该机制退场后用例失去对象）。
3. **`test/kernel/session-index.test.ts:126-131`**：断言 `${path}.tmp` 不存在，而实现写 `${path}.<pid>.tmp`（`src/kernel/session-index.ts:54`）——空断言，永远通过。修复：写入后扫描目录 `*.tmp` 为空。
4. **`test/plugin/server-continuation.test.ts:74-80` 与 `:82-88`**：逐字节相同的 busy 子会话用例（仅标题不同，且都绕过 `dispatchEvent`，未覆盖 started/retry 事件映射）。删除其一。
5. **`test/goal.test.ts:21-22` 与 `:37-41`**：同一 "no objective/completionCriterion" 事实重复两个用例。删除后者（`:37-41`）。
6. **`test/plugin/prompt-lint.test.ts:108-115`**：权限规则 0 命中聚合用例 = 4 个兄弟用例的并集（`:50-62`、`:93-106`），无新增定位信息。删除聚合用例。
7. **`test/skills.test.ts:118-121`**：flow-tdd 存在性用例被 `:123+`（读取内容并断言 Contract 完整）严格覆盖。删除。

## 提案

按上表逐项修复/删除，预计净删除约 60-80 行测试与 1 个无用 mock，用例数减少约 8-10 个。

## 我们放弃什么

- 重复断言带来的"多种失败路径提示"——经逐一核对，上述用例无独立观测价值；保留用例均为不同分支/不同层（goal 的 `canTransitionTo` 矩阵、adversarial 权限矩阵、continuation 五道闸矩阵、prompt-lint 夹具规则用例等不动）。
- **明确不做**：跨文件 session-store mock 合并与 tmpDir 脚手架合并（`test/plugin/harness.ts:91-118`、`goal-tool.test.ts:12-45`、`server-continuation.test.ts:35-64`、`session-index.test.ts:14-25`、`goal-tool.test.ts:59-70`）。三个 mock 各自扩展点不同（syntheticError、context 夹具、token 简写），过早抽象会把测试耦合到共享工厂；若出现第 4 个消费者再评估。
- **明确不做**：CI 双跑 prompt-lint（`ci.yml:23` 的独立步骤与 `:25` 的 `npm test` 内含同一套件）——独立步骤提供命名信号，保留；如在意时长可后评估。

## 验收标准

- `npm test` 通过；用例数按删除量下降。
- 缓存用例：`toBe` 版本在缓存被移除时会失败（可临时注释缓存验证一次）。
- 空断言修复后，写入 `*.tmp` 残留的伪造实现会令该用例失败（可临时改实现验证一次）。

## 风险

- 低。纯测试内部，无生产行为变化。
- 与提案 03 的交叉：`commands.test.ts:65-70`、`test/prompts.test.ts:25-40,66-71`、`skills.test.ts:43-53,56-63` 的删除由提案 03 范围覆盖，避免重复工单。

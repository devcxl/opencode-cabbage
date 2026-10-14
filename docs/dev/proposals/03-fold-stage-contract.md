# 提案 03：删除不可达的 stage-contract 契约与资产加载期的死引用机制

**状态:** 待评审
**日期:** 2026-10-14
**扫描域:** assets/、codex-skills/、src/plugin/{skills,commands,server,prompt-lint}.ts、test/

## 问题

### A. stage-contract.md 是不可达的"单一来源"

`assets/prompts/stage-contract.md`（55 行）会被拷贝到 `<skillsDir>/_prompts/`（`src/plugin/skills.ts:88-97`），但没有任何读取路径：

- `loadPrompt` 仅被 `bootstrap` 调用（`src/plugin/bootstrap.ts:18`），且从包内 `assets/prompts/` 读取（`src/plugin/prompts.ts:15-23`），不经 `_prompts/`；
- skills 注册跳过 `_` 前缀目录（`skills.ts:21,32`），`_prompts/` 对模型不可见；
- 资产与命令对它的引用只有裸名 `stage-contract`（7 个 `assets/commands/*.md:4`、`assets/prompts/bootstrap.md:22`），无法定位到任何文件；
- 全仓库无 `_prompts/` 路径引用（`rg "_prompts/" assets codex-skills test` → 仅 `prompt-lint.ts:58` 的跳过分支与 `prompts.test`）。

其规范内容已被局部重述：`assets/agents/dev-lifecycle.md:40-44`（阶段顺序与 checklist 勾选）、`docs/guides/configuration.md:124-132`。文档却仍称其为"单一来源"（`configuration.md:62`、`architecture.md:88,153`、`sops/07-docs-update.md:23`）。

### B. `.opencode/skills/` 加载期改写没有输入

- skills 安装改写：`src/plugin/skills.ts:99-115`（`processDir` 内 `replaceAll`）。
- commands 加载改写：`src/plugin/commands.ts:67`（`replaceAll`，并让 `skillsDir` 变成文件的缓存键组成部分）。
- `assets/` 与 `codex-skills/` 中该模式 0 命中；两个改写只被合成夹具测试锁定（`test/skills.test.ts:43-53`、`test/commands.test.ts:65-70`）。
- 两个模块各自实现同一死约定。

### C. promptsDir 安装期拷贝没有消费者

`_prompts` 拷贝（`skills.ts:88-97`）只服务一个没有读取者的通道；`test/prompts.test.ts:25-40` 锁定拷贝行为本身。

## 提案

1. **折叠契约**：将 `stage-contract.md` 的独有规范内容并入 `assets/agents/dev-lifecycle.md` 的《阶段契约》章节（第 40-44 行处），至少包括：
   - 阶段表（含 `setup` 行与各阶段产出）；
   - 完成权威（阶段完成 = Parent Issue body checklist `- [x] <stage>`，由编排器经 `gh issue edit` 更新）；
   - 门禁规则表（前置阶段 completed / requirements 完成需用户确认 / 依赖 Task 已合并 / code 阶段需设计基线已合入）；
   - Prohibited Actions（不跳阶、不伪造完成、不修改已完成阶段 checklist、reviewer/goal-verify 等子 agent 不执行写命令）。
2. 删除 `assets/prompts/stage-contract.md`；删除 `skills.ts:88-97` 的 `_prompts` 拷贝与 `promptsDir` 参数；`server.ts:186,192` 调用点相应收缩。
3. 更新引用文案：7 个 `assets/commands/*.md` 第 4 行去掉"（阶段契约见 stage-contract）"（或改为"（阶段契约见 @dev-lifecycle）"）；`bootstrap.md:22` 删去悬挂句（其"推荐流程"表已含相同信息）。
4. 文档对账：`configuration.md:62,124-126`；`architecture.md:88,153`；`sops/07-docs-update.md:23`（示例改为"如阶段契约内嵌在 dev-lifecycle agent 定义"）。
5. 删除 `.opencode/skills/` 改写（`skills.ts` 的 `processDir` 段与 `commands.ts:67`）；`loadCommands` 签名收缩为 `loadCommands(commandsDir)`，缓存键去掉 skillsDir。**反向选择**：若维护者想保留该约定，必须至少让一个真实资产使用它，并用真实断言替换合成夹具——本提案建议删除（无使用者的约定是投机泛化）。
6. `prompt-lint.ts:58` 删除 `_prompts/` / `_context/` 跳过分支：两个通道均已不存在（`_context` 为更早移除的内置机制），资产无引用，删除后 lint 行为不变。
7. 测试清理：删除 `test/prompts.test.ts:25-40,66-71`；`test/skills.test.ts:43-53,56-63`；`test/commands.test.ts:65-70` 及依赖 skillsDir 的缓存失效用例（缓存断言本身的重做见提案 07）。

## 我们放弃什么

- "stage-contract 单一来源"的文档模型：契约从独立文件迁移为编排器 prompt 的内嵌章节。仍是单一文本来源，但不再是可独立链接的文件；commands 的指向性文案被删或改为 agent 引用。
- 若未来需要 skill 间共享资产通道（`_prompts`）或 `.opencode/skills/` 相对引用约定：重新引入时应带真实消费者与测试，而不是凭历史惯性保留双份实现。
- 删除 `_context/` 跳过属顺手清理，与主目标无强耦合，可单独取舍。

## 验收标准

- `rg -n "stage-contract" src assets codex-skills test` → 0；docs 不再称其为独立契约文件。
- `rg -n "_prompts|opencode/skills/" src assets test` → 0。
- `npm run prompt-lint`、`npm run typecheck`、`npm test` 通过。
- `npm run docs:build` 通过（文档链接指向的文件仍存在）。

## 风险

- 内容折叠不全导致约束丢失：以第 1 条的清单作为执行 checklist；`dev-lifecycle.md` 是唯一全权编排器，契约语义落点正确。
- commands 去掉括号文本不改变行为（模板文本投递）。
- 中低风险；可 revert。

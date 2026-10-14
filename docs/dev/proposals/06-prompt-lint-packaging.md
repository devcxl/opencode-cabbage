# 提案 06：prompt-lint 移出发布产物并删除被测试覆盖的重复守卫

**状态:** 待评审
**日期:** 2026-10-14
**扫描域:** src/plugin/prompt-lint.ts、test/plugin/prompt-lint.test.ts、package.json、tsconfig.json、CI workflow

## 问题

- `src/plugin/prompt-lint.ts`（386 行）唯一消费者是 `test/plugin/prompt-lint.test.ts` 与 CI 步骤 `npm run prompt-lint`；无运行时导入（`rg "lintAll" src test` 仅有自身与测试）。
- 它仍被 tsc 编译进 `dist/` 并随 npm 包发布：`npm pack --dry-run` 含 `dist/plugin/prompt-lint.{js,map,d.ts}`（约 26 KB）。对使用者是死代码，且抬高 tarball 体积。
- R12 目录守卫重复：
  - `checkRemovedSkills`（`prompt-lint.ts:120-136`）/ `checkRemovedCommands`（`:138-153`）断言已删目录不存在；
  - `test/skills.test.ts:181-184` 与 `test/commands.test.ts:118-125` 已用目录全集合相等断言严格覆盖（多一个已删目录即失败）。
  - lint 的独占价值只剩残留内容模式（`HANDOFF_TEST_RESIDUE_PATTERNS`，`:33-38`）——那部分保留。
- 测试夹具清单过期：`test/plugin/prompt-lint.test.ts:119-122` 的 `EXPECTED_SKILLS` 仍为 8 个（实际 12），"passes a valid 8-skill" 标题误导。

## 提案

1. **构建排除**：新增 `tsconfig.build.json`（extends `tsconfig.json`，`exclude: ["src/plugin/prompt-lint.ts"]`），`package.json` 的 build 改为 `tsc -p tsconfig.build.json`。`npm run typecheck` 仍覆盖 src 全量（含 lint），CI 无需其他改动。
2. **打包守卫**：`test:pack` 增加反向检查（对齐既有 `dist/flowrun/` 守卫风格）：tarball 含 `dist/plugin/prompt-lint` 即 FAIL。
3. 删除 `checkRemovedSkills`/`checkRemovedCommands` 与 `REMOVED_SKILLS`/`REMOVED_COMMANDS` 常量及调用（`prompt-lint.ts:29-30,120-153,361-362`）；保留残留模式检查与其余规则。
4. 删除对应测试用例："flags removed skills flow-handoff / flow-test"、"flags removed commands /test and /handoff"；"current assets have no removed skills/commands..." 用例收缩为 `handoff-test-residue` 单规则过滤。
5. 夹具清单对齐 12 个 skill（或改名为明确的子集并注明用途）。

## 我们放弃什么

- lint 不再对"已删目录回流"给出带 rule 名的独立报告；该不变量改由全集合测试单点拥有（失败信息更完整、更早）。
- 若存在外部深度导入 `dist/plugin/prompt-lint.js` 的消费者（未在 README/文档承诺，视为不存在），会失效。替代方案是仅从 tarball 排除（打包脚本层）；本提案选择构建排除，理由：`src/` 应该只含运行时模块，避免下一个维护者误以为它会被插件调用。
- `lintAll` 在测试中约 9 次全量扫描 assets 树未优化（可选：`beforeAll` 缓存）——不在本提案范围。

## 验收标准

- `npm run build && npm pack --dry-run | grep prompt-lint` → 无输出。
- `npm run prompt-lint`、`npm test`、`npm run typecheck`、`npm run test:pack` 通过。

## 风险

- 新增一个构建配置文件；CI 各步骤对这些脚本无其他依赖。低风险。

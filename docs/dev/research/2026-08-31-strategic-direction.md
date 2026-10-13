# 战略方向调研：opencode-cabbage 下一步往哪走

- 日期：2026-08-31
- 调研方式：项目现状审计 + 生态调研（OpenCode 官方动态、Codex 插件生态、SDD 赛道竞品）+ 交叉验证
- 状态：结论 + 3 个方向建议（待作者决策）

---

## 一、研究结论摘要

1. **cabbage 的核心差异化（goal 状态机 + 自动续接）正面临被 OpenCode 官方功能吸收的风险。** 社区对 native `/goal` 需求强烈，多个 PR 竞争实现（issue #27167 → PR #28610/#32239/#32743）；OpenCode 2.0（beta）已宣布"一切皆内部插件"（68 个内部插件，2026-08-13 thdxr 发言），插件层能力将被平台逐步同化。**这是当前最大的战略风险。**
2. **SDD 全流程赛道已头部集中且饱和**：Spec-Kit ~111K stars、OpenSpec ~54K、Superpowers ~225K、BMad ~49K、Ruflo ~59K；OpenCode 插件层也出现 specops（24 agent 角色、evidence-gated completion）、opencode-workflows（workflow_* 工具家族 + QuickJS 沙箱）等强竞品。cabbage 以"全流程编排"为卖点无法与头部竞争。
3. **Codex 插件生态存在真实窗口**：Codex 5M 周活（2026-06），plugin marketplace 2026-03 上线，官方目录尚未开放自助提交（"coming soon"），repo marketplace 是当前唯一分发渠道。cabbage 已具备 Codex 兼容层（skills + hooks + manifest），有先发条件。
4. **项目 traction 极低（2 stars / 424 月下载），是事实上的个人 dogfooding 项目。** 战略决策必须以此为基准，不假设社区增长会自然发生。
5. **竞品已验证的演进模式**：evidence-gated completion（证据门控）、engine-not-automations（引擎化）、workflow-as-code（脚本化）、multi-harness 单源产物、成本感知模型分层。cabbage 现有架构是纯 Prompt 编排，缺少"内核把关"层，这是与头部竞品最本质的差距。

---

## 二、背景与问题定义

### 项目现状（截至 2026-08-31）

- **定位**：OpenCode 全流程开发插件（setup → requirements → design → tasks → code → review → release），纯 Prompt 编排 + 最小 TS 内核（goal 工具、session-index、context 注入、权限匹配、互斥）。
- **版本/分发**：v1.3.0，npm 发布（`@devcxl/opencode-cabbage`），近月下载 424、近周 20。
- **GitHub**：2 stars、1 fork，创建于 2026-07-07，1 个 open issue（AI 代码审查）。
- **近期动作**：v1.3.0 增加 Codex 兼容层（`codex-skills/` + `hooks/` + `.codex-plugin/` + repo marketplace）。
- **架构演化**：经历过两次方向性重构——从"生命周期工具内核"回归"纯 Prompt + goal 架构"（commit ab47197、8485579），说明作者已有意识地选择薄内核路线。
- **方法论资产**：完整的 DDD 术语表（CONTEXT.md）、场景分诊（9 种非功能路径）、五道闸续接防护、token 预算护栏、权限矩阵、ADR/PRD/SOP 文档体系。这套方法论自洽程度高于大多数竞品。

### 问题定义

作者的问题："不知道项目该往哪儿走、没有方向"。拆解为三个决策子问题：

1. **平台风险**：继续深耕 OpenCode，还是转向/兼容 Codex？（OpenCode 官方吸收风险 vs Codex 生态窗口）
2. **形态选择**：全流程方法论（拥挤）vs 底层引擎/内核（重）vs 方法论输出（轻）？
3. **投入基准**：以 dogfooding 自我效率为基准，还是以社区 traction 为基准？

### 范围与限制

- 本调研为方向性研究，不做代码实现。
- 数据来源以公开网页/仓库/官方文档为主，多数为 2026 年上半年的一手或高质量二手来源；部分竞品 star 数来自第三方调研文章，存在口径差异（已标注）。
- 无法获取：OpenCode 官方 roadmap 原文（团队未公开发布）、Codex 官方目录开放自助提交的确切时间表。

---

## 三、研究方法

- **第 1 轮（项目审计）**：读 README/CONTEXT/架构文档、git 历史（30+ 提交）、package.json、GitHub issues 与仓库元数据、npm 下载量。
- **第 2 轮（生态扫描）**：搜索 SDD 工具全景对比（spec-compare、Ry Walker Research、Hightower 系列）、OpenCode 插件生态、Codex 插件生态。
- **第 3 轮（定向验证）**：OpenCode 官方 native goal 动态与 2.0 架构、awesome-codex-plugins 的 workflow 类目竞争度、竞品核心机制（证据门控/引擎化/沙箱）。
- **局限性**：未与任何竞品作者或用户进行一手访谈；traction 判断基于公开指标；OpenCode 2.0 仍在 beta，API 可能变化。

---

## 四、关键发现

### F1：OpenCode 官方正在吸收 cabbage 的核心功能（置信度：高）

- 社区 issue #27167（2026-05-12）请求 native session goals，评论区共识强烈（"It's the main reason I switch away"）。官方最初回应"not planned as of yet"，但后续出现多个竞争性 PR：内置 plugin 实现 #28610（2026-05-27，d11ead8 已合入）、native 实现 #32239、#32743（persisted per-session goal + `/goal` 命令 + autonomous pursuit loop）。
- OpenCode 2.0（beta，2026-07-10 架构拆解）：server-first 架构、PluginV2 hook 系统（`catalog.transform` / `aisdk.language` / `agent.update`）、官方声明"唯一有意 break 的是 server 和 plugin API"；config/agents/commands/skills 通过内存翻译兼容。
- thdxr（2026-08-13）："opencode2 里几乎一切都是内部插件，共 68 个，覆盖内置 agents、集成、配置加载……你可以禁用任何行为，我们也在真正 dogfood 我们的插件 API。"
- **对 cabbage 的含义**：goal 工具、自动续接、编排器的"平台缺口"价值正在关闭。cabbage 未来要么成为官方 goal 之上的上层编排，要么把价值锚定在 GitHub 权威源 + 多 agent 协作 + worktree 并行等官方不会做的层。

### F2：SDD/工作流赛道头部集中，OpenCode 层竞品强劲（置信度：高）

| 竞品 | 模式 | 关键差异 | 来源时间 |
|---|---|---|---|
| Spec-Kit（GitHub 官方） | 4 阶段 CLI，constitution | ~111K stars（2026-02 数据 70.8K，6 月 111K） | 2026-06 |
| OpenSpec（Fission-AI） | delta-spec，brownfield-first | ~54K stars | 2026-06 |
| Superpowers | brainstorm→plan→TDD→review，8 harness | ~225K stars | 2026-06 |
| @jrpbuilds/specops | OpenCode 插件，TS 拥有工作流、24 个 agent 角色、evidence-gated completion | "TypeScript owns the workflow, the model owns the reasoning" | 2026 |
| mcrescenzo/opencode-workflows | OpenCode 插件，workflow_* 工具家族 + QuickJS 沙箱 + 持久化可恢复 | "engine, not automations"——只捆绑一个旗舰工作流 | 2026 |
| kamioj/spec-workflow | Claude Code + Codex 双端，16 命令、hook 强制 HARD GATE、fresh-context 验证者 | 单 core 源生成双平台产物 | 2026 |
| Codex 侧 SDD 插件群 | awesome-codex-plugins 中 workflow 类约 15+ 个（A Team、Aegis、specx、codex-full-stack-workflow、Praxis、spec-superflow…） | 多为纯 prompt 插件；带 hooks/MCP/dist 的少数 | 2026-08 |

- 竞品的共同进化方向：**证据门控完成**（specops 的 completion receipt、specx 的 fail-closed verification、spec-workflow 的 evidence-or-drop findings）、**引擎化**（workflow-as-code、沙箱）、**多 harness 单源**。
- **对 cabbage 的含义**："又一个全流程 prompt 插件"没有差异化空间；cabbage 的 goal 内核 + 五道闸是少数可与"证据门控"对齐的资产。

### F3：Codex 生态窗口（置信度：中）

- Codex 5M 周活用户（2026-06-02 OpenAI 官方宣布），非开发者占 ~20% 且增速 3x。
- 插件系统 v0.117.0（2026-03-26）起成为一等公民；hooks v0.128、marketplace 浏览器 v0.129；官方 Plugin Directory 已有 12 个精选 + 110 skills + 62 apps，但**第三方自助提交"coming soon"**。
- 当前分发渠道：repo marketplace（`$REPO_ROOT/.agents/plugins/marketplace.json`，`INSTALLED_BY_DEFAULT` 政策可做团队强制分发）+ awesome-codex-plugins（863 stars，注册表 + trust scoring）。
- **反方证据**：Codex 侧 SDD 插件已经拥挤（15+ 个）；官方目录开放时间不确定；OpenAI 没有插件变现路径（2026-03 WinBuzzer 报道），第三方生态商业激励弱。
- **对 cabbage 的含义**：窗口真实但时间有限，且竞争已开始。cabbage 的先发点在于已有可用的 Codex 兼容层 + hooks + dist 编译产物，而多数竞品是纯 prompt。

### F4：traction 现实（置信度：高）

- 2 stars / 1 fork / 424 月下载 / 20 周下载。除作者自身使用外几乎无社区渗透。
- 该项目的完整文档、测试、方法论投入远超其外部收益，是一个高质量、低分发的典型个人项目。
- 生态调研显示：成功的个人 SDD 项目（OpenSpec、Superpowers）以"轻量单一卖点 + 极低安装成本"起步，而非"完整生命周期"。

### F5：cabbage 的差异化资产盘点（置信度：高，基于代码审计）

| 资产 | 强度 | 是否可被平台/竞品替代 |
|---|---|---|
| goal 状态机 + 五道闸 + token 预算 | 强（工程质量高） | **被 OpenCode native goal 部分替代（风险最大）** |
| GitHub Parent Issue 权威源 + Sub Issue DAG | 强 | 竞品少见，官方不会做 |
| worktree 并行 + 权限矩阵 + 技能隔离 | 中强 | Superpowers/Spec Kitty 也有 worktree |
| 场景分诊（9 种轻量路径） | 中 | spec-workflow 有 fix 轻量层 |
| Codex 兼容层（skills + hooks + manifest） | 中（先发） | 竞品陆续跟进 |
| 方法论文档体系（ADR/PRD/SOP/DDD 术语） | 强 | 不可替代，但只有作者自己受益 |

---

## 五、对比分析

### 5.1 三个方向的方案对比

| 维度 | 方向 A：OpenCode 深耕 + 官方化对冲 | 方向 B：内核把关升级（证据门控） | 方向 C：Codex-first 窗口 |
|---|---|---|---|
| 核心动作 | OpenCode 2.0 兼容适配；goal 内核对接/避让官方 native goal；把价值锚定到 GitHub 权威源 + 多 agent 协作 | 内核新增 evidence receipt / gate 校验：TS 校验 flow-* skill 的完成报告（测试通过证据、artifact 存在性），fail-closed | Codex 兼容层升为一等公民：hooks 强制 gate、marketplace 分发、进 awesome-codex-plugins、官方目录开放时首批提交 |
| 时间成本 | 低-中（2-4 周） | 高（4-8 周，内核扩展 + 测试） | 中（2-4 周，已有基础） |
| 复杂度 | 低 | 高（需设计 receipt schema、与 prompt 流程协同） | 中（hook 测试、双平台同步维护） |
| traction 潜力 | 低（OpenCode 用户群较小，且官方吸收） | 中（差异化卖点清晰："完成的定义由内核验证，不靠模型自觉"） | 中-高（5M 周活 × 官方目录即将开放；但竞争 15+） |
| 失败模式 | 官方 goal 落地后价值归零，只剩文档资产 | 内核变重、与 specops 正面撞车、维护成本压垮个人作者 | OpenAI 目录长期不开放；Codex SDD 内卷；双平台维护拖垮节奏 |
| 回滚性 | 高 | 高（内核增量式） | 高（已有兼容层，仅增投） |
| 作者 dogfooding 收益 | 中（自己的 OpenCode 使用体验） | 高（更可靠的自动化） | 中（取决于作者是否用 Codex） |

### 5.2 成本全景

- **方向 A**：主要是适配与"去风险"工作，几乎无新增概念，成本最低，但收益上限也最低。
- **方向 B**：需要在"纯 Prompt 薄内核"哲学上做出明确转向——把部分决策权从模型收归内核。这与作者此前两次重构的方向相反（回退工具内核后又要加回内核能力），**需要先想清楚哲学问题**：哪些是"高损失写操作保护"（符合现有原则），哪些是"方法论强制"（违背现有原则）。
- **方向 C**：把 Codex 从"降级适配"变为"主战场"意味着双平台资产同步（prompt-lint 已有，但 hooks 测试、marketplace 版本策略需要新增），长期维护成本 ×1.5。

### 5.3 影响面

- 对作者本人：方向 B/C 增加日常维护负担；方向 A 最省力。
- 对未来接手者：项目文档质量高，任选方向都可延续；方向 B 的 receipt schema 需要文档化。
- 对潜在用户：方向 B 的"内核把关"是唯一能说服用户从 Superpowers/OpenSpec 转投的卖点。

---

## 六、反方观点与分歧

1. **"官方吸收即死亡"的反方**：插件生态的历史表明平台吸收并不必然杀死插件（VSCode GitLens、ESLint 插件均活在官方功能旁边）。cabbage 若把价值锚定在"GitHub Issue 权威源 + 多 agent 权限矩阵 + worktree 编排"上，官方 native goal（会话级）并不会覆盖 Flow 级编排。**风险真实但可能被高估。**
2. **"Codex 窗口"的反方**：OpenAI 官方目录开放时间反复跳票；无变现路径导致第三方生态质量低；5M 周活中 80% 是开发者但 SDD 插件已有 15+ 个纯 prompt 竞争者，cabbage 的 hooks 优势能否转化为安装量存疑。**窗口可能已过峰值。**
3. **"证据门控"的反方**：specops 已占据"TS 拥有工作流"心智，且其为全职/半职维护的项目（文档、测试、CI 完整度高）。个人作者正面竞争同一心智，ROI 存疑。**cabbage 应取其机制、避其定位。**
4. **未解决分歧**：OpenCode 官方 goal 最终形态未知（plugin vs core）；OpenCode 2.0 插件 API 未冻结，V1 插件在 V2 的兼容性承诺（"config/agents/commands/skills 兼容，server/plugin API break"）意味着 cabbage 的 `src/` TS 层**必然需要一次 V2 适配**。

---

## 七、风险与不确定性（含元评审）

### 剩余未知

- OpenCode native goal 是否会合入、何时合入、形态如何。
- OpenCode 2.0 正式发布时间与 plugin API 冻结时间。
- Codex 官方目录自助提交的时间表。
- 作者自身的使用偏好（继续用 OpenCode 还是切 Codex）——这直接决定方向 C 的 dogfooding 收益。

### 最弱证据

- 竞品 star 数多来自第三方文章（口径不一，且 2026 上半年数据为主），已标注为近似值。
- "Codex 生态窗口"的判断依赖 OpenAI 声明（"coming soon"），历史信誉存疑。

### 可能错误的假设

- "作者希望获得社区 traction"——若项目本就定位为自用工具 + 方法论实验场，则方向 A 加少量方法论输出（写文章）才是最优解，B/C 都是过度投入。
- "纯 Prompt 哲学不可动摇"——若作者愿意重新引入内核把关，方向 B 的价值上限最高。

### 最坏情况分析

- **方向 A 失败**：官方 goal 落地且覆盖 Flow 级需求 → cabbage 内核价值归零，但 assets（方法论 prompt）仍可用，损失 = 已有投入的机会成本，无新增沉没。
- **方向 B 失败**：内核扩展与 specops 撞车、个人维护力不从心 → 回滚到 v1.3.0 架构即可，receipt 层是增量模块，损失可控。
- **方向 C 失败**：OpenAI 目录不开放 + 双平台维护拖垮节奏 → Codex 层退回"降级适配"定位，损失 = 2-4 周投入。
- **共同最坏情况**：什么都不选，项目继续随缘 commit，goal 价值被官方吸收后项目自然死亡。**概率不低，因为 traction 从未建立。**

---

## 八、建议

### 总判断

**以 dogfooding 效率为底线，以"内核把关"为唯一可防守的差异化，以 OpenCode 2.0 适配为必做项，以 Codex 窗口为可选加分项。** 不建议继续在"全流程 prompt 编排"这个无差异化的方向上追加投入。

### 方向 A（保守·必做）：OpenCode 2.0 风险对冲

1. 立即做 V2 兼容性 spike：在 opencode2 beta 下加载插件，验证 `@opencode-ai/plugin` v1 API 在 V2 的行为；产出 `docs/dev/research/opencode-v2-compat.md`。
2. 关注官方 goal PR 进展（#32743/#32239/#28610），若合入，评估：cabbage 的 goal 工具是"消费官方 API 的上层封装"还是"保留自有状态机"（决策标准：官方 goal 是否支持 token 预算、Flow Record 绑定、goal-verify 授权）。
3. 把 README/定位从"全流程插件"改写为差异化描述："GitHub 权威源驱动的多 agent 编排 + 预算护栏"。

### 方向 B（中间·可选但价值最高）：最小证据门控层

1. **不在方法论上加内核强制**（保持纯 Prompt 哲学），只加"完成证据校验"：内核在 goal complete 前校验收据（测试 CI 通过链接、artifact 文件存在、Parent Issue checklist 勾选），失败则拒绝 complete。这正是 specops/specx 验证过的卖点，且与 cabbage 现有"goal-verify 授权"自然衔接。
2. 预计规模：receipt schema + 校验器 + 测试 ≈ 1-2 周核心 + 1 周文档。**这是把"模型自律"升级为"内核背书"的最小改动**。
3. 前提：作者确认愿意维护这一层（个人项目维护成本是硬约束）。

### 方向 C（激进·窗口性）：Codex 一等公民 + 市场进入

1. 将 Codex 兼容层从"降级适配"升级为"双平台同权"：补齐 hooks（PreToolUse gate、PostToolUse 校验）、写 Codex 侧 e2e 验证。
2. 提交到 awesome-codex-plugins（PR 流程，参考 kevin592/codex-full-stack-workflow 的 PR #337 先例）；官方目录开放自助提交时第一时间申请。
3. 判断标准：若 2 个月内官方目录仍不开放，或 awesome-codex-plugins 收录后无安装反馈，立即止损退回"降级适配"定位。

### 方向 D（诚实备选）：承认个人项目定位

若目标是方法论实验 + 作品集而非社区产品：停止功能开发，把精力转向**方法论输出**（goal 状态机设计、五道闸、场景分诊、纯 Prompt 编排哲学的文章/分享），项目本身保持可用即可。2 stars 的现实下，这个方向的 ROI 可能最高。

### 推荐组合

**A（立即） + D（持续）**，观察 1 个月后决定是否投入 B（若官方 goal 形态明朗且未覆盖 Flow 级）或 C（若 Codex 目录开放）。理由：A 是无论如何都躲不掉的必做项；D 是零成本的正收益；B/C 的投入时机取决于两个外部变量（官方 goal、Codex 目录），现在重注任一方向都是赌。

---

## 九、参考来源

1. OpenCode issue #27167 "Add native session goals with /goal"（anomalyco/opencode，2026-05-12）
2. OpenCode PR #32743 "native per-session goals"、#28610 "/goal plugin with idle-event auto-continuation"（2026-05~07）
3. OpenCode V2 架构拆解：OpenAgentsInc/openagents `docs/teardowns/2026-07-10-opencode-v2-architecture-teardown.md`（2026-07-10）
4. thdxr Threads 发言：opencode2 68 个内部插件（2026-08-13）
5. spec-compare（cameronsjo/spec-compare）：SDD 工具全景对比（2026-07-23 更新）
6. Ry Walker Research "Agentic Skills Frameworks Compared"（2026-02-22，2026-06 更新）
7. @jrpbuilds/specops（npm，OpenCode 插件，2026）
8. mcrescenzo/opencode-workflows（GitHub，2026）
9. kamioj/spec-workflow（GitHub，2026）
10. OpenAI 官方："Codex for every role, tool, and workflow"（openai.com，2026-06-02）
11. WinBuzzer："OpenAI Launches Plugin Marketplace for Codex"（2026-03-31）
12. Codex Knowledge Base（codex.danielvaughan.com）：插件生态与 marketplace 分发（2026-05）
13. hashgraph-online/awesome-codex-plugins（GitHub，863 stars，2026-08-31 快照）
14. 本项目仓库元数据与 npm 下载量（2026-08-31 实测）

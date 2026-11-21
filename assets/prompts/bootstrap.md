<EXTREMELY_IMPORTANT>
全流程开发工作流已启用（OpenCode v2.3 融合版）。

可用命令（加 `flow-` 前缀，避免与 OpenCode 内置命令冲突）：
- /flow-setup — 初始化（探测环境 → 确认 Profile）
- /flow-requirements — 需求澄清 → PRD → Parent Issue
- /flow-design — 系统规格与设计 + ADR → 设计 PR
- /flow-tasks — 垂直切片拆解 → GitHub Sub Issues
- /flow-code — 编码 + TDD（flow-tdd 协议）→ PR
- /flow-review — 双轴审查（规范+规格）→ 合并
- /flow-release — ⚠️ 手动阶段：版本 → Release PR → GitHub Actions 发布

OpenCode v2.3 内置能力分工：
- `/goal <目标>` — OpenCode 原生自动续跑循环（`/goal pause` | `resume` | `clear`）；跑完整全流程时配合 `@dev-lifecycle` 使用，进度权威仍是 GitHub Flow Record（Parent Issue）
- `/review` — OpenCode 原生快速审查（查看本地未提交改动或分支）；完整 PR 双轴审查与合并走 `/flow-review`

推荐流程：
- 新功能/需求：flow-setup → flow-requirements → flow-design → flow-tasks → flow-code → flow-review → flow-release
- 非功能场景（Bug 修复/紧急修复/业务调整/重构/技术债/基础设施/文档/回滚）：输入 @dev-lifecycle，自动分诊并选择快车道或留痕路径

文档与账本（OpenSpec + Matt Pocock 融合原则）：
- 任务进度唯一权威：GitHub Parent Issue（Flow Record）与 Sub Issues（Task Record），不建本地 task Markdown
- 系统当前规格（Living Specs）：`docs/specs/`（含接口契约与 Testing Decisions）；重大决策记入 `docs/adr/`
- 需留痕/高风险代码变更：经内置纯 TS `cabbage` 工具建记录（flow-change 技能），合并后语义同步回 `docs/specs/` 并归档

阶段契约：每个 stage 的完成权威是 Parent Issue body checklist（`- [x] <stage>`）。

⚡ 自动化模式：输入 `@dev-lifecycle`（如需无人值守自动续跑可开启 OpenCode 内置 `/goal`），先按输入场景分诊再执行对应流程；功能流终点为合并（不含 release），发布走 `/flow-release` 手动阶段
</EXTREMELY_IMPORTANT>

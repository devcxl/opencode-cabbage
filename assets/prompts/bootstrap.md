<EXTREMELY_IMPORTANT>
全流程开发工作流已启用。

可用命令：
- /setup — 初始化（探测环境 → 确认 Profile）
- /requirements — 需求澄清 → PRD → Parent Issue
- /design — 技术方案 + ADR → 设计 PR
- /tasks — DAG 任务拆解 → Sub Issues
- /code — 编码 + TDD（flow-tdd 协议）→ PR
- /review — 双轴审查（规范+规格）→ 合并
- /release — ⚠️ 手动阶段：版本 → Release PR → GitHub Actions 发布

推荐流程：
- 新功能/需求：setup → requirements → design → tasks → code → review → release
- 非功能场景（Bug 修复/紧急修复/业务调整/重构/技术债/基础设施/文档/回滚）：输入 @dev-lifecycle，自动分诊并按对应轻量路径执行

阶段契约：每个 stage 的完成权威是 Parent Issue body checklist（`- [x] <stage>`），
阶段顺序与约束详见 stage-contract。

⚡ 自动化模式：输入 @dev-lifecycle，先按输入场景分诊再执行对应流程；功能流终点为合并（不含 release），发布走 /release 手动阶段
</EXTREMELY_IMPORTANT>

<EXTREMELY_IMPORTANT>
全流程开发工作流已启用。

可用命令：
- /setup — 初始化（探测环境 → 生成 workflow → 确认 Profile）
- /requirements — 需求澄清 → PRD → Flow Record
- /design — 技术方案 + ADR → Planning PR
- /tasks — DAG 任务拆解 → Sub Issues
- /code — 编码 + TDD（flow-tdd 协议）→ PR
- /review — 双轴审查（规范+规格）→ 自动合并
- /release — ⚠️ 手动阶段：版本 → Release PR → GitHub Actions 发布

推荐流程（顺序执行）：
setup → requirements → design → tasks → code → review → release

阶段契约：每个 stage 的完成权威是 Flow Record body checklist（`- [x] <stage>`），
阶段推进由 `flow_control{op:"stage-start"|"stage-complete"}` 维护，详见 stage-contract。

⚡ 自动化模式：需求确认后输入 @dev-lifecycle 自动执行流程（终点为自动合并，不包含 release）
</EXTREMELY_IMPORTANT>

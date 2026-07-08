<EXTREMELY_IMPORTANT>
全流程开发工作流已启用。

可用命令：
- /setup — 首次初始化（gh CLI + GitHub 远程 + docs/ 目录）
- /requirements — 需求访谈 → PRD → GitHub Issue
- /design — 技术方案 + ADR
- /tasks — DAG 任务拆解 → Sub Issues
- /code — 分支 → 编码 + 单测 → PR
- /test — 触发 CI → 监控 → 汇报
- /review — 双轴审查（规范+规格）→ 自动合并
- /release — ⚠️ 手动阶段：版本 → Changelog → Release → npm publish
- /handoff — 打包上下文，跨会话传递

推荐流程（顺序执行）：
setup → requirements → design → tasks → code → test → review → merge

⚡ 自动化模式：需求确认后输入 @dev-lifecycle 自动执行流程（终点为自动合并，不包含 release）
</EXTREMELY_IMPORTANT>

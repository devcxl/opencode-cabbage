---
name: "tdd-d4a-agent-isolation"
depends_on: ["tdd-a2-agent-lint", "tdd-d2-pr-create"]
labels: ["backend"]
worktree_root: ".worktree/tdd-d4a-agent-isolation/"
expected_files:
  - "src/plugin/agents.ts"
  - "src/plugin/shell.ts"
  - "test/plugin/shell.test.ts"
test_commands:
  - "npm test -- test/plugin/shell.test.ts test/agents.test.ts"
  - "npm run typecheck"
acceptance: |-
  - [ ] Agent `permission` 字段解析并传递给 OpenCode config（capabilities 仅作文档）
  - [ ] Worker shell 使用隔离 HOME/GH_CONFIG_DIR/Git credential config
  - [ ] Worker 只获得允许 feature branch push 的最小 Git 凭证
  - [ ] Reviewer 不获得任何 GitHub 写凭证
  - [ ] 检测 ambient GitHub API 凭证（环境变量 ~/.config/gh credential helper）
  - [ ] 发现可用 GitHub 写凭证 → 拒绝启用 Runtime，保持 advisory
  - [ ] `shell.env` 只作附加措施，不作唯一隔离边界
  - [ ] Reviewer 显式拒绝 edit、bash、task 委派、goal 生命周期操作、tdd_checkpoint 写操作
---

## 目标

实现 Agent permission 传递和 Worker/Reviewer shell 隔离，建立凭证安全的运行时基础。

## 实现要点

1. **Agent permission 传递** (`src/plugin/agents.ts` 扩展)
   - `AgentEntry` 增加正式 `permission` 字段解析
   - 解析结果传递给 OpenCode config（agent permission map）
   - `capabilities` 只用于 Lint 和文档校验，不用于运行时授权
   - Reviewer permission: `write: deny`, `edit: deny`, `bash: "gh pr view|diff|checks"`
   - Worker permission: write 限定 worktree，bash 限定 git commit/push/test

2. **Shell 隔离** (`src/plugin/shell.ts` 新增)
   - `createIsolatedShellEnv(agent: AgentEntry): Record<string, string>`
   - 为 Worker 设置隔离的 `HOME`（临时目录）、`GH_CONFIG_DIR`、Git credential config
   - Worker 只获得允许 feature branch push 的最小 Git 凭证
   - Reviewer 不获得任何 GitHub 写凭证（`GH_TOKEN` 设为只读 token 或空）
   - `detectAmbientCredentials(): AmbientCredentialReport`：检查 `GH_TOKEN`、`GITHUB_TOKEN`、`~/.config/gh/hosts.yml`、git credential helper

3. **Runtime 启用前检查**
   - 检测到可用 GitHub 写凭证 → Runtime enforcement 降级为 advisory
   - 记录降级原因（包括检测到的凭证来源）
   - `shell.env` 只作为附加措施，不作为唯一隔离边界

## 验收标准

- [ ] ambient credential 检测测试：有 GH_TOKEN → 降级
- [ ] Worker shell 隔离测试：Worker 无法访问宿主 GH_TOKEN
- [ ] Reviewer shell 隔离测试：Reviewer 无 GitHub 写凭证
- [ ] Agent permission 传递测试：OpenCode config 正确接收

## Worktree

- 路径: `.worktree/tdd-d4a-agent-isolation/`
- 分支: `feat/tdd-d4a-agent-isolation`

---
name: "tdd-d4b-broker-github"
depends_on: ["tdd-d4a-agent-isolation"]
labels: ["backend"]
worktree_root: ".worktree/tdd-d4b-broker-github/"
expected_files:
  - "src/plugin/github-broker.ts"
  - "src/plugin/broker.ts"
  - "test/plugin/github-broker.test.ts"
test_commands:
  - "npm test -- test/plugin/github-broker.test.ts"
  - "npm run typecheck"
acceptance: |-
  - [ ] Broker 是独立凭证持有者，GitHub API token 不进入 Agent 进程环境
  - [ ] Worker shell 只获得允许 feature branch push 的最小 Git 凭证
  - [ ] Reviewer 不获得任何 GitHub 写凭证
  - [ ] 所有 GitHub 写操作统一经 broker tools 执行
  - [ ] Broker 根据当前 agent/session、FlowRun 和 Task 状态授权
  - [ ] Plugin 通过受限子进程和 scrubbed env 确保 broker token 不传入 Agent shell
  - [ ] 测试覆盖：Worker 尝试 gh pr create → 被拒绝
  - [ ] 测试覆盖：Reviewer 尝试写操作 → 被拒绝
---

## 目标

实现独立 GitHub broker，将 GitHub 写凭证从 Agent 进程中完全隔离。

## 实现要点

1. **GitHub broker** (`src/plugin/github-broker.ts` 新增)
   ```typescript
   class GitHubBroker {
     constructor(config: { token: string; owner: string; repo: string })
     async createPR(params: CreatePRParams): Promise<PRResult>
     async updatePR(prNumber: number, body: string): Promise<void>
     async mergePR(prNumber: number, options: MergeOptions): Promise<MergeResult>
     async addComment(issueNumber: number, body: string): Promise<void>
   }
   ```
   - 独立持有 GitHub API token（不从环境变量读取）
   - 所有 GitHub 写操作统一经此类执行
   - 根据 agent/session/FlowRun/Task 状态授权

2. **Broker 集成** (`src/plugin/broker.ts` 扩展)
   - `FlowBroker` 集成 `GitHubBroker`
   - `executePrCreate(parentIssueNumber, taskId, params)` → 通过 GitHubBroker 执行
   - `executePrMerge(parentIssueNumber, taskId)` → 通过 GitHubBroker 执行
   - 权限检查：只能操作所属 FlowRun 的 PR

3. **凭证隔离验证**
   - 启动时验证 broker token 不泄漏到 Agent shell
   - `ps aux` + `/proc/self/environ` 检查子进程环境变量
   - 测试覆盖：Worker 尝试 `gh pr create` → broker token 不可用 → 操作被拒绝
   - 测试覆盖：Reviewer 尝试任何写操作 → 被拒绝

## 验收标准

- [ ] Broker token 隔离测试：Agent shell 中无 token
- [ ] Worker 写操作拒绝测试
- [ ] Reviewer 写操作拒绝测试
- [ ] Broker 授权逻辑测试：不同 agent/session 不同权限

## Worktree

- 路径: `.worktree/tdd-d4b-broker-github/`
- 分支: `feat/tdd-d4b-broker-github`

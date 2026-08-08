---
name: flow-review
description: 双轴审查（规范 + 规格）→ 发布审查结果 → 合并
---

# flow-review

沿两条轴线审查 PR 代码：规范（是否符合编码标准）和规格（是否实现了原始需求）。
reviewer 只读；写操作（review/merge）由 primary 编排器执行。

## 核心流程

1. **发布审查结果**（primary 执行）
   ```bash
   gh pr review <pr-number> --approve
   gh pr review <pr-number> --request-changes --body "<原因>"
   ```
2. **合并**（CI + 审查通过后，primary 执行）
   ```bash
   HEAD_SHA=$(gh pr view <pr-number> --json headRefOid --jq .headRefOid)
   gh pr merge <pr-number> --squash --delete-branch --match-head-commit "$HEAD_SHA"
   ```
3. 合并后清理 worktree：`git worktree remove ".worktree/<task-slug>"`（脏时提示用户手动处理）

reviewer 只读：不直接执行 `gh pr review` / `gh pr merge`（写操作由 primary 编排器执行）。

## 双轴审查

两条轴线独立审查、分别报告；不把发现项混排，也不允许一条轴线的通过掩盖另一条轴线的失败。

### 规格轴（Specification）

回答“是否实现了正确的行为”：

- 对照 PRD、Task `Builds`、`Acceptance Criteria` 与技术方案检查遗漏或不完整需求。
- 检查 diff 是否增加规格未要求的行为或抽象，识别 scope creep。
- 检查看似已实现但边界、错误或状态转换不符合规格的行为。
- 逐条核查 Acceptance Criteria 是否由 Design `Testing Decisions` 约定的 Test Seam 上的行为测试或验证命令证明。
- 测试存在不等于规格通过；实现与测试共同误解需求时仍应报告。

### 规范轴（Convention / Code Quality）

回答“实现是否写得正确”：

- 检查仓库文档化规范、AGENTS.md 与相关 ADR；仓库规则优先。
- 参考 `references/smell-baseline.md`，代码气味属于判断性问题，不冒充硬性规范。
- 检查 KISS、YAGNI、SRP，以及是否存在浅 Module、透传层或只有一个假设 Adapter 的 Seam。
- 检查测试是否描述行为、使用公共 Test Seam，并避免私有方法、内部调用次数/顺序、侧信道和循环论证。
- 跳过 formatter、lint、typecheck 等工具已经强制执行且没有实际风险的机械问题。

**明确不检查 commit order**：RED→GREEN 顺序是编码过程约束，reviewer 不审查 commit 历史。

### 审查结论

- 任一轴存在阻断问题 → `CHANGES_REQUESTED`。
- 两轴都没有阻断问题 → `APPROVED`。
- 报告必须分别给出每条轴线的发现数量和最高严重度，不跨轴线重新排序。

## 审查材料获取

代码审查必须在本地分支/worktree 中进行，禁止通过 WebFetch 或浏览器访问远程 PR 页面获取代码。

## Output
- 结构化审查报告（APPROVED / CHANGES_REQUESTED）
- PR 已合并（条件满足时）
- Worktree 已清理

## 后续
- **/release** — 发布（如所有 PR 已合并）

## Contract

### Trigger
由 `/review` 命令或 `@dev-lifecycle` Phase 3 审查步骤触发。

### Inputs
- PR 编号、Task 文件与 Task Record（来源：`/code` 产出）
- PRD 与技术方案（包含 Testing Decisions）

### Preconditions
- `/code` 已完成 → PR 已创建
- Design 已包含本 Task 相关行为的 Testing Decisions；存量 Design 缺失时先返回 Design Gap，不提前给出审查结论

### Procedure
1. 在本地 worktree/分支获取 PR diff 与元数据
2. 独立执行规格轴审查，核对行为、范围与 Acceptance Criteria 证据
3. 独立执行规范轴审查，核对仓库规范、实现质量与测试质量
4. 分轴输出结构化审查报告，不合并或重排发现
5. primary 用 `gh pr review` 发布结果
6. CI 通过后 primary 用 `gh pr merge` 合并并清理 worktree

### Outputs
- 结构化审查报告（APPROVED / CHANGES_REQUESTED）
- PR 已合并（条件满足时）
- Worktree 已清理

### Failure
- Critical/High → request-changes
- Testing Decisions 缺失或与仓库现实冲突 → 返回 Design Gap，由 primary 在当前 stage 完成 amendment 后重新审查
- Worktree 清理失败 → 记录警告，不阻塞

### Idempotency
- 已合并的 PR → 跳过
- 已审查的 PR → 更新结论

### Prohibited Actions
- **禁止使用 WebFetch 或任何 Web 工具获取远程 PR 代码** — 审查代码时必须本地读取源码文件
- reviewer 不直接执行 `gh pr review` / `gh pr merge`（由 primary 编排器执行）
- 不把规格轴与规范轴合并成单一问题列表或用一条轴线抵消另一条轴线
- 不使用默认 --force 清理

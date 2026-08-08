# Bug 修复（Corrective Flow）

> 归属：`docs/guides/sops/`
> 触发：已合并代码出现回归、行为不符合预期、用户报告缺陷
> 关联概念：`CONTEXT.md` 中的 **Corrective Flow（纠正流程）**、Flow Record、Worktree Lifecycle

## 场景定义

针对**已合并到默认分支的代码**出现的回归或错误，以「恢复已确认行为」为目标的轻量 Flow。它**不改变原 Flow 的完成状态**，只链接导致回归的原 Flow 作为溯源。

## 目标与不做什么

- 目标：最小改动恢复正确行为，并留下回归测试防止复发。
- 不做：不为单点 bug 走完整 `requirements → design → tasks` 链路（除非根因指向设计缺陷，见「升级通道」）。

## 标准方法论（行业通行）

借鉴业界成熟的 bug 处理与诊断纪律：

1. **Bug 分诊（Triage）**：先定严重度与优先级（P0 瘫痪 / P1 严重 / P2 一般），再决定处理路径与时效。
2. **诊断循环（对应本地 `diagnose` skill）**：
   - **建立反馈回路** → 复现 → 假设（3–5 个可证伪假设，展示给用户重排优先级）→ 插桩（一次只改一个变量）→ 修复 + 回归测试 → 清理 + 复盘。
   - 核心洞察：**先有快速、确定、可复现的失败信号，再谈修**。没有反馈回路，别急着猜。
3. **TDD 修复**：先写能复现 bug 的失败测试（RED）→ 最小修复（GREEN）→ 回归（对应 `flow-tdd`）。
4. **根因分析（RCA）与复盘**：`5 Whys` 追问「什么能阻止这个 bug」。若答案指向架构问题（无测试缝、调用链纠缠）→ 转 `improve-codebase-architecture`。
5. **回归防护**：修复必须带回归测试，且修复后重跑原始（未最小化的）复现场景确认不再复发。

## 本项目落地流程

1. **识别与分诊**：确认是回归 / 缺陷，评估严重度与影响范围。
2. **创建 Corrective Flow**：`goal({op:"create", parent_issue_number:<原 Flow Record 或新 Issue>})`；在 Issue body 记录**复现步骤、期望行为、实际行为、根因**，并链接原 Flow（不改变其完成状态）。
3. **建立反馈回路**（重用 `diagnose`）：构造最小化复现——失败测试 / 脚本 / 夹具，先确认能复现用户描述的**同一个**故障，而非邻近的其它故障。
4. **假设与验证**：生成并按优先级测试假设；一次改一个变量。
5. **修复 + 回归测试**：在独立分支 `fix/<slug>` / worktree 内，RED→GREEN 周期；回归测试锁定正确行为。
6. **审查与合并**：复用 `flow-review`（双轴：规范 + 是否确实恢复行为）；CI 绿后 `--match-head-commit` 合并。
7. **清理 + 复盘**：移除调试插桩、删除临时产物、销毁 worktree；在 commit/PR 中写明正确的根因假设，供后续排障者学习；必要时将架构问题转 `improve-codebase-architecture` 并记录建议。

## 验证与门禁

- [ ] 原始（未最小化）复现场景不再复现
- [ ] 新增回归测试通过，且修复前能复现失败（RED→GREEN 已验证）
- [ ] 全量回归（`npm test`）通过
- [ ] CI 绿 + 双轴审查通过后合并
- [ ] 调试日志/临时文件已清理（按唯一前缀 `grep` 确认）

## 产出物

- Corrective Flow Issue（含复现、根因、修复说明、原 Flow 链接）
- 回归测试 + 修复 commit
- 合并的 `fix/<slug>` PR

## 复用与新增资产

- 复用：`flow-tdd`（RED→GREEN）、`flow-code`（worktree 编码）、`flow-review`（审查合并）、goal 工具、Worktree Lifecycle。
- 新增（缺口）：`flow-corrective` skill、`/fix` 命令、`fix/<slug>` 分支约定。

## 升级通道

若根因指向设计缺陷（无测试缝、架构耦合），修复后**单独**开一个 `04-refactor` 或功能 Flow 处理结构性变更，不要混入本次 bug 修复。

## 反模式 / 注意事项

- 不修「邻近的另一个 bug」——同一反馈回路应对应同一故障。
- 没有反馈回路就猜根因。
- 修复不带回归测试（留下复发风险）。
- 用完整功能流处理单点 bug（过载）。
- 修改原 Flow 的完成历史来「追溯」——Corrective Flow 应保持原 Flow 完成状态不变。

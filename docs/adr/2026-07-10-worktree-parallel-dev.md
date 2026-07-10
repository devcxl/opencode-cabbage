# ADR 0005: Worktree 并行开发支持

**状态:** Proposed
**日期:** 2026-07-10
**上级:** [ADR 0001](/adr/0001-replace-openspec-with-full-flow)

## 背景

dev-lifecycle 全流程编排器中，Phase 3（并行编码实现）当前在每个 task 间需要切换分支，导致：
1. 无法真正并行——同一时刻只能有一个分支被检出
2. node_modules 切换时可能需要重新安装
3. 暂存区和工作区变更无法跨 task 保留

DAG 拓扑排序已识别出大量可并行执行的无依赖 task，但受限于单一工作区，并行能力无法发挥。

## 决策

### 1. 使用 `git worktree` 实现工作区隔离

**选择**：使用原生 `git worktree` 为每个 task 创建独立工作区。

**理由**：

| 方案 | 隔离性 | 创建速度 | 运维复杂度 | 是否需要额外工具 |
|------|--------|----------|-----------|-----------------|
| `git worktree` | 文件系统级 | 几乎瞬间（共享 .git） | 低 | 否 |
| Docker 容器 | 进程级 | 慢（启动开销） | 高（Dockerfile、镜像） | 是 |
| 独立 clone | 完全隔离 | 慢（fetch 全量） | 中（多仓库管理） | 否 |
| tmux 分窗 | 仅终端隔离 | 快 | 低（不隔离文件系统） | 否 |

`git worktree` 是唯一同时满足"隔离性"、"创建速度"、"零额外依赖"三个约束的方案。

**备选方案**：
- Docker：引入额外工具链，且启动开销大，不符合"最小可行方案"原则
- 独立 clone：磁盘空间浪费（每个 clone 独立 `.git`），且需要额外管理多个 `git remote`
- tmux：不提供文件系统隔离，无法实现独立 node_modules

### 2. worktree 目录约定

**决策**：统一使用 `.worktree/<task-slug>/` 作为 worktree 路径。

**理由**：
- `.worktree/` 前缀使其在文件管理器中自然聚合
- `<task-slug>` 与 task 名称一一对应，可读性强
- 已加入 `.gitignore`，不会被版本控制跟踪
- 路径固定在项目根目录，所有 skill 和 agent 无需额外配置即可定位

**备选方案**：
- `/tmp/opencode-worktree/<task-slug>/`：跨项目可能冲突，且 `/tmp` 可能在系统重启后丢失
- `worktrees/<task-slug>/`：无 `.` 前缀不易被 `.gitignore` 统一管理

### 3. worktree 与分支绑定策略

**决策**：每个 worktree 绑定独立分支 `feat/<task-slug>`，从 `main` 分支创建。

**理由**：
- 确保每个 task 的代码变更完全隔离
- 分支名与 task-slug 对应，可追溯
- 与现有 PR 流程兼容（PR 基于分支，CI 只关心分支代码）
- 合并后可直接删除分支，不污染分支列表

**约束**：`git worktree add` 不允许同一分支在多个 worktree 同时检出。并行 task 使用不同分支名，天然满足此约束。

**备选方案**：
- 所有 worktree 使用同一分支 `feat/parallel`：git 禁止，不可行
- 使用 detached HEAD：无法创建 PR，不可行

### 4. 串行 task 的 worktree 复用策略

**决策**：默认使用"清理后重建"策略（Option A）。

**流程**：
```
上一 task 合并 → git worktree remove .worktree/<old-slug> → git worktree add .worktree/<new-slug> feat/<new-slug>
```

**理由**：
- 每个 task 环境完全隔离，无残留文件
- 避免上一 task 的构建产物、未跟踪文件、node_modules 修改影响下一 task
- 实现简单，无需处理状态迁移

**备选方案**：
- Option B（直接复用）：在现有 worktree 中 `git checkout feat/<new-slug>`。优点：无需重新 `npm install`；缺点：可能残留状态。仅在依赖树几乎不变且 `npm install` 耗时过长时作为备选。

### 5. 清理策略

**决策**：PR 合并后自动执行 `git worktree remove .worktree/<task-slug> --force`，并删除对应的本地分支。

**理由**：
- 代码已合并到 main，worktree 内的变更已无保留价值
- `--force` 确保即使有未提交变更也能清理
- 自动化清理避免 `.worktree/` 目录无限增长

**触发时机**：flow-review 阶段，步骤 6（关闭关联 Sub Issue）之后。

**备选方案**：
- 手动清理：容易遗漏，导致磁盘空间浪费
- 延迟清理（保留 7 天）：增加复杂度，收益有限

### 6. 不改造 flow-design 阶段

**决策**：flow-design（技术方案 + ADR）阶段不涉及 worktree。

**理由**：
- 设计阶段只需阅读文档和输出方案，不产生代码变更
- 设计文档在主仓库内创建和提交，无需隔离
- 引入 worktree 只会增加不必要的复杂度

## 后果

### 正向

- DAG 中无依赖 task 可真正并行执行，大幅提升开发效率
- 每个 task 有独立的 node_modules、暂存区、构建产物，互不干扰
- worktree 生命周期完全自动化，无需开发者手动管理
- 对现有 PR 流程和 CI/CD 完全透明

### 风险

- `git worktree` 在某些旧版 git（< 2.5）中不可用 — 但 git 2.5 发布于 2015 年，当前环境均满足
- worktree 清理失败（如进程占用）可能残留 `.worktree/` 目录 — 通过 `--force` 和定期 `git worktree prune` 缓解
- 编排器对 worktree 路径的感知错误可能导致 agent 在错误路径编码 — 每个 agent 启动时显式验证工作目录
- 并行 worktree 可能造成磁盘 I/O 竞争 — 对于典型的前端项目影响极小

## 技术方案

详见 [Worktree 并行开发支持 — 技术方案](/dev/specs/worktree-parallel-dev)
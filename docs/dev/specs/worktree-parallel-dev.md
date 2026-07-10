# Worktree 并行开发支持 — 技术方案

## 概述

为 dev-lifecycle 全流程添加 git worktree 支持，使 DAG 中无依赖关系的 task 可以同时在独立 worktree 中并行开发，互不干扰。每个 worktree 绑定独立分支、独立 node_modules、独立暂存区，PR 合并后自动清理。

## 1. 技术选型

### 1.1 方案选择

| 方案 | 隔离性 | 性能 | 复杂度 | 结论 |
|------|--------|------|--------|------|
| 原生 `git worktree` | 文件系统级别隔离 | 极快（共享 .git 对象） | 低，仅需 git 命令 | ✅ |
| Docker 容器 | 进程级别隔离 | 慢（启动开销） | 高，需 Dockerfile | ❌ |
| 独立 clone | 完全隔离 | 慢（重复 fetch） | 中，需管理多仓库 | ❌ |
| tmux/screen 分窗 | 仅终端隔离 | — | 中，无法隔离文件系统 | ❌ |

**决策**：使用原生 `git worktree`。优势：
- 共享 `.git` 对象存储，创建速度快（几乎瞬间）
- 文件系统级别隔离，每个 worktree 有独立的 node_modules、暂存区
- 无需额外工具或依赖，所有系统自带 git 支持
- 命令简单，易于集成到 skill 脚本中

### 1.2 配置约定

| 配置项 | 值 | 说明 |
|--------|-----|------|
| worktree 根目录 | `.worktree/` | 项目根目录下，已加入 `.gitignore` |
| worktree 路径 | `.worktree/<task-slug>/` | 每个 task 独立子目录 |
| 分支命名 | `feat/<task-slug>` | 与 worktree 一一绑定 |
| 基础分支 | `main` | 所有 worktree 从 main 分支创建 |

### 1.3 `.gitignore` 验证

`.gitignore` 已包含 `.worktree/`，无需修改。

## 2. 架构与数据流

### 2.1 整体架构

```
                         ┌─────────────────────────────────────┐
                         │         dev-lifecycle 编排器          │
                         │                                     │
                         │  Phase 3: 按 DAG batch 并行派发       │
                         │  ┌──────────┐  ┌──────────┐         │
                         │  │ batch 1  │  │ batch 2  │  ...    │
                         │  │ 3 tasks  │  │ 2 tasks  │         │
                         │  └──────────┘  └──────────┘         │
                         └───────┬──────────────┬──────────────┘
                                 │              │
                    ┌────────────┼──────────────┼──────────────┐
                    │            ▼              ▼              │
                    │  ┌─────────────────┐  ┌─────────────────┐│
                    │  │ .worktree/      │  │ .worktree/      ││
                    │  │ task-login/     │  │ task-profile/   ││
                    │  │                 │  │                 ││
                    │  │ feat/task-login │  │ feat/task-      ││
                    │  │                 │  │ profile         ││
                    │  │ node_modules/   │  │ node_modules/   ││
                    │  │ src/            │  │ src/            ││
                    │  │ tests/          │  │ tests/          ││
                    │  └─────────────────┘  └─────────────────┘│
                    │                                          │
                    │       主仓库 (.git)  — 共享对象存储        │
                    └──────────────────────────────────────────┘
```

### 2.2 数据流：各阶段集成点

#### A. flow-tasks 阶段（轻量改造）

**触发时机**：`/tasks` 命令执行时，创建 task 文件后。

**改造点**：

1. **task frontmatter 新增字段**：
```yaml
---
name: "task-login"
depends_on: []
labels: ["backend"]
worktree_root: ".worktree/task-login/"
---
```

2. **task body 新增 worktree 声明**：
```markdown
## Worktree

- **路径**: `.worktree/task-login/`
- **分支**: `feat/task-login`
- **创建时机**: `/code` 阶段首次执行时自动创建
- **清理时机**: PR 合并后自动删除
```

3. **Sub Issue body 新增 worktree 声明**：
```markdown
## 依赖
前置任务: 无

## Worktree
- 路径: `.worktree/task-login/`
- 分支: `feat/task-login`

## 描述
...
```

#### B. flow-code 阶段（核心改造）

**触发时机**：`/code` 命令执行时。

**改造前流程**：
```
git checkout -b feat/<task-slug>  →  编码  →  npm test  →  git commit  →  gh pr create
```

**改造后流程**：
```
Step 1: 检查 worktree 是否存在
  ├─ 存在 → 跳过创建，直接进入 Step 3
  └─ 不存在 → Step 2

Step 2: 创建 worktree
  git worktree add .worktree/<task-slug> feat/<task-slug>

Step 3: 安装依赖（在 worktree 内）
  cd .worktree/<task-slug>
  npm install

Step 4: 编码 + 单测（在 worktree 内）
  # 实现代码 + 单元测试
  npm test

Step 5: 提交 + 推送 + 创建 PR（在 worktree 内）
  git add .
  git commit -m "feat(<scope>): <title>"
  git push origin feat/<task-slug>
  gh pr create --title "<title>" --body-file docs/dev/handoff/pr-body.md

Step 6: 文档同步检查（原有步骤，不变）
```

**关键约束**：
- 所有操作（编码、单测、git commit、git push）均在 worktree 路径内执行
- `git push` 从 worktree 内推送与主仓库行为完全一致
- worktree 内的 `npm install` 安装独立 node_modules，不影响主仓库
- 如果 worktree 已存在（如串行 task 复用），跳过创建步骤

**flow-code SKILL.md 改造内容**：

```markdown
## Prerequisites
- `/tasks` 已完成 → Sub Issues 就绪
- 阅读 `docs/adr/` 确保实现与 ADR 兼容
- 确认 task 的 `worktree_root` 字段（来自 task 文件 frontmatter）

## Workflow

### 1. 选择任务
选择一个可执行的 Sub Issue（前置依赖已满足）。

### 2. 检查 ADR 约束
阅读相关 ADR，确保实现方案不违反已有架构决策。

### 3. 创建/复用 Worktree
```bash
# 检查 worktree 是否已存在
if [ ! -d ".worktree/<task-slug>" ]; then
  git worktree add .worktree/<task-slug> feat/<task-slug>
fi

# 进入 worktree
cd .worktree/<task-slug>
```

### 4. 安装依赖
```bash
npm install
```

### 5. 编码 + 单测 → PR
```bash
# 实现代码 + 单元测试
npm test
git add .
git commit -m "feat(<scope>): <title>"
git push origin feat/<task-slug>
mkdir -p docs/dev/handoff
echo "Closes #<issue-num>" > docs/dev/handoff/pr-body.md
gh pr create --title "<title>" --body-file docs/dev/handoff/pr-body.md
```

### 6. 文档同步检查
...
```

#### C. flow-review 阶段（轻量改造）

**触发时机**：`/review` 命令执行时。

**核心原则**：审查只关心 PR diff，worktree 对审查透明。

**改造点**：

1. **审查流程不变**：`gh pr diff` / `gh pr view` 不感知 worktree
2. **新增合并后清理步骤**（在步骤 6 "关闭关联 Sub Issue" 之后）：

```markdown
### 7. 清理 Worktree
PR 合并后，清理对应的 worktree 和分支：

```bash
# 从主仓库执行
git worktree remove .worktree/<task-slug> --force
git branch -D feat/<task-slug>   # 如远程已合并，本地分支可删除
```
```

**清理时机**：PR 合并后立即执行。`--force` 确保即使 worktree 有未提交变更也能清理（因为代码已合并到 main，worktree 内的变更已无意义）。

#### D. dev-lifecycle 编排器 Phase 3 改造（核心改造）

**改造前逻辑**：
```
Phase 3: 按 DAG 拓扑排序逐 batch 处理
  1. 创建分支
  2. 派发 @backend/@frontend
  3. 创建 PR
  4. 审查合并
```

**改造后逻辑**：
```
Phase 3: 按 DAG 拓扑排序逐 batch 处理

For each batch:
  For each task in batch (可并行):
    1. 检查 worktree 是否存在
       - 不存在 → git worktree add .worktree/<task-slug> feat/<task-slug>
       - 存在（串行复用）→ 跳过
    2. 并行派发 agent 到各 worktree 路径
    3. 每个 agent 在 worktree 内:
       - npm install（如未安装）
       - 编码 + 单测
       - 提交 + push + 创建 PR
    4. 等待 batch 内所有 task 完成
    5. 委派 @reviewer 审查各 PR
    6. CI 通过后自动合并
    7. 合并后清理 worktree

For 串行 task（有依赖关系）:
  - Option A: 清理后重建（推荐）
    上一 task 合并后 → git worktree remove → git worktree add 新 task
    优点：干净隔离，无残留
    缺点：需要重新 npm install

  - Option B: 直接复用
    上一 task 合并后 → 在现有 worktree 中 git checkout feat/<新task>
    优点：无需重新 npm install（如依赖不变）
    缺点：可能残留上 task 的构建产物和未跟踪文件

  **决策：默认使用 Option A（清理后重建）**，确保每个 task 环境完全隔离。
  如果 task 间共享大量依赖且 npm install 耗时过大，可手动选择 Option B。
```

**约束处理**：

`git worktree add` 约束：同一分支不能在多个 worktree 同时检出。
- 串行 task 不存在此问题（前 task 完成后才创建下一个）
- 并行 task 使用不同分支（`feat/<task-slug>` 各不相同），不会冲突
- 如果意外冲突 → 编排器暂停，提示用户手动清理

## 3. 依赖图（DAG 建议）

建议拆解为以下 6 个 task：

```
worktree-gitignore ─────────────────────────────────────────────────────────────┐
     │                                                                          │
     ├──► worktree-flow-code ──────► worktree-dev-lifecycle                     │
     │         │                          │                                     │
     │         ├──► worktree-flow-review  │                                     │
     │         │                          │                                     │
     │         └──► worktree-flow-code-serial ──────────────────────────────────┘
     │
     └──► worktree-flow-tasks ──────────────────────────────────────────────────┘
```

### 3.1 Task 详情

| # | Task | 优先级 | 依赖 | 说明 |
|---|------|--------|------|------|
| 1 | worktree-gitignore | P2 | 无 | 验证 `.gitignore` 已有 `.worktree/`（实际已完成，仅需确认） |
| 2 | worktree-flow-tasks | P1 | 无 | 改造 flow-tasks 技能：task frontmatter 新增 `worktree_root`，body 和 Sub Issue body 新增 worktree 声明 |
| 3 | worktree-flow-code | P0 | worktree-gitignore | 改造 flow-code 技能：worktree 创建/复用、worktree 内编码+单测+PR |
| 4 | worktree-dev-lifecycle | P0 | worktree-flow-code, worktree-flow-tasks | 改造 dev-lifecycle 编排器 Phase 3：batch 并行创建 worktree、派发 agent、合并后清理 |
| 5 | worktree-flow-review | P1 | worktree-flow-code | 改造 flow-review 技能：合并后自动 `git worktree remove` |
| 6 | worktree-flow-code-serial | P1 | worktree-flow-code | flow-code 支持串行 task worktree 复用（Option A 清理后重建） |

## 4. 已有 ADR 兼容性检查

### 4.1 ADR 0001（全流程架构）

**结论**：完全兼容，无需修改。

- 本次改造不改变全流程架构（Phase 1→2→3→4）
- 仅增强 Phase 3 的并行能力，将"创建分支"改为"创建 worktree"
- 不影响其它 Phase 的输入输出

### 4.2 ADR 0004（任务目录组织）

**结论**：兼容，需扩展 task frontmatter。

- task 文件格式不变（frontmatter + body），仅新增 `worktree_root` 字段
- task 文件命名和目录结构不变
- 不影响 `docs/dev/changelog/` 的设计态/实现态分离

### 4.3 不改造 flow-design 阶段

**结论**：设计方案不涉及 worktree，设计阶段在主仓库内完成即可。

## 5. 实施计划

### 5.1 子任务拆分及执行顺序

| 步骤 | Task | 验收标准 | 预估影响文件 |
|------|------|----------|-------------|
| 1 | worktree-gitignore | `.gitignore` 包含 `.worktree/`，`git status` 不显示 `.worktree/` 内容 | 验证 `.gitignore`（已完成） |
| 2 | worktree-flow-tasks | task 文件包含 `worktree_root` frontmatter + body 声明；Sub Issue body 包含 worktree 声明 | `skills/flow-tasks/SKILL.md` |
| 3 | worktree-flow-code | 在 worktree 内完成编码→单测→PR 全流程；`npm test` 在 worktree 内通过 | `skills/flow-code/SKILL.md` |
| 4 | worktree-flow-review | PR 合并后 `git worktree remove` 成功执行，worktree 目录被删除 | `skills/flow-review/SKILL.md` |
| 5 | worktree-flow-code-serial | 串行 2 个 task 时，第二个 task 的 worktree 从干净状态创建 | `skills/flow-code/SKILL.md`（同文件） |
| 6 | worktree-dev-lifecycle | DAG batch 中 3 个 task 同时创建 3 个 worktree；合并后全部清理 | `assets/agents/dev-lifecycle.md` |

### 5.2 风险点及对策

| 风险 | 影响 | 对策 |
|------|------|------|
| `git worktree add` 因分支已存在但未合并而失败 | 阻塞 worktree 创建 | 检查分支是否已存在且未合并 → 提示用户手动处理或 `--force` 创建 |
| worktree 内 `npm install` 失败（网络/依赖问题） | 阻塞编码 | 捕获错误，回退到主仓库 `npm install` 后复制 node_modules |
| worktree 清理失败（进程占用、未提交变更） | 残留 worktree 目录 | 使用 `--force` 强制删除；`git worktree prune` 定期清理 |
| 多个 worktree 并行时主仓库 `.git` 锁冲突 | 操作失败 | 原生 git worktree 已处理此问题（共享对象存储无锁冲突）；如遇罕见冲突，等待后重试 |
| 编排器对 worktree 路径的感知不正确 | agent 在错误路径下编码 | 每个 agent 启动时显式 `cd .worktree/<task-slug>` 并验证 `pwd` |

## 6. 技术选型与约束

### 6.1 技术栈

- **git worktree**：原生 git 命令，无额外依赖
- **Node.js**：与项目现有约束一致（>= 18）
- **npm**：在 worktree 内独立执行 `npm install`

### 6.2 关键约束

- worktree 路径统一为 `.worktree/<task-slug>/`，硬编码不可配置
- 分支命名统一为 `feat/<task-slug>`，不可变更
- 基础分支固定为 `main`
- worktree 生命周期由 skill 自动管理，不支持手动创建/清理
- 每个 worktree 完全独立，无共享状态

### 6.3 安全考虑

- `.worktree/` 已加入 `.gitignore`，不会被版本控制跟踪
- worktree 内的 `node_modules` 独立，不会污染主仓库
- worktree 清理后不留任何残留文件
- `git worktree remove --force` 仅在确认 PR 已合并后执行
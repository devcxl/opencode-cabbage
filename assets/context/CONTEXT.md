# opencode-cabbage Context

## 领域术语

**Flow（流程）：**
从需求到发布的完整开发阶段序列。一个 Flow 包含多个 Stage。

**Stage（阶段）：**
Flow 中的一个步骤，由一个 slash command 触发。每个 Stage 产生一个或多个 Artifact。

**Artifact（产物）：**
Stage 产出的文档——PRD、ADR、Task、设计文档等。存放在 `docs/` 下的对应子目录中。

**Issue Tree（问题树）：**
由 Parent Issue 和 Sub Issues 组成的层级结构。Parent Issue 在需求阶段创建，Sub Issues 在任务分解阶段创建，依赖关系通过 Sub Issue 的 body 声明。

**GitHub Canonical Source（GitHub 权威源）：**
所有工程状态以 GitHub 为准。Issues、PRs、CI checks、Releases 都在 GitHub 上管理，本地文档是辅助引用。

**Setup（初始化）：**
首次使用前的准备流程。检测 gh CLI、配置 GitHub 仓库、创建 docs/ 目录。

**Handoff（交接）：**
当上下文窗口压力过大或需要跨阶段传递进度时，将当前状态打包为 markdown 文件，在下一次交互时读取恢复。

## 术语关系

- 一个 **Flow** 包含多个有序 **Stage**
- 每个 **Stage** 产生一个或多个 **Artifact**
- **Artifact** 存储在 `docs/` 下的 **prd/**、**adr/**、**dev/** 等子目录
- **Issue Tree** 是跨 Stage 的线索：Parent Issue → Sub Issues（含依赖关系）
- 所有 **Stage** 可能引用 GitHub 上的 **Canonical Source**
- **Setup** 必须在第一个 Flow 之前运行（或由 AI 在第一次使用时引导）
- **Handoff** 可在任意 Stage 之间使用

## 避免使用的术语

- **Ticket** — 统一用 **Issue**
- **Backlog** — 避免歧义，直接指定 Issue 或 Issue list
- **Sprint** / **Epic** — 不使用，用 **Issue Tree** 层级替代

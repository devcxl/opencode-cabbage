---
name: flow-setup
description: 初始化 — 探测环境 → 确认 Profile
---

# flow-setup

初始化阶段：探测开发环境、确认 AGENTS.md Project Profile。
纯 Prompt 流程：直接使用 git/gh 命令探测，Profile 由用户确认后写入根 AGENTS.md。

## 核心流程

1. **探测环境**
   ```bash
   gh auth status                        # gh CLI 认证
   gh repo view --json nameWithOwner,defaultBranchRef  # 仓库与默认分支
   ls .github/workflows/                 # 现有 CI/release workflow
   ```

2. **确认 Project Profile**：向用户逐项确认以下配置（技术栈无关）：
   - test command：测试命令（如 `npm test`）
   - regression command：全量回归命令
   - test file patterns：测试文件匹配（如 `test/**/*.test.ts`）
   - implementation file patterns：实现文件匹配（如 `src/**/*.ts`）
   - version bump rule、version file、tag format、release workflow

3. **写入根 AGENTS.md**：用户确认后，将 Profile 区块追加/替换到根 `AGENTS.md`：

```markdown
## Project Profile

- test command: `npm test`
- regression command: `npm test`
- test file patterns: `test/**/*.test.ts`
- implementation file patterns: `src/**/*.ts`
- version bump rule: `breaking→major, feature→minor, fix→patch`
- version file: `package.json`
- tag format: `v{version}`
- release workflow: `.github/workflows/release.yml`
```

## 存量项目接入（adopt）

仓库已有文档时（`init` 只新增骨架、不改写已有文件；无 `.cabbage/` 时先经 flow-change 执行 `op:"init"`）：

1. `cabbage({op:"adopt"})` 盘点 `docs/` 树之外的 Markdown → 生成 `.cabbage/` 下的 `adoption-report.md`；
   每份文档得到四种动作：`keep`（已在编号目录）/ `migrate`（当前状态文档）/ `import`（历史记录）/
   `review`（无法归类）。分类仅基于目录与文件名推断，**始终需要人工确认**。
2. 逐行处理 `review`，与文档负责人确认归属；`import` 的历史记录（ADR/RFC/事故）原样归档，
   **不改写内容**。
3. `migrate` 用 `git mv` 保留历史，一个逻辑批次一个提交；移动后立即修正相对链接。
4. 每批后 `cabbage({op:"validate"})` + 站点构建，确认无死链。
5. 接入完成的判据：再次 `op:"adopt"` 应全部报告 `keep`。

## Output
- readiness 报告（git/gh 可用性、CI/release workflow 存在性）
- 根 AGENTS.md `## Project Profile` 区块

## Contract

### Trigger
由 `/setup` 命令触发。首次使用插件或切换新项目时执行。

### Inputs
- 用户对 readiness 报告 / Profile 覆盖项的确认

### Preconditions
- gh CLI 已认证（宿主 `gh auth`）

### Procedure
1. 用 gh/git 命令探测环境，输出 readiness 报告
2. 缺失 CI/release workflow 时提示用户（可手工创建）
3. 向用户逐项确认 Profile 配置
4. 用户确认后写入根 AGENTS.md Profile 区块

### Outputs
- readiness 报告
- 根 AGENTS.md Profile 区块

### Failure
- gh auth 失败 → 提示用户执行 `gh auth login` 后重试

### Idempotency
- Profile 已存在 → 覆盖为最新确认值

### Prohibited Actions
- 不写入未获用户确认的 Profile 项
- 不假设测试命令为 npm（按用户确认的技术栈）

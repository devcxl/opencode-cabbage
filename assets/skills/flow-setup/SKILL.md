---
name: flow-setup
description: 初始化 — 探测环境 → 生成 workflow → 确认 Profile
---

# flow-setup

初始化阶段：探测开发环境、生成缺失的 CI/release workflow、确认 AGENTS.md Project Profile。
所有探测与写入由内核工具 `setup_control` 完成，本 skill 只定义流程，不复制工具实现。

## 核心：调用 setup_control

调用 `setup_control` 完成三个阶段：

1. `setup_control{op:"probe"}` — 探测 git/gh/CI/Profile，输出 readiness 报告
2. `setup_control{op:"generate-workflows"}` — 缺失时生成 CI/release workflow 草案 + Setup PR（人工合入）
3. `setup_control{op:"confirm-profile"}` — 用户确认后将 Profile 区块写入根 AGENTS.md

Profile 区块格式（内核解析白名单，§9.1）：

```markdown
## Project Profile

- test command: `npm test -- run`
- test file patterns: `test/**/*.test.ts`
- implementation file patterns: `src/**/*.ts`
- tdd default mode: `strict`
- version bump rule: `breaking→major, feature→minor, fix→patch`
- version file: `package.json`
- tag format: `v{version}`
- release workflow: `.github/workflows/release.yml`
```

未确认 Profile 时 `flow_control{op:"create-flow"}` 会阻断并提示先执行 `/setup`。

## Output
- readiness 报告（development-ready / release-ready 逐项布尔）
- `.github/workflows/` 草案（缺失时，经 Setup PR 人工合入）
- 根 AGENTS.md `## Project Profile` 区块

## Contract

### Trigger
由 `/setup` 命令触发。首次使用插件或切换新项目时执行。

### Inputs
- 用户对 readiness 报告 / Profile 覆盖项的确认

### Preconditions
- gh CLI 已认证（宿主 `gh auth`）

### Procedure
1. 调用 `setup_control{op:"probe"}` 读取 readiness 报告
2. 缺失 workflow 时调用 `setup_control{op:"generate-workflows"}` 生成草案
3. 用户确认后调用 `setup_control{op:"confirm-profile"}` 写入 Profile

### Outputs
- readiness 报告
- workflow 草案（可选）
- 根 AGENTS.md Profile 区块

### Failure
- gh auth 失败 → 提示用户执行 `gh auth login` 后重试
- workflow 生成失败 → 报告错误并停止

### Idempotency
- Profile 已确认 → 重复 confirm 覆盖写入（工具内读后写）
- workflow 已存在 → 跳过生成

### Prohibited Actions
- 不手工编辑 AGENTS.md Profile 区块（由 setup_control 写回）
- 不直接 push 或创建 Setup PR（工具内部执行）

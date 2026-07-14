---
name: flow-test
description: 触发 CI → 监控 → 测试结果汇报
---

# flow-test

触发 CI 运行 E2E 测试，监控结果并汇报。

## Prerequisites
- PR 已创建

## Workflow

### 1. 确认 CI 配置
检查 `.github/workflows/`。如缺失，引导用户创建：

```yaml
name: E2E
on: [pull_request]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: npm ci
      - run: npm run test:e2e
```

### 2. 触发并监控
```bash
gh pr checks <pr-number> --watch
```

### 3. 结果汇报
- **全部通过** ✅ → 继续
- **失败** ❌ → 分析原因，建议修复
- **超时/异常** ⚠️ → 检查 CI 配置

## Output
- CI 结果汇报给用户

## 后续
- **/review** — 审查 PR

## Contract

### Trigger
由 `/test` 命令触发。在已创建的 PR 上运行 CI 测试。

### Inputs
- PR 编号（来源：`/code` 产出）

### Preconditions
- `/code` 已完成 → PR 已创建

### Procedure
1. 检查 CI 配置是否存在
2. 触发 CI 运行
3. 监控运行状态
4. 汇报结果

### Outputs
- CI 运行结果摘要

### Failure
- CI 失败 → 分析日志并建议修复
- 无 CI 配置 → 引导用户创建 .github/workflows/ci.yml

### Idempotency
- 重复触发同一 PR → 覆盖前一次运行

### Prohibited Actions
- 不修改 CI 配置
- 不触发非当前 PR 的 CI

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

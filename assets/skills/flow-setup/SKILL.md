---
name: flow-setup
description: 初始化项目文档结构，验证开发环境
---

# flow-setup

初始化项目文档结构，验证开发环境。

## Workflow

### 1. 创建文档目录
确保以下目录结构存在：
```
docs/
├── prd/              # 产品需求文档
├── adr/              # 架构决策记录
└── dev/
    ├── specs/        # 技术方案
    ├── tasks/        # DAG 任务定义
    ├── api/          # API 设计文档
    ├── db/           # 数据库设计
    ├── guides/       # 开发指南
    └── handoff/      # 上下文交接
```

### 2. 验证环境
```bash
gh auth status
git remote get-url origin
```
确保 gh CLI 已认证、项目已关联 GitHub 远程。

### 3. 完成标记
```bash
mkdir -p .opencode/opencode-cabbage
echo "setup-complete" > .opencode/opencode-cabbage/setup-complete
```

## Output
- `docs/` 目录已就绪
- 开发环境已验证
- 可开始 `/requirements`

## Contract

### Trigger
由 `/setup` 命令触发。首次使用插件或切换新项目时执行。

### Inputs
无外部输入。从当前工作目录检测项目状态。

### Preconditions
无。不要求任何前置阶段。

### Procedure
1. 创建 docs 目录结构
2. 验证 gh CLI 和 GitHub 远程
3. 写入完成标记

### Outputs
- `docs/` 目录树（prd, adr, dev/specs, dev/tasks, dev/api, dev/db, dev/guides, dev/handoff）
- `.opencode/opencode-cabbage/setup-complete` 标记文件

### Failure
- 目录创建失败 → 报告错误并退出
- gh auth 失败 → 提示用户执行 `gh auth login`

### Idempotency
- 已存在的目录跳过
- 已存在 `setup-complete` 标记则跳过全部步骤

### Prohibited Actions
- 不删除已有目录或文件
- 不修改项目代码

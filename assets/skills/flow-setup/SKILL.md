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

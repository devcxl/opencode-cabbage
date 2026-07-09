---
title: "文档同步流程与任务目录重构 — DAG"
status: "pending"
parent: "https://github.com/devcxl/opencode-cabbage/issues/25"
---

## DAG 拓扑

```mermaid
graph TD
  A["A. 目录重组"] --> B["B. getSidebar 适配"]
  C["C. changelog 创建"]
  D["D. flow-code 更新"]
  E["E. flow-review 更新"]
```

## 任务列表

| 批次 | 任务 | 依赖 | 可并行 |
|------|------|------|--------|
| Batch 1 | A. 目录重组 | 无 | ✓ |
| Batch 1 | C. changelog 创建 | 无 | ✓ |
| Batch 1 | D. flow-code 更新 | 无 | ✓ |
| Batch 1 | E. flow-review 更新 | 无 | ✓ |
| Batch 2 | B. getSidebar 适配 | A | — |

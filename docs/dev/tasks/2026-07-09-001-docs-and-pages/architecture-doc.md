---
name: "编写架构概览"
depends_on: []
labels: ["docs"]
---

## 目标

编写插件架构文档，帮助开发者理解设计。

## 实现要点

- 三层架构图（基础设施/加载器/FlowRun 引擎）
- 核心概念（Goal、FlowRun、Stage、Task）
- 事件驱动机制
- 弹性设计（continuation、重试、恢复、背压）
- 安全性设计

## 验收标准

- [x] docs/guides/architecture.md 已创建
- [x] 包含架构图、核心概念、事件、弹性、安全

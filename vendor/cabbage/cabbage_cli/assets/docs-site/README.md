---
layout: home

hero:
  name: "Cabbage Documentation"
  text: "面向 AI Agent / 软件团队的项目文档管理系统"
  tagline: "小变更一份记录，高风险才增加专项文档"
  actions:
    - theme: brand
      text: 工作流概览
      link: '#工作流全景'

features:
  - title: 工作流门禁 (Workflow Gates)
    details: 普通功能、修复和重构只需一份记录；高风险影响按需增加专项文档及实现前门禁。
  - title: 签名校验与防腐化 (Anti-Rot)
    details: 上游文档或影响范围变更后，下游阶段自动失效（stale），拒绝未完成的占位符。
  - title: 自动化同步与归档 (Sync & Archive)
    details: 归档保留变更记录；按映射复制专项文档，不自动整合当前事实。
---

## 工作流全景

```mermaid
flowchart LR
    Change[填写目标与方案] --> Risk[按风险增加专项材料]
    Risk --> Gate[检查实现前门禁]
    Gate --> Implement[实现并记录实际验证]
    Implement --> CI[验证记录与合并门禁]
    CI --> Archive[确认合并后归档]
```
